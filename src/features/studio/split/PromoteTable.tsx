// The promotion table: one row per MVU leaf, author confirms/edits the typed
// draft. Rows re-validate through `buildSpec` live — exactly the validation
// the engine applies — so a red row here would also fail an engine import.

import { useTranslation } from "react-i18next"
import { buildSpec, type ForgeVariable, type VarKind, type VarVisibility } from "../model"
import type { PromotionDraft } from "./promote"

const KINDS: VarKind[] = ["number", "bool", "text", "enum"]
const VISIBILITIES: VarVisibility[] = ["player", "keeper"]

function previewValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text === undefined ? "" : text.length > 24 ? `${text.slice(0, 24)}…` : text
}

function PromoteRow({
  draft,
  onDraft,
}: {
  draft: PromotionDraft
  onDraft: (uid: string, patch: Partial<PromotionDraft>) => void
}) {
  const { t } = useTranslation()
  const patchVariable = (patch: Partial<ForgeVariable>) =>
    onDraft(draft.uid, { variable: { ...draft.variable, ...patch } })
  const validation = draft.include ? buildSpec(draft.variable) : null

  return (
    <div className={draft.include ? "promote-row" : "promote-row promote-row-skipped"}>
      <div className="promote-grid">
        <label className="promote-include">
          <input
            type="checkbox"
            checked={draft.include}
            onChange={(e) => onDraft(draft.uid, { include: e.target.checked })}
            aria-label={t("studio.split.promote.include")}
          />
        </label>
        <div className="promote-source">
          <code className="promote-path" title={draft.description || draft.mvuPath}>
            {draft.mvuPath}
          </code>
          <span className="promote-raw" title={draft.description}>
            {previewValue(draft.rawValue)}
          </span>
        </div>
        <input
          className="promote-id"
          value={draft.variable.id}
          onChange={(e) => patchVariable({ id: e.target.value })}
          placeholder="id"
          spellCheck={false}
          aria-label={t("studio.vars.id")}
          disabled={!draft.include}
        />
        <select
          value={draft.variable.kind}
          onChange={(e) => patchVariable({ kind: e.target.value as VarKind })}
          aria-label={t("studio.vars.kind")}
          disabled={!draft.include}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`studio.vars.kinds.${kind}`)}
            </option>
          ))}
        </select>
        <select
          value={draft.variable.visibility}
          onChange={(e) => patchVariable({ visibility: e.target.value as VarVisibility })}
          aria-label={t("studio.vars.visibility")}
          disabled={!draft.include}
        >
          {VISIBILITIES.map((visibility) => (
            <option key={visibility} value={visibility}>
              {t(`studio.vars.visibilities.${visibility}`)}
            </option>
          ))}
        </select>
        <input
          value={draft.variable.labelEn}
          onChange={(e) => patchVariable({ labelEn: e.target.value })}
          placeholder={t("studio.vars.labelEn")}
          disabled={!draft.include}
        />
        <input
          value={draft.variable.labelZh}
          onChange={(e) => patchVariable({ labelZh: e.target.value })}
          placeholder={t("studio.vars.labelZh")}
          disabled={!draft.include}
        />
        {draft.variable.kind === "number" ? (
          <>
            <input
              className="promote-narrow"
              value={draft.variable.minimum}
              onChange={(e) => patchVariable({ minimum: e.target.value })}
              placeholder={t("studio.vars.min")}
              disabled={!draft.include}
            />
            <input
              className="promote-narrow"
              value={draft.variable.maximum}
              onChange={(e) => patchVariable({ maximum: e.target.value })}
              placeholder={t("studio.vars.max")}
              disabled={!draft.include}
            />
          </>
        ) : null}
        <input
          className="promote-narrow"
          value={draft.variable.defaultValue}
          onChange={(e) => patchVariable({ defaultValue: e.target.value })}
          placeholder={t("studio.vars.default")}
          disabled={!draft.include}
        />
        {draft.variable.kind === "enum" ? (
          <input
            className="promote-options"
            value={draft.variable.options.replace(/\n/g, ", ")}
            onChange={(e) => patchVariable({ options: e.target.value })}
            placeholder={t("studio.vars.options")}
            disabled={!draft.include}
          />
        ) : null}
      </div>
      {draft.notes.length > 0 ? (
        <div className="promote-notes">
          {draft.notes.map((note) => (
            <span key={note} className="promote-note">
              {t(`studio.split.note.${note}`)}
            </span>
          ))}
        </div>
      ) : null}
      {validation !== null && validation.errors.length > 0 ? (
        <ul className="issue-list">
          {validation.errors.map((issue, index) => (
            <li key={index}>{t(`studio.err.${issue.key}`, issue.params)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default function PromoteTable({
  drafts,
  truncated,
  onDraft,
  onAiFill,
  aiBusy,
  aiEnabled,
}: {
  drafts: PromotionDraft[]
  truncated: boolean
  onDraft: (uid: string, patch: Partial<PromotionDraft>) => void
  onAiFill?: () => void
  aiBusy?: boolean
  aiEnabled?: boolean
}) {
  const { t } = useTranslation()
  if (drafts.length === 0) {
    return <p className="placeholder">{t("studio.split.promote.empty")}</p>
  }
  return (
    <div className="promote-table">
      <div className="promote-toolbar">
        <span className="studio-hint">{t("studio.split.promote.hint")}</span>
        {onAiFill ? (
          <button
            type="button"
            className="ghost-button"
            onClick={onAiFill}
            disabled={!aiEnabled || aiBusy}
            title={aiEnabled ? undefined : t("studio.ai.needsSetup")}
          >
            {aiBusy ? t("studio.ai.working") : t("studio.split.promote.aiFill")}
          </button>
        ) : null}
      </div>
      {truncated ? (
        <p className="studio-notice" role="status">
          {t("studio.split.promote.truncated")}
        </p>
      ) : null}
      {drafts.map((draft) => (
        <PromoteRow key={draft.uid} draft={draft} onDraft={onDraft} />
      ))}
    </div>
  )
}
