import { useTranslation } from "react-i18next"
import { useStudioStore } from "../../store/studio"
import type { ForgeProject } from "./model"

export default function HooksTab({ project }: { project: ForgeProject }) {
  const { t } = useTranslation()
  const updateProject = useStudioStore((s) => s.updateProject)

  return (
    <div className="studio-form hooks-form">
      <p className="studio-hint">{t("studio.hooks.hint")}</p>
      <textarea
        className="hooks-editor"
        aria-label={t("studio.tabs.hooks")}
        value={project.hooks}
        onChange={(e) => updateProject({ hooks: e.target.value })}
        spellCheck={false}
      />
    </div>
  )
}
