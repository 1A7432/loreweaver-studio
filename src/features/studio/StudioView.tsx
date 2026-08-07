import { useState } from "react"
import { useTranslation } from "react-i18next"
import { saveBinaryFile, saveTextFile } from "../../lib/files"
import { pickJsonFile, pickPngFile } from "../../lib/native"
import { useActiveProject, useStudioStore, type StudioTab, type StudioViewName } from "../../store/studio"
import { isRecord } from "./split/charcard"
import { looksLikeLorecard, lorecardToProject } from "./split/lorecard"
import AiPanel from "./ai/AiPanel"
import AiSettingsDialog from "./ai/AiSettingsDialog"
import PresetManagerDialog from "./ai/PresetManagerDialog"
import { aiReady, useAiStore } from "./ai/provider"
import CardTab from "./CardTab"
import { exportFileName, exportNativeBundle, exportSillyTavernCard } from "./exporters"
import { embedCardIntoPng } from "./pngCard"
import HooksTab from "./HooksTab"
import { validateProject } from "./model"
import PackWizard from "./pack/PackWizard"
import PregensTab from "./PregensTab"
import SplitView from "./split/SplitView"
import VariablesTab from "./VariablesTab"
import WizardView from "./wizard/WizardView"
import WorldbookTab from "./WorldbookTab"

const TABS: StudioTab[] = ["card", "variables", "worldbook", "pregens", "hooks"]
const VIEWS: StudioViewName[] = ["forge", "wizard", "split", "pack"]

export default function StudioView() {
  const { t } = useTranslation()
  const project = useActiveProject()
  const projects = useStudioStore((s) => s.projects)
  const tab = useStudioStore((s) => s.tab)
  const view = useStudioStore((s) => s.view)
  const setTab = useStudioStore((s) => s.setTab)
  const setView = useStudioStore((s) => s.setView)
  const createProject = useStudioStore((s) => s.createProject)
  const deleteProject = useStudioStore((s) => s.deleteProject)
  const selectProject = useStudioStore((s) => s.selectProject)
  const importProject = useStudioStore((s) => s.importProject)
  const aiSettings = useAiStore()
  const [notice, setNotice] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)

  const validation = project ? validateProject(project) : null

  const doExport = async (flavor: "native" | "st") => {
    if (!project || !validation) return
    const payload =
      flavor === "native"
        ? exportNativeBundle(project, validation.specs)
        : exportSillyTavernCard(project, validation.specs)
    const outcome = await saveTextFile(exportFileName(project, flavor), JSON.stringify(payload, null, 2))
    setNotice(t(`studio.save.${outcome}`))
  }

  const doExportPng = async () => {
    if (!project || !validation) return
    const base = await pickPngFile()
    if (base === null) return
    try {
      // Toolbar flavor on purpose: default options = secrets stripped — the
      // safe-to-circulate tavern card (the wizard finish owns the release flavor).
      const png = embedCardIntoPng(base.bytes, exportSillyTavernCard(project, validation.specs))
      const name = exportFileName(project, "st").replace(/\.json$/, ".png")
      const outcome = await saveBinaryFile(name, png, "png")
      setNotice(t(`studio.save.${outcome}`))
    } catch {
      setNotice(t("studio.exportPngInvalid"))
    }
  }

  const doImportNative = async () => {
    const file = await pickJsonFile()
    if (file === null) return
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8").decode(file.bytes))
      if (!isRecord(parsed) || !looksLikeLorecard(parsed)) {
        setNotice(t("studio.importNativeBad"))
        return
      }
      const { project: imported, warnings } = lorecardToProject(parsed)
      importProject(imported)
      setNotice(
        warnings.length > 0
          ? t("studio.importNativeWarn", { name: imported.name, n: warnings.length })
          : t("studio.importNativeOk", { name: imported.name }),
      )
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="studio">
      <div className="studio-bar">
        <nav className="studio-views" aria-label={t("studio.viewsLabel")}>
          {VIEWS.map((name) => (
            <button
              key={name}
              type="button"
              className={name === view ? "mode-tab active" : "mode-tab"}
              onClick={() => setView(name)}
            >
              {t(`studio.views.${name}`)}
            </button>
          ))}
        </nav>
        <div className="header-spacer" />
        <button
          type="button"
          className="ghost-button"
          onClick={() => setAiOpen(true)}
          disabled={!aiReady(aiSettings)}
          title={aiReady(aiSettings) ? undefined : t("studio.ai.needsSetup")}
        >
          {t("studio.ai.open")}
        </button>
        <button type="button" className="ghost-button" onClick={() => setPresetsOpen(true)}>
          {t("studio.ai.presets.open")}
        </button>
        <button type="button" className="ghost-button" onClick={() => setSettingsOpen(true)}>
          {t("studio.ai.settings")}
        </button>
      </div>

      {view === "wizard" ? <WizardView /> : null}
      {view === "split" ? <SplitView /> : null}
      {view === "pack" ? <PackWizard /> : null}

      {view === "forge" ? (
        <>
          <div className="studio-bar">
            <select
              className="studio-project-select"
              aria-label={t("studio.project")}
              value={project?.uid ?? ""}
              onChange={(e) => selectProject(e.target.value)}
            >
              {projects.length === 0 ? <option value="">{t("studio.noProjects")}</option> : null}
              {projects.map((p) => (
                <option key={p.uid} value={p.uid}>
                  {p.name || t("studio.untitled")}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ghost-button"
              onClick={() => createProject(t("studio.untitled"))}
            >
              {t("studio.newProject")}
            </button>
            <button type="button" className="ghost-button" onClick={() => void doImportNative()}>
              {t("studio.importNative")}
            </button>
            {project ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  if (window.confirm(t("studio.deleteConfirm", { name: project.name }))) {
                    deleteProject(project.uid)
                  }
                }}
              >
                {t("studio.deleteProject")}
              </button>
            ) : null}
            <div className="header-spacer" />
            {validation ? (
              <span
                className={validation.issueCount > 0 ? "studio-issues has-issues" : "studio-issues"}
                role="status"
              >
                {validation.issueCount > 0
                  ? t("studio.issues", { n: validation.issueCount })
                  : t("studio.clean")}
              </span>
            ) : null}
            {project ? (
              <>
                <button type="button" className="ghost-button" onClick={() => void doExport("native")}>
                  {t("studio.exportNative")}
                </button>
                <button type="button" className="ghost-button" onClick={() => void doExport("st")}>
                  {t("studio.exportSt")}
                </button>
                <button type="button" className="ghost-button" onClick={() => void doExportPng()}>
                  {t("studio.exportPng")}
                </button>
              </>
            ) : null}
          </div>

          {notice ? (
            <p className="studio-notice" role="status">
              {notice}
            </p>
          ) : null}

          {project ? (
            <>
              <nav className="studio-tabs" aria-label={t("studio.tabsLabel")}>
                {TABS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={name === tab ? "mode-tab active" : "mode-tab"}
                    onClick={() => setTab(name)}
                  >
                    {t(`studio.tabs.${name}`)}
                  </button>
                ))}
              </nav>
              <div className="studio-body">
                {tab === "card" ? <CardTab project={project} /> : null}
                {tab === "variables" ? (
                  <VariablesTab project={project} issues={validation?.variables ?? new Map()} />
                ) : null}
                {tab === "worldbook" ? (
                  <WorldbookTab project={project} issues={validation?.lorebook ?? new Map()} />
                ) : null}
                {tab === "pregens" ? (
                  <PregensTab project={project} issues={validation?.pregens ?? new Map()} />
                ) : null}
                {tab === "hooks" ? <HooksTab project={project} /> : null}
              </div>
            </>
          ) : (
            <div className="studio-empty">
              <p className="placeholder">{t("studio.emptyHint")}</p>
            </div>
          )}
        </>
      ) : null}

      {aiOpen ? (
        <AiPanel
          onClose={() => setAiOpen(false)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenPresets={() => setPresetsOpen(true)}
        />
      ) : null}
      {settingsOpen ? <AiSettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {presetsOpen ? <PresetManagerDialog onClose={() => setPresetsOpen(false)} /> : null}
    </div>
  )
}
