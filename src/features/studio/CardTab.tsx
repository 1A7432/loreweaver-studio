import { useTranslation } from "react-i18next"
import { useStudioStore } from "../../store/studio"
import type { ForgeProject } from "./model"

const FIELDS = [
  { key: "description", rows: 6 },
  { key: "personality", rows: 3 },
  { key: "scenario", rows: 3 },
  { key: "firstMes", rows: 4 },
  { key: "mesExample", rows: 4 },
  { key: "creatorNotes", rows: 2 },
] as const

export default function CardTab({ project }: { project: ForgeProject }) {
  const { t } = useTranslation()
  const updateProject = useStudioStore((s) => s.updateProject)

  return (
    <div className="studio-form">
      <label className="field">
        {t("studio.card.name")}
        <input value={project.name} onChange={(e) => updateProject({ name: e.target.value })} />
      </label>
      <label className="field">
        {t("studio.card.tags")}
        <input
          value={project.tags}
          onChange={(e) => updateProject({ tags: e.target.value })}
          placeholder={t("studio.card.tagsPlaceholder")}
        />
      </label>
      {FIELDS.map(({ key, rows }) => (
        <label key={key} className="field">
          {t(`studio.card.${key}`)}
          <textarea
            rows={rows}
            value={project[key]}
            onChange={(e) => updateProject({ [key]: e.target.value })}
          />
        </label>
      ))}
    </div>
  )
}
