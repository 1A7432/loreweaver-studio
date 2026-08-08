import { useTranslation } from "react-i18next"
import { useStudioStore } from "../../store/studio"
import type { ForgeLoreEntry, ForgeProject, Issue, LorePosition, SelectiveLogic } from "./model"

const LOGICS: SelectiveLogic[] = ["and_any", "and_all", "not_any", "not_all"]
const POSITIONS: LorePosition[] = ["", "before", "after"]

function numeric(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

function EntryEditor({ entry, issues }: { entry: ForgeLoreEntry; issues: Issue[] }) {
  const { t } = useTranslation()
  const update = useStudioStore((s) => s.updateLoreEntry)
  const remove = useStudioStore((s) => s.removeLoreEntry)
  const patch = (p: Partial<ForgeLoreEntry>) => update(entry.uid, p)

  return (
    <div className="wb-editor">
      <label className="field">
        {t("studio.wb.title")}
        <input value={entry.title} onChange={(e) => patch({ title: e.target.value })} />
      </label>
      <label className="field">
        {t("studio.wb.keys")}
        <input
          value={entry.keys}
          onChange={(e) => patch({ keys: e.target.value })}
          placeholder={t("studio.wb.keysPlaceholder")}
          spellCheck={false}
        />
      </label>
      <label className="field">
        {t("studio.wb.content")}
        <textarea rows={7} value={entry.content} onChange={(e) => patch({ content: e.target.value })} />
      </label>
      <label className="field">
        {t("studio.wb.condition")}
        <input
          value={entry.condition}
          onChange={(e) => patch({ condition: e.target.value })}
          // i18n-exempt: a condexpr sample — code, identical in every locale.
          placeholder="suspicion >= 5 && !alerted"
          spellCheck={false}
        />
      </label>
      <label className="field">
        {t("studio.wb.stableId")}
        <input
          value={entry.stableId ?? ""}
          onChange={(e) => patch({ stableId: e.target.value })}
          placeholder={t("studio.wb.stableIdPlaceholder")}
          spellCheck={false}
        />
        <span className="studio-hint">{t("studio.wb.stableIdHint")}</span>
      </label>

      <div className="wb-flag-row">
        <label className="flag">
          <input
            type="checkbox"
            checked={entry.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          {t("studio.wb.enabled")}
        </label>
        <label className="flag">
          <input
            type="checkbox"
            checked={entry.constant}
            onChange={(e) => patch({ constant: e.target.checked })}
          />
          {t("studio.wb.constant")}
        </label>
        <label className="flag">
          <input
            type="checkbox"
            checked={entry.secret}
            onChange={(e) => patch({ secret: e.target.checked })}
          />
          {t("studio.wb.secret")}
        </label>
        <label className="flag">
          <input
            type="checkbox"
            checked={entry.caseSensitive}
            onChange={(e) => patch({ caseSensitive: e.target.checked })}
          />
          {t("studio.wb.caseSensitive")}
        </label>
        <label className="flag">
          <input
            type="checkbox"
            checked={entry.matchWholeWords}
            onChange={(e) => patch({ matchWholeWords: e.target.checked })}
          />
          {t("studio.wb.wholeWords")}
        </label>
      </div>

      <div className="wb-trigger-grid">
        <label className="field">
          {t("studio.wb.secondaryKeys")}
          <input
            value={entry.secondaryKeys}
            onChange={(e) => patch({ secondaryKeys: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label className="field field-narrow">
          {t("studio.wb.logic")}
          <select
            value={entry.selectiveLogic}
            onChange={(e) => patch({ selectiveLogic: e.target.value as SelectiveLogic })}
          >
            {LOGICS.map((logic) => (
              <option key={logic} value={logic}>
                {t(`studio.wb.logics.${logic}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-narrow">
          {t("studio.wb.position")}
          <select
            value={entry.position}
            onChange={(e) => patch({ position: e.target.value as LorePosition })}
          >
            {POSITIONS.map((position) => (
              <option key={position} value={position}>
                {t(`studio.wb.positions.${position === "" ? "none" : position}`)}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            ["priority", entry.priority],
            ["probability", entry.probability],
            ["scanDepth", entry.scanDepth],
            ["sticky", entry.sticky],
            ["cooldown", entry.cooldown],
            ["delay", entry.delay],
          ] as const
        ).map(([key, value]) => (
          <label key={key} className="field field-narrow">
            {t(`studio.wb.${key}`)}
            <input type="number" value={value} onChange={(e) => patch({ [key]: numeric(e.target.value) })} />
          </label>
        ))}
      </div>

      {issues.length > 0 ? (
        <ul className="issue-list">
          {issues.map((issue, i) => (
            <li key={i}>{t(`studio.err.${issue.key}`, issue.params)}</li>
          ))}
        </ul>
      ) : null}

      <button type="button" className="ghost-button" onClick={() => remove(entry.uid)}>
        {t("studio.wb.deleteEntry")}
      </button>
    </div>
  )
}

export default function WorldbookTab({
  project,
  issues,
}: {
  project: ForgeProject
  issues: Map<string, Issue[]>
}) {
  const { t } = useTranslation()
  const addLoreEntry = useStudioStore((s) => s.addLoreEntry)
  const selectLoreEntry = useStudioStore((s) => s.selectLoreEntry)
  const selectedUid = useStudioStore((s) => s.selectedEntryUid)
  const selected = project.lorebook.find((e) => e.uid === selectedUid) ?? null

  return (
    <div className="wb-layout">
      <div className="wb-list">
        <button type="button" className="ghost-button" onClick={addLoreEntry}>
          {t("studio.wb.addEntry")}
        </button>
        <ul>
          {project.lorebook.map((entry) => (
            <li key={entry.uid}>
              <button
                type="button"
                className={`wb-item${entry.uid === selectedUid ? " active" : ""}${entry.enabled ? "" : " disabled"}`}
                onClick={() => selectLoreEntry(entry.uid)}
              >
                {entry.secret ? "🔒 " : ""}
                {entry.title.trim() || t("studio.wb.untitledEntry")}
              </button>
            </li>
          ))}
        </ul>
        {project.lorebook.length === 0 ? <p className="studio-hint">{t("studio.wb.noEntries")}</p> : null}
      </div>
      <div className="wb-detail">
        {selected ? (
          <EntryEditor entry={selected} issues={issues.get(selected.uid) ?? []} />
        ) : (
          <p className="placeholder">{t("studio.wb.pickEntry")}</p>
        )}
      </div>
    </div>
  )
}
