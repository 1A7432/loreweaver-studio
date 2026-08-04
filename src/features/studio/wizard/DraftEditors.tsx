// Structured editors for each stage draft — the author's post-structuring
// workbench. Everything is controlled state on the wizard store's draft; the
// mandatory-manual slots (derivations, motivation, exegesis) render as clearly
// marked handwriting areas that only UI input can fill.

import { useTranslation } from "react-i18next"
import { flattenLeaves, parseInitvar } from "../split/mvu"
import { promoteLeaves } from "../split/promote"
import { estimateTokens } from "./tokens"
import type { CharacterFacet, NpcDraft, PaletteColor, StageDraft, WizardLoreDraft } from "./stages"

function nextSlot(entries: WizardLoreDraft[], prefix: string): string {
  let max = -1
  for (const entry of entries) {
    const suffix = Number(entry.slot.split(":").at(-1))
    if (Number.isFinite(suffix)) max = Math.max(max, suffix)
  }
  return `${prefix}:${max + 1}`
}

function LoreEntriesEditor({
  entries,
  slotPrefix,
  sourceLabel,
  onChange,
}: {
  entries: WizardLoreDraft[]
  slotPrefix: string
  sourceLabel: string
  onChange: (entries: WizardLoreDraft[]) => void
}) {
  const { t } = useTranslation()
  const patch = (index: number, part: Partial<WizardLoreDraft>) =>
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...part } : entry)))

  return (
    <div className="wizard-entries">
      {entries.map((entry, index) => (
        <div key={entry.slot} className="wizard-entry">
          <div className="dialog-row">
            <label className="field">
              {t("studio.wizard.entry.title")}
              <input value={entry.title} onChange={(e) => patch(index, { title: e.target.value })} />
            </label>
            <label className="field field-narrow">
              {t("studio.wizard.entry.layer")}
              <select
                value={entry.layer}
                onChange={(e) => patch(index, { layer: e.target.value as "constant" | "triggered" })}
              >
                <option value="constant">{t("studio.wizard.layer.constant")}</option>
                <option value="triggered">{t("studio.wizard.layer.triggered")}</option>
              </select>
            </label>
            <label className="wizard-check">
              <input
                type="checkbox"
                checked={entry.secret}
                onChange={(e) => patch(index, { secret: e.target.checked })}
              />
              {t("studio.wb.secret")}
            </label>
            <span className="wizard-tokens" title={t("studio.wizard.tokensTitle")}>
              ≈{estimateTokens(entry.content)}
            </span>
            <button
              type="button"
              className="ghost-button"
              onClick={() => onChange(entries.filter((_, i) => i !== index))}
            >
              {t("studio.remove")}
            </button>
          </div>
          {entry.layer === "triggered" ? (
            <label className="field">
              {t("studio.wb.keys")}
              <input
                value={entry.keys.join(", ")}
                placeholder={t("studio.wb.keysPlaceholder")}
                onChange={(e) =>
                  patch(index, {
                    keys: e.target.value
                      .split(/[\n,，、]/)
                      .map((k) => k.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          ) : null}
          <label className="field">
            {t("studio.wb.content")}
            <textarea
              rows={4}
              value={entry.content}
              onChange={(e) => patch(index, { content: e.target.value })}
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        className="ghost-button"
        onClick={() =>
          onChange([
            ...entries,
            {
              slot: nextSlot(entries, slotPrefix),
              title: "",
              content: "",
              keys: [],
              layer: "triggered",
              secret: false,
              sourceLabel,
            },
          ])
        }
      >
        {t("studio.wizard.entry.add")}
      </button>
    </div>
  )
}

function ManualArea({
  label,
  value,
  rows,
  onChange,
}: {
  label: string
  value: string
  rows: number
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="wizard-manual">
      <div className="wizard-manual-head">
        <span className="wizard-manual-badge">{t("studio.wizard.manualBadge")}</span>
        <span>{label}</span>
      </div>
      <textarea
        rows={rows}
        value={value}
        placeholder={t("studio.wizard.manualPlaceholder")}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function PaletteColorEditor({
  color,
  heading,
  manualLabel,
  onChange,
}: {
  color: PaletteColor
  heading: string
  manualLabel: string | null
  onChange: (color: PaletteColor) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="wizard-entry">
      <div className="dialog-row">
        <span className="wizard-entry-kind">{heading}</span>
        <label className="field">
          {t("studio.wizard.palette.name")}
          <input value={color.name} onChange={(e) => onChange({ ...color, name: e.target.value })} />
        </label>
      </div>
      <label className="field">
        {t("studio.wizard.palette.detail")}
        <textarea
          rows={2}
          value={color.detail}
          onChange={(e) => onChange({ ...color, detail: e.target.value })}
        />
      </label>
      {manualLabel !== null ? (
        <ManualArea
          label={manualLabel}
          value={color.derivation}
          rows={4}
          onChange={(derivation) => onChange({ ...color, derivation })}
        />
      ) : null}
    </div>
  )
}

function FacetEditor({
  facet,
  onChange,
  onRemove,
}: {
  facet: CharacterFacet
  onChange: (facet: CharacterFacet) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const fields: { key: keyof CharacterFacet; rows: number }[] = [
    { key: "trigger", rows: 1 },
    { key: "energy", rows: 1 },
    { key: "voice", rows: 2 },
    { key: "body", rows: 1 },
    { key: "role", rows: 1 },
    { key: "bleed", rows: 2 },
  ]
  return (
    <div className="wizard-entry">
      <div className="dialog-row">
        <label className="field">
          {t("studio.wizard.facet.name")}
          <input value={facet.name} onChange={(e) => onChange({ ...facet, name: e.target.value })} />
        </label>
        <button type="button" className="ghost-button" onClick={onRemove}>
          {t("studio.remove")}
        </button>
      </div>
      {fields.map(({ key, rows }) => (
        <label key={key} className="field">
          {t(`studio.wizard.facet.${key}`)}
          <textarea
            rows={rows}
            value={facet[key]}
            onChange={(e) => onChange({ ...facet, [key]: e.target.value })}
          />
        </label>
      ))}
    </div>
  )
}

function VariablesPreview({ yaml }: { yaml: string }) {
  const { t } = useTranslation()
  const tree = parseInitvar(yaml)
  if (tree === null) {
    return (
      <p className="studio-notice split-error" role="alert">
        {t("studio.wizard.vars.parseFailed")}
      </p>
    )
  }
  const drafts = promoteLeaves(flattenLeaves(tree).leaves)
  const included = drafts.filter((draft) => draft.include)
  return (
    <div className="wizard-vars-preview">
      <p className="studio-hint">{t("studio.wizard.vars.preview", { n: included.length })}</p>
      <table className="wizard-vars-table">
        <thead>
          <tr>
            <th>{t("studio.vars.id")}</th>
            <th>{t("studio.vars.kind")}</th>
            <th>{t("studio.vars.default")}</th>
            <th>{t("studio.wizard.vars.bounds")}</th>
            <th>{t("studio.vars.visibility")}</th>
          </tr>
        </thead>
        <tbody>
          {included.map((draft) => (
            <tr key={draft.uid}>
              <td>
                <code>{draft.variable.id}</code>
              </td>
              <td>{draft.variable.kind}</td>
              <td>{draft.variable.defaultValue}</td>
              <td>
                {draft.variable.kind === "number"
                  ? `${draft.variable.minimum || "—"}..${draft.variable.maximum || "—"}`
                  : draft.variable.kind === "enum"
                    ? draft.variable.options.split("\n").join(" | ")
                    : "—"}
              </td>
              <td>{draft.variable.visibility}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function DraftEditor({
  draft,
  onChange,
}: {
  draft: StageDraft
  onChange: (draft: StageDraft) => void
}) {
  const { t } = useTranslation()

  switch (draft.stage) {
    case "worldview":
      return (
        <LoreEntriesEditor
          entries={draft.entries}
          slotPrefix="wv"
          sourceLabel="worldview"
          onChange={(entries) => onChange({ ...draft, entries })}
        />
      )
    case "basics":
      return (
        <div className="wizard-entries">
          <div className="dialog-row">
            <label className="field">
              {t("studio.card.name")}
              <input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
            </label>
            <label className="field">
              {t("studio.card.tags")}
              <input
                value={draft.tags.join(", ")}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    tags: e.target.value
                      .split(/[\n,，、]/)
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </div>
          <label className="field">
            {t("studio.card.description")}
            <textarea
              rows={6}
              value={draft.description}
              onChange={(e) => onChange({ ...draft, description: e.target.value })}
            />
          </label>
        </div>
      )
    case "palette":
      return (
        <div className="wizard-entries">
          <PaletteColorEditor
            color={draft.base}
            heading={t("studio.wizard.palette.base")}
            manualLabel={null}
            onChange={(base) => onChange({ ...draft, base })}
          />
          {draft.mains.map((main, index) => (
            <PaletteColorEditor
              key={index}
              color={main}
              heading={t("studio.wizard.palette.main", { n: index + 1 })}
              manualLabel={t("studio.wizard.palette.derivation")}
              onChange={(next) =>
                onChange({ ...draft, mains: draft.mains.map((m, i) => (i === index ? next : m)) })
              }
            />
          ))}
          {draft.accent !== null ? (
            <PaletteColorEditor
              color={draft.accent}
              heading={t("studio.wizard.palette.accent")}
              manualLabel={null}
              onChange={(accent) => onChange({ ...draft, accent })}
            />
          ) : null}
        </div>
      )
    case "facets":
      return (
        <div className="wizard-entries">
          {draft.facets.map((facet, index) => (
            <FacetEditor
              key={index}
              facet={facet}
              onChange={(next) =>
                onChange({ ...draft, facets: draft.facets.map((f, i) => (i === index ? next : f)) })
              }
              onRemove={() => onChange({ ...draft, facets: draft.facets.filter((_, i) => i !== index) })}
            />
          ))}
          {draft.facets.length < 3 ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() =>
                onChange({
                  ...draft,
                  facets: [
                    ...draft.facets,
                    { name: "", trigger: "", energy: "", voice: "", body: "", role: "", bleed: "" },
                  ],
                })
              }
            >
              {t("studio.wizard.facet.add")}
            </button>
          ) : null}
        </div>
      )
    case "exegesis":
      return (
        <ManualArea
          label={t("studio.wizard.stages.exegesis.title")}
          value={draft.text}
          rows={8}
          onChange={(text) => onChange({ ...draft, text })}
        />
      )
    case "wardrobe":
      return (
        <LoreEntriesEditor
          entries={draft.entries}
          slotPrefix="wd"
          sourceLabel={draft.entries[0]?.sourceLabel ?? "character"}
          onChange={(entries) => onChange({ ...draft, entries })}
        />
      )
    case "nsfw":
      return (
        <div className="wizard-entries">
          <ManualArea
            label={t("studio.wizard.nsfw.motivation")}
            value={draft.motivation}
            rows={5}
            onChange={(motivation) => onChange({ ...draft, motivation })}
          />
          <LoreEntriesEditor
            entries={draft.entries}
            slotPrefix="nsfw"
            sourceLabel="nsfw"
            onChange={(entries) => onChange({ ...draft, entries })}
          />
        </div>
      )
    case "npcs":
      return (
        <div className="wizard-entries">
          {draft.npcs.map((npc, index) => (
            <NpcEditor
              key={index}
              npc={npc}
              onChange={(next) =>
                onChange({ ...draft, npcs: draft.npcs.map((n, i) => (i === index ? next : n)) })
              }
              onRemove={() => onChange({ ...draft, npcs: draft.npcs.filter((_, i) => i !== index) })}
            />
          ))}
          <button
            type="button"
            className="ghost-button"
            onClick={() =>
              onChange({ ...draft, npcs: [...draft.npcs, { name: "", role: "", content: "", keys: [] }] })
            }
          >
            {t("studio.wizard.npc.add")}
          </button>
        </div>
      )
    case "overview":
      return (
        <label className="field">
          {t("studio.wizard.stages.overview.title")}
          <textarea
            rows={8}
            value={draft.content}
            onChange={(e) => onChange({ ...draft, content: e.target.value })}
          />
        </label>
      )
    case "opening":
      return (
        <div className="wizard-entries">
          <label className="field">
            {t("studio.card.firstMes")}
            <textarea
              rows={8}
              value={draft.firstMes}
              onChange={(e) => onChange({ ...draft, firstMes: e.target.value })}
            />
          </label>
          <label className="field">
            {t("studio.card.mesExample")}
            <textarea
              rows={5}
              value={draft.mesExample}
              placeholder={t("studio.wizard.opening.mesExampleHint")}
              onChange={(e) => onChange({ ...draft, mesExample: e.target.value })}
            />
          </label>
          {draft.alternateGreetings.map((greeting, index) => (
            <div key={index} className="wizard-entry">
              <div className="dialog-row">
                <span className="wizard-entry-kind">
                  {t("studio.wizard.opening.alternate", { n: index + 1 })}
                </span>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() =>
                    onChange({
                      ...draft,
                      alternateGreetings: draft.alternateGreetings.filter((_, i) => i !== index),
                    })
                  }
                >
                  {t("studio.remove")}
                </button>
              </div>
              <textarea
                rows={5}
                value={greeting}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    alternateGreetings: draft.alternateGreetings.map((g, i) =>
                      i === index ? e.target.value : g,
                    ),
                  })
                }
              />
            </div>
          ))}
          {draft.alternateGreetings.length < 6 ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => onChange({ ...draft, alternateGreetings: [...draft.alternateGreetings, ""] })}
            >
              {t("studio.wizard.opening.addAlternate")}
            </button>
          ) : null}
        </div>
      )
    case "variables":
      return (
        <div className="wizard-entries">
          <label className="field">
            {t("studio.wizard.vars.yaml")}
            <textarea
              className="wizard-yaml"
              rows={10}
              spellCheck={false}
              value={draft.initvarYaml}
              onChange={(e) => onChange({ ...draft, initvarYaml: e.target.value })}
            />
          </label>
          <VariablesPreview yaml={draft.initvarYaml} />
          <label className="field">
            {t("studio.wizard.vars.rules")}
            <textarea
              rows={5}
              value={draft.updateRules}
              onChange={(e) => onChange({ ...draft, updateRules: e.target.value })}
            />
          </label>
        </div>
      )
  }
}

function NpcEditor({
  npc,
  onChange,
  onRemove,
}: {
  npc: NpcDraft
  onChange: (npc: NpcDraft) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="wizard-entry">
      <div className="dialog-row">
        <label className="field">
          {t("studio.wizard.npc.name")}
          <input value={npc.name} onChange={(e) => onChange({ ...npc, name: e.target.value })} />
        </label>
        <label className="field">
          {t("studio.wizard.npc.role")}
          <input value={npc.role} onChange={(e) => onChange({ ...npc, role: e.target.value })} />
        </label>
        <button type="button" className="ghost-button" onClick={onRemove}>
          {t("studio.remove")}
        </button>
      </div>
      <label className="field">
        {t("studio.wb.keys")}
        <input
          value={npc.keys.join(", ")}
          onChange={(e) =>
            onChange({
              ...npc,
              keys: e.target.value
                .split(/[\n,，、]/)
                .map((k) => k.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      <label className="field">
        {t("studio.wb.content")}
        <textarea
          rows={3}
          value={npc.content}
          onChange={(e) => onChange({ ...npc, content: e.target.value })}
        />
      </label>
    </div>
  )
}
