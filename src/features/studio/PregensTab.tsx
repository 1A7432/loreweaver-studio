import { useTranslation } from "react-i18next"
import { useStudioStore } from "../../store/studio"
import type { ForgePregen, ForgeProject, Issue } from "./model"

function PregenRow({ pregen, issues }: { pregen: ForgePregen; issues: Issue[] }) {
  const { t } = useTranslation()
  const update = useStudioStore((s) => s.updatePregen)
  const remove = useStudioStore((s) => s.removePregen)
  const patch = (p: Partial<ForgePregen>) => update(pregen.uid, p)

  return (
    <div className="var-editor" data-uid={pregen.uid}>
      <div className="var-editor-grid">
        <label className="field">
          {t("studio.pregens.name")}
          <input value={pregen.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label className="field">
          {t("studio.pregens.concept")}
          <input
            value={pregen.concept}
            onChange={(e) => patch({ concept: e.target.value })}
            placeholder={t("studio.pregens.conceptPlaceholder")}
          />
        </label>
        <label className="field field-wide">
          {t("studio.pregens.notes")}
          <textarea rows={2} value={pregen.notes} onChange={(e) => patch({ notes: e.target.value })} />
        </label>
        <label className="field field-wide">
          {t("studio.pregens.skills")}
          <textarea
            rows={4}
            value={pregen.skillsText}
            onChange={(e) => patch({ skillsText: e.target.value })}
            placeholder={t("studio.pregens.skillsPlaceholder")}
            spellCheck={false}
          />
        </label>
        <button type="button" className="ghost-button var-remove" onClick={() => remove(pregen.uid)}>
          {t("studio.remove")}
        </button>
      </div>
      {issues.length > 0 ? (
        <ul className="issue-list">
          {issues.map((issue, i) => (
            <li key={i}>{t(`studio.err.${issue.key}`, issue.params)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default function PregensTab({
  project,
  issues,
}: {
  project: ForgeProject
  issues: Map<string, Issue[]>
}) {
  const { t } = useTranslation()
  const addPregen = useStudioStore((s) => s.addPregen)
  const pregens = project.pregens ?? []

  return (
    <div className="studio-form">
      <p className="studio-hint">{t("studio.pregens.hint")}</p>
      {pregens.map((pregen) => (
        <PregenRow key={pregen.uid} pregen={pregen} issues={issues.get(pregen.uid) ?? []} />
      ))}
      <button type="button" className="ghost-button" onClick={addPregen}>
        {t("studio.pregens.add")}
      </button>
    </div>
  )
}
