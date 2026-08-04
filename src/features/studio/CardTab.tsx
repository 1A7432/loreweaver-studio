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
      <AlternateGreetings project={project} />
    </div>
  )
}

/** ST `alternate_greetings`: standalone alternate opening scenes. */
function AlternateGreetings({ project }: { project: ForgeProject }) {
  const { t } = useTranslation()
  const updateProject = useStudioStore((s) => s.updateProject)
  const greetings = project.alternateGreetings ?? []
  return (
    <div className="card-alt-greetings">
      <span className="field-label">{t("studio.card.altGreetings")}</span>
      {greetings.map((greeting, index) => (
        <div key={index} className="card-alt-greeting">
          <textarea
            rows={4}
            value={greeting}
            aria-label={t("studio.card.altGreetingN", { n: index + 1 })}
            onChange={(e) =>
              updateProject({
                alternateGreetings: greetings.map((g, i) => (i === index ? e.target.value : g)),
              })
            }
          />
          <button
            type="button"
            className="ghost-button"
            onClick={() => updateProject({ alternateGreetings: greetings.filter((_, i) => i !== index) })}
          >
            {t("studio.remove")}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost-button"
        onClick={() => updateProject({ alternateGreetings: [...greetings, ""] })}
      >
        {t("studio.card.addAltGreeting")}
      </button>
    </div>
  )
}
