// The panels step's editor (panels 3.0): forms instead of a YAML box, a live preview, and a
// way to draft panels from a sentence.
//
// `ui/panels.yaml` stays the source of truth on disk — this edits a parsed model and writes
// the file back, so a hand-written file opens here and an edited one still reads as ordinary
// YAML. The YAML tab is always there (and for anything the forms do not model, which they
// carry through untouched rather than eating).
//
// A panel reads VIEWS: it declares them under handles, and every field may read a path
// inside one. The paths a built-in view's schema declares are offered as you type; the
// preview evaluates the panel with the protocol package's `panelBlocks` — the SAME evaluation
// play mode runs — over sample view values you can edit.

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { Block as WireBlock } from "loreweaver-protocol"
import type { LintVariable } from "../lint/model"
import { aiReady, draftWithRetries, useAiStore } from "../ai/provider"
import { StreamPreview } from "../ai/StreamPreview"
import { useDraftStream } from "../ai/useDraftStream"
import { Block } from "../../play/UiBlocks"
import { gatePanelsDraft, panelsSystemPrompt } from "./panelsAi"
import { checkPanelsText } from "./panelsCheck"
import {
  BLOCK_KINDS,
  PANEL_AUDIENCES,
  PANEL_SLOTS,
  binding,
  emptyFieldValue,
  emptyLocalized,
  fieldMayBind,
  fieldsFor,
  isLocalized,
  isOpaqueBlock,
  isOptions,
  isPanelAudience,
  isPanelSlot,
  literal,
  newBlock,
  newOption,
  newPanel,
  newRepeat,
  newViewDecl,
  nextUid,
  opaqueBlockCount,
  parseArgsText,
  parseLiteralInput,
  parsePanelsYaml,
  serializePanelsYaml,
  type BlockDraft,
  type ChoiceOptionDraft,
  type FieldSpec,
  type FieldValue,
  type Localized,
  type PanelDraft,
  type PanelsDocument,
  type Scalar,
  type ViewDecl,
} from "./panelsModel"
import {
  bindablePaths,
  commandIds,
  previewBlocks,
  sampleViewValue,
  viewNames,
  type SchemaPath,
} from "./panelsPreview"

interface Props {
  yamlText: string
  onChange: (yamlText: string) => void
  /** The pack's declared variables, for the drafting prompt (`variables` view paths). */
  variables: LintVariable[]
  /** The pack's module ids: `<module>/<view>` and `<module>/<command>` are offered. */
  moduleIds: string[]
  /** The panel files the pack ships (pack paths): a page's HTML, pictures. */
  files: string[]
}

const EMPTY_DOC: PanelsDocument = { panels: [] }

/** A datalist, keyed by an id unique to its options. */
function Options({ id, values }: { id: string; values: readonly string[] }) {
  return (
    <datalist id={id}>
      {values.map((value) => (
        <option key={value} value={value} />
      ))}
    </datalist>
  )
}

/** ONE control for every field: text an author types (or a literal), or a binding that reads
 * a path. Which sources are OFFERED follows the format: `src` and `style` never bind. */
function FieldInput({
  label,
  spec,
  value,
  onChange,
  paths,
  files,
}: {
  label: string
  spec: FieldSpec
  value: FieldValue
  onChange: (next: FieldValue) => void
  paths: SchemaPath[]
  files: string[]
}) {
  const { t } = useTranslation()
  const listId = useMemo(() => `panel-paths-${nextUid()}`, [])
  const localized = spec.type === "localized"
  const bound = !isOptions(value) && !isLocalized(value) && value.mode === "view"
  const Field = spec.name === "body" || spec.name === "text" ? "textarea" : "input"
  const setMode = (mode: string) => {
    if (mode === "view") onChange(binding(""))
    else onChange(localized ? emptyLocalized() : literal(""))
  }
  return (
    <div className="panel-field">
      <span className="panel-field-name">{label}</span>
      {fieldMayBind(spec) ? (
        <select
          aria-label={t("studio.panels.field.mode", { field: label })}
          value={bound ? "view" : "text"}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="text">
            {localized ? t("studio.panels.field.text") : t("studio.panels.field.literal")}
          </option>
          <option value="view">{t("studio.panels.field.binding")}</option>
        </select>
      ) : null}
      {bound ? (
        <>
          <input
            aria-label={label}
            list={listId}
            value={(value as { path: string }).path}
            onChange={(e) => onChange(binding(e.target.value))}
            placeholder="me.character.name"
            spellCheck={false}
          />
          <Options id={listId} values={paths.map((entry) => entry.path)} />
        </>
      ) : isLocalized(value as FieldValue) ? (
        <>
          <Field
            aria-label={`${label} en`}
            value={(value as Localized).en}
            onChange={(e: { target: { value: string } }) =>
              onChange({ ...(value as Localized), en: e.target.value })
            }
            placeholder="en"
          />
          <Field
            aria-label={`${label} zh`}
            value={(value as Localized).zh}
            onChange={(e: { target: { value: string } }) =>
              onChange({ ...(value as Localized), zh: e.target.value })
            }
            placeholder="zh"
          />
        </>
      ) : spec.type === "enum" ? (
        <select
          aria-label={label}
          value={String((value as Scalar & { value: unknown }).value ?? "")}
          onChange={(e) => onChange(literal(e.target.value))}
        >
          <option value="">—</option>
          {(spec.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : spec.type === "path" ? (
        <>
          <input
            aria-label={label}
            list={listId}
            value={String((value as { value: unknown }).value ?? "")}
            onChange={(e) => onChange(literal(e.target.value))}
            placeholder="ui/map.png"
            spellCheck={false}
          />
          <Options id={listId} values={files} />
        </>
      ) : (
        <input
          aria-label={label}
          value={String((value as { value: unknown }).value ?? "")}
          onChange={(e) => onChange(parseLiteralInput(e.target.value))}
        />
      )}
    </div>
  )
}

/** A `choices` block's options: what the client shows, and the command each one runs. */
function OptionsInput({
  label,
  options,
  onChange,
  paths,
  commands,
}: {
  label: string
  options: ChoiceOptionDraft[]
  onChange: (next: ChoiceOptionDraft[]) => void
  paths: SchemaPath[]
  commands: string[]
}) {
  const { t } = useTranslation()
  const listId = useMemo(() => `panel-commands-${nextUid()}`, [])
  const set = (index: number, next: ChoiceOptionDraft) =>
    onChange(options.map((option, i) => (i === index ? next : option)))
  return (
    <div className="panel-options">
      <span className="panel-field-name">{label}</span>
      <Options id={listId} values={commands} />
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
              <span className="panel-field-name">{t("studio.panels.field.command")}</span>
              <input
                aria-label={`${t("studio.panels.field.command")} ${index + 1}`}
                list={listId}
                value={option.command}
                onChange={(e) => set(index, { ...option, command: e.target.value })}
                placeholder="roll"
                spellCheck={false}
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
              onChange={(next) => set(index, { ...option, label: next as ChoiceOptionDraft["label"] })}
              paths={paths}
              files={[]}
            />
            <div className="panel-field">
              <span className="panel-field-name">{t("studio.panels.field.args")}</span>
              <input
                aria-label={`${t("studio.panels.field.args")} ${index + 1}`}
                value={option.argsText}
                onChange={(e) => set(index, { ...option, argsText: e.target.value })}
                // i18n-exempt: a JSON sample — code.
                placeholder={'{"expr": "1d100"}'}
                spellCheck={false}
              />
              {parseArgsText(option.argsText) === null ? (
                <span className="studio-hint panels-error">{t("studio.panels.argsInvalid")}</span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className="ghost-button" onClick={() => onChange([...options, newOption()])}>
        {t("studio.panels.addOption")}
      </button>
    </div>
  )
}

/** A panel's `views`: handle → view name. */
function ViewsInput({
  views,
  onChange,
  names,
}: {
  views: ViewDecl[]
  onChange: (next: ViewDecl[]) => void
  names: string[]
}) {
  const { t } = useTranslation()
  const listId = useMemo(() => `panel-views-${nextUid()}`, [])
  const set = (index: number, next: ViewDecl) => onChange(views.map((decl, i) => (i === index ? next : decl)))
  return (
    <div className="panel-options">
      <span className="panel-field-name">{t("studio.panels.views")}</span>
      <Options id={listId} values={names} />
      <ul className="panel-option-list">
        {views.map((decl, index) => (
          <li key={decl.uid} className="panel-field">
            <input
              aria-label={`${t("studio.panels.viewHandle")} ${index + 1}`}
              value={decl.handle}
              onChange={(e) => set(index, { ...decl, handle: e.target.value })}
              placeholder="me"
              spellCheck={false}
            />
            <span aria-hidden="true">→</span>
            <input
              aria-label={`${t("studio.panels.viewName")} ${index + 1}`}
              list={listId}
              value={decl.view}
              onChange={(e) => set(index, { ...decl, view: e.target.value })}
              placeholder="me"
              spellCheck={false}
            />
            <button
              type="button"
              className="ghost-button"
              onClick={() => onChange(views.filter((_, i) => i !== index))}
              aria-label={t("studio.panels.removeView")}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="ghost-button" onClick={() => onChange([...views, newViewDecl()])}>
        {t("studio.panels.addView")}
      </button>
    </div>
  )
}

function BlockCard({
  block,
  views,
  files,
  commands,
  onChange,
  onRemove,
  onMove,
}: {
  block: BlockDraft
  views: ViewDecl[]
  files: string[]
  commands: string[]
  onChange: (next: BlockDraft) => void
  onRemove: () => void
  onMove: (delta: number) => void
}) {
  const { t } = useTranslation()
  const listId = useMemo(() => `panel-lists-${nextUid()}`, [])
  const fields = fieldsFor(block.kind) ?? []
  const opaque = isOpaqueBlock(block)
  const paths = useMemo(() => bindablePaths(views, block.repeat), [views, block.repeat])
  const listPaths = useMemo(() => bindablePaths(views).filter((entry) => entry.list), [views])
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
            onChange={(e) => onChange({ ...newBlock(e.target.value), uid: block.uid, repeat: block.repeat })}
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
        // A block the forms do not model — kept exactly as written, and said so.
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
                  paths={paths}
                  commands={commands}
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
                paths={paths}
                files={files}
              />
            )
          })}
          <div className="panel-field">
            <span className="panel-field-name">{t("studio.panels.visibleWhen")}</span>
            <input
              aria-label={t("studio.panels.visibleWhen")}
              value={block.visibleWhen}
              onChange={(e) => onChange({ ...block, visibleWhen: e.target.value })}
              placeholder="me.character.resources.hp.value > 0"
              spellCheck={false}
            />
          </div>
          <label className="pack-checkbox">
            <input
              type="checkbox"
              checked={block.repeat !== null}
              onChange={(e) => onChange({ ...block, repeat: e.target.checked ? newRepeat() : null })}
            />
            {t("studio.panels.repeat")}
          </label>
          {block.repeat !== null ? (
            <>
              <div className="panel-field">
                <span className="panel-field-name">{t("studio.panels.repeatEach")}</span>
                <input
                  aria-label={t("studio.panels.repeatEach")}
                  list={listId}
                  value={block.repeat.each}
                  onChange={(e) => onChange({ ...block, repeat: { ...block.repeat!, each: e.target.value } })}
                  placeholder="me.character.resources"
                  spellCheck={false}
                />
                <Options id={listId} values={listPaths.map((entry) => entry.path)} />
                <span className="panel-field-name">{t("studio.panels.repeatAs")}</span>
                <input
                  aria-label={t("studio.panels.repeatAs")}
                  value={block.repeat.as}
                  onChange={(e) => onChange({ ...block, repeat: { ...block.repeat!, as: e.target.value } })}
                  spellCheck={false}
                />
                <span className="panel-field-name">{t("studio.panels.repeatPrefix")}</span>
                <input
                  aria-label={t("studio.panels.repeatPrefix")}
                  value={block.repeat.prefix}
                  onChange={(e) =>
                    onChange({ ...block, repeat: { ...block.repeat!, prefix: e.target.value } })
                  }
                  placeholder={t("studio.panels.repeatPrefixPlaceholder")}
                  spellCheck={false}
                />
              </div>
              <div className="panel-field">
                <span className="panel-field-name">{t("studio.panels.repeatVisibleWhen")}</span>
                <input
                  aria-label={t("studio.panels.repeatVisibleWhen")}
                  value={block.repeat.visibleWhen}
                  onChange={(e) =>
                    onChange({ ...block, repeat: { ...block.repeat!, visibleWhen: e.target.value } })
                  }
                  spellCheck={false}
                />
              </div>
            </>
          ) : null}
        </>
      )}
    </li>
  )
}

/** An ordered list of blocks with add / move / remove: a template, or a page's fallback. */
function BlockList({
  blocks,
  views,
  files,
  commands,
  onChange,
}: {
  blocks: BlockDraft[]
  views: ViewDecl[]
  files: string[]
  commands: string[]
  onChange: (next: BlockDraft[]) => void
}) {
  const { t } = useTranslation()
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    onChange(next)
  }
  return (
    <>
      <ul className="panel-blocks">
        {blocks.map((block, index) => (
          <BlockCard
            key={block.uid}
            block={block}
            views={views}
            files={files}
            commands={commands}
            onChange={(next) => onChange(blocks.map((entry, i) => (i === index ? next : entry)))}
            onRemove={() => onChange(blocks.filter((_, i) => i !== index))}
            onMove={(delta) => move(index, delta)}
          />
        ))}
      </ul>
      <select
        aria-label={t("studio.panels.addBlock")}
        value=""
        onChange={(e) => {
          if (e.target.value) onChange([...blocks, newBlock(e.target.value)])
        }}
      >
        <option value="">{t("studio.panels.addBlock")}</option>
        {BLOCK_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`studio.panels.kind.${kind}`)}
          </option>
        ))}
      </select>
    </>
  )
}

/** One preview block. A picture shows its pack path: the preview has the file names, not a
 * server's media store. Everything else is play mode's own block view, its choices inert. */
function PreviewBlock({ block }: { block: WireBlock }) {
  const { t } = useTranslation()
  if (block.kind === "image" || block.kind === "map_pin") {
    const caption = block.kind === "image" ? (block.caption ?? block.alt) : block.label
    return (
      <figure className="ui-image">
        <p className="ui-image-fallback">{t("studio.panels.previewPicture", { path: block.hash })}</p>
        {caption ? <figcaption className="ui-image-caption">{caption}</figcaption> : null}
      </figure>
    )
  }
  return <Block block={block} online={false} />
}

/** The live preview of one panel, over sample values of the views it reads. */
function PanelPreview({
  panel,
  samples,
  onSample,
  locale,
}: {
  panel: PanelDraft
  samples: Record<string, string>
  onSample: (view: string, text: string) => void
  locale: string
}) {
  const { t } = useTranslation()
  const role =
    panel.audience === "admin" || panel.views.some((decl) => decl.view.startsWith("admin/"))
      ? "admin"
      : "player"
  const names = [...new Set(panel.views.map((decl) => decl.view).filter(Boolean))]
  const values = new Map<string, unknown>()
  const broken: string[] = []
  for (const name of names) {
    const text = samples[name] ?? JSON.stringify(sampleViewValue(name, role), null, 2)
    try {
      values.set(name, JSON.parse(text))
    } catch {
      broken.push(name)
    }
  }
  const blocks = previewBlocks(panel, locale, values)
  return (
    <div className="panel-preview" aria-label={t("studio.panels.preview")}>
      <h4>{t("studio.panels.preview")}</h4>
      <div className="ui-blocks">
        {blocks === null ? (
          <p className="studio-hint">{t("studio.panels.previewNeedsRich")}</p>
        ) : blocks.length === 0 ? (
          <p className="studio-hint">{t("studio.panels.previewEmpty")}</p>
        ) : (
          blocks.map((block, index) => <PreviewBlock key={index} block={block} />)
        )}
      </div>
      {names.length > 0 ? (
        <details>
          <summary>{t("studio.panels.samples")}</summary>
          <p className="studio-hint">{t("studio.panels.samplesHint")}</p>
          {names.map((name) => (
            <label key={name} className="field field-wide">
              {name}
              <textarea
                className="wizard-yaml"
                rows={6}
                value={samples[name] ?? JSON.stringify(sampleViewValue(name, role), null, 2)}
                onChange={(e) => onSample(name, e.target.value)}
                spellCheck={false}
              />
              {broken.includes(name) ? (
                <span className="studio-hint panels-error">{t("studio.panels.sampleInvalid")}</span>
              ) : null}
            </label>
          ))}
        </details>
      ) : null}
    </div>
  )
}

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

function PanelCard({
  panel,
  names,
  files,
  commands,
  samples,
  onSample,
  locale,
  onChange,
  onRemove,
}: {
  panel: PanelDraft
  names: string[]
  files: string[]
  commands: string[]
  samples: Record<string, string>
  onSample: (view: string, text: string) => void
  locale: string
  onChange: (next: PanelDraft) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const listId = useMemo(() => `panel-pages-${nextUid()}`, [])
  const pages = files.filter((file) => /\.html?$/i.test(file))
  const setKind = (kind: "template" | "page") => {
    // A key only the other kind takes would make the panel refused; switching drops it.
    const rest = panel.rest === undefined ? undefined : { ...panel.rest }
    if (rest) {
      delete rest.blocks
      delete rest.fallback
    }
    onChange({
      ...panel,
      kind,
      ...(rest && Object.keys(rest).length > 0 ? { rest } : { rest: undefined }),
      blocks: kind === "template" && panel.blocks.length === 0 ? (panel.fallback ?? []) : panel.blocks,
      fallback:
        kind === "page"
          ? (panel.fallback ?? (panel.blocks.length > 0 ? panel.blocks : null))
          : panel.fallback,
    })
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
        <span className="panel-field-name">{t("studio.panels.panelKind")}</span>
        <select
          aria-label={t("studio.panels.panelKind")}
          value={panel.kind}
          onChange={(e) => setKind(e.target.value as "template" | "page")}
        >
          <option value="template">{t("studio.panels.kindTemplate")}</option>
          <option value="page">{t("studio.panels.kindPage")}</option>
        </select>
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
          onChange={(e) => onChange({ ...panel, slot: e.target.value })}
        >
          {(isPanelSlot(panel.slot) ? PANEL_SLOTS : [...PANEL_SLOTS, panel.slot]).map((slot) => (
            <option key={slot} value={slot}>
              {isPanelSlot(slot) ? t(`studio.panels.slotName.${slot}`) : slot}
            </option>
          ))}
        </select>
        <span className="panel-field-name">{t("studio.panels.audience")}</span>
        <select
          aria-label={t("studio.panels.audience")}
          value={panel.audience}
          onChange={(e) => onChange({ ...panel, audience: e.target.value })}
        >
          {(isPanelAudience(panel.audience) ? PANEL_AUDIENCES : [...PANEL_AUDIENCES, panel.audience]).map(
            (audience) => (
              <option key={audience} value={audience}>
                {isPanelAudience(audience) ? t(`studio.panels.audienceName.${audience}`) : audience}
              </option>
            ),
          )}
        </select>
      </div>
      <ViewsInput views={panel.views} onChange={(views) => onChange({ ...panel, views })} names={names} />

      {panel.kind === "template" ? (
        <BlockList
          blocks={panel.blocks}
          views={panel.views}
          files={files}
          commands={commands}
          onChange={(blocks) => onChange({ ...panel, blocks })}
        />
      ) : (
        <>
          <div className="panel-field">
            <span className="panel-field-name">{t("studio.panels.entry")}</span>
            <input
              aria-label={t("studio.panels.entry")}
              list={listId}
              value={panel.entry}
              onChange={(e) => onChange({ ...panel, entry: e.target.value })}
              placeholder="ui/chart.html"
              spellCheck={false}
            />
            <Options id={listId} values={pages} />
          </div>
          <p className="studio-hint">{t("studio.panels.pageHint")}</p>
          <label className="pack-checkbox">
            <input
              type="checkbox"
              checked={panel.fallback !== null}
              onChange={(e) => onChange({ ...panel, fallback: e.target.checked ? [] : null })}
            />
            {t("studio.panels.fallbackBlocks")}
          </label>
          {panel.fallback !== null ? (
            <BlockList
              blocks={panel.fallback}
              views={panel.views}
              files={files}
              commands={commands}
              onChange={(fallback) => onChange({ ...panel, fallback })}
            />
          ) : (
            <p className="studio-hint">{t("studio.panels.fallbackNull")}</p>
          )}
        </>
      )}
      <PanelPreview panel={panel} samples={samples} onSample={onSample} locale={locale} />
      <div className="chip-row">
        <button type="button" className="ghost-button" onClick={onRemove}>
          {t("studio.panels.removePanel")}
        </button>
      </div>
    </section>
  )
}

export default function PanelsEditor({ yamlText, onChange, variables, moduleIds, files }: Props) {
  const { t, i18n } = useTranslation()
  const [document, setDocument] = useState<PanelsDocument>(EMPTY_DOC)
  const [parseError, setParseError] = useState<string | null>(null)
  const [mode, setMode] = useState<"visual" | "yaml">("visual")
  const [description, setDescription] = useState("")
  const [drafting, setDrafting] = useState(false)
  const [samples, setSamples] = useState<Record<string, string>>({})
  const stream = useDraftStream()
  const [draftProblems, setDraftProblems] = useState<string[]>([])
  const aiSettings = useAiStore()
  // The text this editor itself last wrote. Re-parsing our own serialization would rebuild
  // the model with fresh uids under the author's cursor, so the file is re-read only when the
  // text is NOT ours: on mount, and when the YAML tab (or anything else) changed it.
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

  const names = useMemo(() => viewNames(moduleIds), [moduleIds])
  const commands = useMemo(() => commandIds(moduleIds), [moduleIds])
  const imageFiles = useMemo(() => files.filter((file) => !/\.html?$/i.test(file)), [files])
  const problems = useMemo(() => (yamlText.trim() ? checkPanelsText(yamlText).problems : []), [yamlText])
  const opaqueBlocks = useMemo(() => opaqueBlockCount(document), [document])

  const draft = async () => {
    const text = description.trim()
    if (!text || drafting) return
    setDrafting(true)
    setDraftProblems([])
    try {
      const result = await draftWithRetries<PanelsDocument>(
        panelsSystemPrompt(variables, moduleIds),
        [{ role: "user", content: text }],
        (parsed) => gatePanelsDraft(parsed),
        3,
        undefined,
        stream.onStream,
      )
      if (result.value === null) {
        setDraftProblems(result.problems)
        return
      }
      // Drafted panels are APPENDED with fresh uids — a draft adds to the author's work, it
      // never silently replaces what they already wrote.
      commit({
        panels: [...document.panels, ...result.value.panels.map((panel) => ({ ...panel, uid: nextUid() }))],
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
        <StreamPreview text={stream.text} busy={drafting} />
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

      {/* Field editing round-trips the file through parse + stringify, so the first edit it
          commits REPRINTS the whole document: comments and quoting style are gone. */}
      <p className="studio-hint">{t("studio.panels.rewriteNotice")}</p>

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
              names={names}
              files={imageFiles.concat(files.filter((file) => /\.html?$/i.test(file)))}
              commands={commands}
              samples={samples}
              onSample={(view, text) => setSamples((current) => ({ ...current, [view]: text }))}
              locale={i18n.language}
              onChange={(next) =>
                commit({ panels: document.panels.map((entry, i) => (i === index ? next : entry)) })
              }
              onRemove={() => commit({ panels: document.panels.filter((_, i) => i !== index) })}
            />
          ))}
          <button
            type="button"
            className="ghost-button"
            onClick={() => commit({ panels: [...document.panels, newPanel()] })}
          >
            {t("studio.panels.addPanel")}
          </button>
          {opaqueBlocks > 0 ? (
            <p className="studio-hint">{t("studio.panels.opaqueBlocks", { count: opaqueBlocks })}</p>
          ) : null}
        </>
      )}

      {problems.length > 0 ? (
        <ul className="issue-list">
          {problems.map((problem, index) => (
            <li key={`${problem.code}-${index}`}>
              {t(`studio.panels.problem.${problem.code}`, {
                at: problem.path || "panels.yaml",
                detail: problem.detail ?? "",
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
