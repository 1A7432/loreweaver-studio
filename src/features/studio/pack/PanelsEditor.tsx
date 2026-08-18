// The panels step's editor: forms instead of a YAML box, and a way to draft the
// whole thing from a sentence.
//
// `ui/panels.yaml` stays the source of truth on disk — this edits a parsed model and
// writes the file back, so a hand-written panels file opens here and an edited one
// still reads as ordinary YAML. The YAML tab is always there for the author who
// prefers it (and for anything this editor does not model, which it carries through
// untouched rather than eating).
//
// Every form field comes from `BLOCK_FIELDS`: there is no per-block-kind UI code, so
// a new block kind reaches this editor by adding a row to that table.

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { LintVariable } from "../lint/model"
import { useActivePreset } from "../ai/presetStore"
import { aiReady, draftWithRetries, useAiStore } from "../ai/provider"
import { assembleSystemPrompt, toLlmSampling } from "../ai/stPreset"
import { gatePanelsDraft, panelsSystemPrompt } from "./panelsAi"
import {
  BLOCK_KINDS,
  LEAF_PARTS,
  PANEL_AUDIENCES,
  PANEL_SLOTS,
  type BlockDraft,
  type ChoiceOptionDraft,
  type FieldSpec,
  type FieldValue,
  type LeafPart,
  type Localized,
  type LocalizedField,
  type PanelDraft,
  type PanelsDocument,
  emptyFieldValue,
  emptyLocalized,
  fieldMayBind,
  fieldsFor,
  isLocalized,
  isOpaqueBlock,
  isOptions,
  literal,
  newBlock,
  newOption,
  newPanel,
  nextUid,
  parsePanelsYaml,
  problemsFor,
  serializePanelsYaml,
} from "./panelsModel"

interface Props {
  yamlText: string
  onChange: (yamlText: string) => void
  /** The pack's own declared variables — the closed set a binding may name. */
  variables: LintVariable[]
}

const EMPTY_DOC: PanelsDocument = { panels: [], opaque: [] }

/** ONE control for every localized-or-scalar field. The three sources such a field
 * may have — text an author types, a live variable binding, and (inside a `repeat`)
 * the current instance's own leaf — are the schema's, not the editor's, so offering
 * them uniformly is what keeps a hand-written panels file editable here without
 * loss. Which sources are OFFERED follows the schema too: a `path` or `enum` field is
 * a plain string to the engine (no binding), and `$leaf` exists only inside a repeat. */
function FieldInput({
  label,
  spec,
  value,
  onChange,
  variables,
  inRepeat,
}: {
  label: string
  spec: FieldSpec
  value: LocalizedField
  onChange: (next: LocalizedField) => void
  variables: LintVariable[]
  inRepeat: boolean
}) {
  const { t } = useTranslation()
  const localized = spec.type === "localized"
  const mode = isLocalized(value) ? "text" : value.mode
  const Field = spec.name === "body" ? "textarea" : "input"
  const mayBind = fieldMayBind(spec.type)

  const setMode = (next: string) => {
    if (next === "var") onChange({ mode: "var", path: "" })
    else if (next === "leaf") onChange({ mode: "leaf", leaf: "value" })
    else onChange(localized ? emptyLocalized() : literal(""))
  }

  return (
    <div className="panel-field">
      <span className="panel-field-name">{label}</span>
      {mayBind ? (
        <select
          aria-label={t("studio.panels.field.mode", { field: label })}
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value={localized ? "text" : "literal"}>
            {localized ? t("studio.panels.field.text") : t("studio.panels.field.literal")}
          </option>
          <option value="var">{t("studio.panels.field.binding")}</option>
          {inRepeat ? <option value="leaf">{t("studio.panels.field.leaf")}</option> : null}
        </select>
      ) : null}
      {isLocalized(value) ? (
        localized ? (
          <>
            <Field
              aria-label={`${label} en`}
              value={value.en}
              onChange={(e: { target: { value: string } }) => onChange({ ...value, en: e.target.value })}
              placeholder="en"
            />
            <Field
              aria-label={`${label} zh`}
              value={value.zh}
              onChange={(e: { target: { value: string } }) => onChange({ ...value, zh: e.target.value })}
              placeholder="zh"
            />
          </>
        ) : null
      ) : value.mode === "literal" ? (
        spec.type === "enum" ? (
          <select aria-label={label} value={value.text} onChange={(e) => onChange(literal(e.target.value))}>
            <option value="">—</option>
            {(spec.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label={label}
            value={value.text}
            onChange={(e) => onChange(literal(e.target.value))}
            placeholder={spec.type === "path" ? "assets/map.png" : undefined}
            spellCheck={spec.type === "path" ? false : undefined}
          />
        )
      ) : value.mode === "leaf" ? (
        <select
          aria-label={label}
          value={value.leaf}
          onChange={(e) => onChange({ mode: "leaf", leaf: e.target.value as LeafPart })}
        >
          {LEAF_PARTS.map((part) => (
            <option key={part} value={part}>
              {part}
            </option>
          ))}
        </select>
      ) : variables.length > 0 ? (
        <select
          aria-label={label}
          value={value.path}
          onChange={(e) => onChange({ mode: "var", path: e.target.value })}
        >
          <option value="">—</option>
          {variables.map((variable) => (
            <option key={variable.id} value={variable.id}>
              {variable.id}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={label}
          value={value.path}
          onChange={(e) => onChange({ mode: "var", path: e.target.value })}
          placeholder={t("studio.panels.field.noVariables")}
        />
      )}
    </div>
  )
}

/** The option list of a `choices` block: each row is what the client shows and the
 * input it sends when picked. The label is an ordinary localized field. */
function OptionsInput({
  label,
  options,
  onChange,
  variables,
  inRepeat,
}: {
  label: string
  options: ChoiceOptionDraft[]
  onChange: (next: ChoiceOptionDraft[]) => void
  variables: LintVariable[]
  inRepeat: boolean
}) {
  const { t } = useTranslation()
  const set = (index: number, next: ChoiceOptionDraft) =>
    onChange(options.map((option, i) => (i === index ? next : option)))
  return (
    <div className="panel-options">
      <span className="panel-field-name">{label}</span>
      <ul className="panel-option-list">
        {options.map((option, index) => (
          <li key={option.uid} className="panel-option">
            <div className="panel-field">
              <span className="panel-field-name">{t("studio.panels.field.optionId")}</span>
              <input
                aria-label={`${t("studio.panels.field.optionId")} ${index + 1}`}
                value={option.id}
                onChange={(e) => set(index, { ...option, id: e.target.value })}
                spellCheck={false}
              />
              <span className="panel-field-name">{t("studio.panels.field.input")}</span>
              <input
                aria-label={`${t("studio.panels.field.input")} ${index + 1}`}
                value={option.input}
                onChange={(e) => set(index, { ...option, input: e.target.value })}
                placeholder={t("studio.panels.field.inputPlaceholder")}
              />
              <button
                type="button"
                className="ghost-button"
                onClick={() => onChange(options.filter((_, i) => i !== index))}
                aria-label={t("studio.panels.removeOption")}
              >
                ✕
              </button>
            </div>
            <FieldInput
              spec={{ name: "label", type: "localized", required: true }}
              label={`${t("studio.panels.field.label")} ${index + 1}`}
              value={option.label}
              onChange={(next) => set(index, { ...option, label: next })}
              variables={variables}
              inRepeat={inRepeat}
            />
          </li>
        ))}
      </ul>
      <button type="button" className="ghost-button" onClick={() => onChange([...options, newOption()])}>
        {t("studio.panels.addOption")}
      </button>
    </div>
  )
}

/** A panel TITLE: text only, because the schema forbids a binding there. */
function TitleInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: Localized
  onChange: (next: Localized) => void
}) {
  return (
    <div className="panel-field">
      <span className="panel-field-name">{label}</span>
      <input
        aria-label={`${label} en`}
        value={value.en}
        onChange={(e) => onChange({ ...value, en: e.target.value })}
        placeholder="en"
      />
      <input
        aria-label={`${label} zh`}
        value={value.zh}
        onChange={(e) => onChange({ ...value, zh: e.target.value })}
        placeholder="zh"
      />
    </div>
  )
}

function BlockCard({
  block,
  variables,
  onChange,
  onRemove,
  onMove,
}: {
  block: BlockDraft
  variables: LintVariable[]
  onChange: (next: BlockDraft) => void
  onRemove: () => void
  onMove: (delta: number) => void
}) {
  const { t } = useTranslation()
  const fields = fieldsFor(block.kind) ?? []
  const opaque = isOpaqueBlock(block)
  const inRepeat = block.repeatPrefix.trim() !== ""
  const setField = (name: string, next: FieldValue) =>
    onChange({ ...block, fields: { ...block.fields, [name]: next } })
  return (
    <li className="panel-block">
      <div className="panel-block-head">
        {opaque ? (
          <span className="desk-tag">{block.kind}</span>
        ) : (
          <select
            aria-label={t("studio.panels.blockKind")}
            value={block.kind}
            onChange={(e) => onChange({ ...newBlock(e.target.value), uid: block.uid })}
          >
            {BLOCK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`studio.panels.kind.${kind}`)}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="ghost-button"
          onClick={() => onMove(-1)}
          aria-label={t("studio.panels.moveUp")}
        >
          ↑
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={() => onMove(1)}
          aria-label={t("studio.panels.moveDown")}
        >
          ↓
        </button>
        <button
          type="button"
          className="ghost-button"
          onClick={onRemove}
          aria-label={t("studio.panels.removeBlock")}
        >
          ✕
        </button>
      </div>
      {opaque ? (
        // A block this table does not model — kept exactly as written, and said so,
        // rather than silently rewritten or dropped.
        <p className="studio-hint">{t("studio.panels.opaqueBlock")}</p>
      ) : (
        <>
          {fields.map((spec) => {
            const value = block.fields[spec.name] ?? emptyFieldValue(spec.type)
            const label = t(`studio.panels.field.${spec.name}`, { defaultValue: spec.name })
            if (isOptions(value)) {
              return (
                <OptionsInput
                  key={spec.name}
                  label={label}
                  options={value.options}
                  onChange={(options) => setField(spec.name, { mode: "options", options })}
                  variables={variables}
                  inRepeat={inRepeat}
                />
              )
            }
            return (
              <FieldInput
                key={spec.name}
                spec={spec}
                label={label}
                value={value}
                onChange={(next) => setField(spec.name, next)}
                variables={variables}
                inRepeat={inRepeat}
              />
            )
          })}
          <div className="panel-field">
            <span className="panel-field-name">{t("studio.panels.visibleWhen")}</span>
            <input
              aria-label={t("studio.panels.visibleWhen")}
              value={block.visibleWhen}
              onChange={(e) => onChange({ ...block, visibleWhen: e.target.value })}
              placeholder="day >= 3"
              spellCheck={false}
            />
          </div>
          <div className="panel-field">
            <span className="panel-field-name">{t("studio.panels.repeat")}</span>
            <input
              aria-label={t("studio.panels.repeat")}
              value={block.repeatPrefix}
              onChange={(e) => onChange({ ...block, repeatPrefix: e.target.value })}
              placeholder={t("studio.panels.repeatPlaceholder")}
              spellCheck={false}
            />
          </div>
          {inRepeat ? (
            <div className="panel-field">
              <span className="panel-field-name">{t("studio.panels.repeatVisibleWhen")}</span>
              <input
                aria-label={t("studio.panels.repeatVisibleWhen")}
                value={block.repeatVisibleWhen}
                onChange={(e) => onChange({ ...block, repeatVisibleWhen: e.target.value })}
                placeholder="day >= 3"
                spellCheck={false}
              />
            </div>
          ) : null}
        </>
      )}
    </li>
  )
}

function PanelCard({
  panel,
  variables,
  onChange,
  onRemove,
}: {
  panel: PanelDraft
  variables: LintVariable[]
  onChange: (next: PanelDraft) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const setBlock = (index: number, next: BlockDraft) =>
    onChange({ ...panel, blocks: panel.blocks.map((block, i) => (i === index ? next : block)) })
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= panel.blocks.length) return
    const blocks = [...panel.blocks]
    const [moved] = blocks.splice(index, 1)
    blocks.splice(target, 0, moved)
    onChange({ ...panel, blocks })
  }

  return (
    <section className="panel-card">
      <div className="panel-field">
        <span className="panel-field-name">{t("studio.panels.id")}</span>
        <input
          aria-label={t("studio.panels.id")}
          value={panel.id}
          onChange={(e) => onChange({ ...panel, id: e.target.value })}
          placeholder="tide-board"
          spellCheck={false}
        />
      </div>
      <TitleInput
        label={t("studio.panels.title")}
        value={panel.title}
        onChange={(title) => onChange({ ...panel, title })}
      />
      <div className="panel-field">
        <span className="panel-field-name">{t("studio.panels.slot")}</span>
        <select
          aria-label={t("studio.panels.slot")}
          value={panel.slot}
          onChange={(e) => onChange({ ...panel, slot: e.target.value as PanelDraft["slot"] })}
        >
          {PANEL_SLOTS.map((slot) => (
            <option key={slot} value={slot}>
              {t(`studio.panels.slotName.${slot}`)}
            </option>
          ))}
        </select>
        <span className="panel-field-name">{t("studio.panels.audience")}</span>
        <select
          aria-label={t("studio.panels.audience")}
          value={panel.audience}
          onChange={(e) => onChange({ ...panel, audience: e.target.value as PanelDraft["audience"] })}
        >
          {PANEL_AUDIENCES.map((audience) => (
            <option key={audience} value={audience}>
              {t(`studio.panels.audienceName.${audience}`)}
            </option>
          ))}
        </select>
      </div>

      <ul className="panel-blocks">
        {panel.blocks.map((block, index) => (
          <BlockCard
            key={block.uid}
            block={block}
            variables={variables}
            onChange={(next) => setBlock(index, next)}
            onRemove={() => onChange({ ...panel, blocks: panel.blocks.filter((_, i) => i !== index) })}
            onMove={(delta) => move(index, delta)}
          />
        ))}
      </ul>
      <div className="chip-row">
        <select
          aria-label={t("studio.panels.addBlock")}
          value=""
          onChange={(e) => {
            if (!e.target.value) return
            onChange({ ...panel, blocks: [...panel.blocks, newBlock(e.target.value)] })
          }}
        >
          <option value="">{t("studio.panels.addBlock")}</option>
          {BLOCK_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`studio.panels.kind.${kind}`)}
            </option>
          ))}
        </select>
        <button type="button" className="ghost-button" onClick={onRemove}>
          {t("studio.panels.removePanel")}
        </button>
      </div>
    </section>
  )
}

export default function PanelsEditor({ yamlText, onChange, variables }: Props) {
  const { t } = useTranslation()
  const [document, setDocument] = useState<PanelsDocument>(EMPTY_DOC)
  const [parseError, setParseError] = useState<string | null>(null)
  const [mode, setMode] = useState<"visual" | "yaml">("visual")
  const [description, setDescription] = useState("")
  const [drafting, setDrafting] = useState(false)
  const [draftProblems, setDraftProblems] = useState<string[]>([])
  const aiSettings = useAiStore()
  const activePreset = useActivePreset()
  // The text this editor itself last wrote up. The parent stores it and hands it
  // straight back as `yamlText`; re-parsing our own serialization would rebuild the
  // model with fresh uids under the author's cursor — every card remounts and the
  // focused input is destroyed after one keystroke. So the file is re-read only when
  // the text is NOT ours: on mount, and when the YAML tab (or anything else) changed it.
  const lastEmitted = useRef<string | null>(null)

  useEffect(() => {
    if (yamlText === lastEmitted.current) return
    lastEmitted.current = null
    const result = parsePanelsYaml(yamlText)
    setParseError(result.error)
    if (result.error === null) setDocument(result.document)
  }, [yamlText])

  const commit = (next: PanelsDocument) => {
    const text = serializePanelsYaml(next)
    lastEmitted.current = text
    setDocument(next)
    onChange(text)
  }

  const declared = useMemo(() => new Set(variables.map((variable) => variable.id)), [variables])
  const problems = useMemo(() => problemsFor(document, declared), [document, declared])
  const opaqueBlocks = useMemo(
    () => document.panels.reduce((n, panel) => n + panel.blocks.filter(isOpaqueBlock).length, 0),
    [document],
  )

  const draft = async () => {
    const text = description.trim()
    if (!text || drafting) return
    setDrafting(true)
    setDraftProblems([])
    try {
      // Same assembly as every other AI lane: an active preset's text LEADS and the
      // built-in contract follows, so a studio-wide preset shapes the voice while the
      // deterministic gate below stays enforceable either way.
      const builtin = panelsSystemPrompt(variables)
      const assembled =
        activePreset === null ? null : assembleSystemPrompt(activePreset, activePreset.overrides, {})
      const system =
        assembled === null || assembled.system === "" ? builtin : `${assembled.system}\n\n${builtin}`
      const sampling = activePreset === null ? undefined : toLlmSampling(activePreset.sampling)
      const result = await draftWithRetries<PanelsDocument>(
        system,
        [{ role: "user", content: text }],
        (parsed) => gatePanelsDraft(parsed, variables),
        3,
        sampling && Object.keys(sampling).length > 0 ? sampling : undefined,
      )
      const drafted = result.value
      if (drafted === null) {
        setDraftProblems(result.problems)
        return
      }
      // Drafted panels are APPENDED with fresh uids — a draft adds to the author's
      // work, it never silently replaces what they already wrote.
      commit({
        panels: [...document.panels, ...drafted.panels.map((panel) => ({ ...panel, uid: nextUid() }))],
        opaque: document.opaque,
      })
      setDescription("")
    } catch (error) {
      setDraftProblems([String(error)])
    } finally {
      setDrafting(false)
    }
  }

  return (
    <div className="panels-editor">
      <div className="play-form">
        <label className="field">
          {t("studio.panels.describe")}
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("studio.panels.describePlaceholder")}
          />
        </label>
        <div className="chip-row">
          <button
            type="button"
            className="primary-button"
            disabled={!aiReady(aiSettings) || !description.trim() || drafting}
            onClick={() => void draft()}
          >
            {drafting ? t("studio.panels.drafting") : t("studio.panels.draft")}
          </button>
          {!aiReady(aiSettings) ? <span className="studio-hint">{t("studio.panels.aiUnset")}</span> : null}
        </div>
        {draftProblems.length > 0 ? (
          <ul className="issue-list">
            {draftProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="chip-row" role="group" aria-label={t("studio.panels.mode")}>
        <button
          type="button"
          className={mode === "visual" ? "primary-button" : "ghost-button"}
          onClick={() => setMode("visual")}
        >
          {t("studio.panels.modeVisual")}
        </button>
        <button
          type="button"
          className={mode === "yaml" ? "primary-button" : "ghost-button"}
          onClick={() => setMode("yaml")}
        >
          {t("studio.panels.modeYaml")}
        </button>
      </div>

      {mode === "yaml" ? (
        <label className="field">
          {t("studio.pack.panels.yaml")}
          <textarea
            rows={14}
            value={yamlText}
            spellCheck={false}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      ) : parseError !== null ? (
        <p className="studio-hint panels-error">{t("studio.panels.unparseable", { error: parseError })}</p>
      ) : (
        <>
          {document.panels.map((panel, index) => (
            <PanelCard
              key={panel.uid}
              panel={panel}
              variables={variables}
              onChange={(next) =>
                commit({
                  ...document,
                  panels: document.panels.map((entry, i) => (i === index ? next : entry)),
                })
              }
              onRemove={() => commit({ ...document, panels: document.panels.filter((_, i) => i !== index) })}
            />
          ))}
          <button
            type="button"
            className="ghost-button"
            onClick={() => commit({ ...document, panels: [...document.panels, newPanel()] })}
          >
            {t("studio.panels.addPanel")}
          </button>
          {document.opaque.length > 0 ? (
            <p className="studio-hint">{t("studio.panels.opaque", { count: document.opaque.length })}</p>
          ) : null}
          {opaqueBlocks > 0 ? (
            <p className="studio-hint">{t("studio.panels.opaqueBlocks", { count: opaqueBlocks })}</p>
          ) : null}
        </>
      )}

      {problems.length > 0 ? (
        <ul className="issue-list">
          {problems.map((problem, index) => (
            <li key={`${problem.key}-${index}`}>
              {t(`studio.panels.problem.${problem.key}`, problem.params)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
