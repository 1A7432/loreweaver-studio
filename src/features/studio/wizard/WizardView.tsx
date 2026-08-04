// The staged co-creation wizard view: session start page, stage navigation
// with confirmation/stale state, the consistency audit, and the active stage
// panel. The forge project stays the source of truth — this view only drives
// the walk and shows where every confirmed piece landed.

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { saveBinaryFile, saveTextFile } from "../../../lib/files"
import { pickPngFile } from "../../../lib/native"
import { useActiveProject, useStudioStore } from "../../../store/studio"
import { exportFileName, exportNativeBundle, exportSillyTavernCard } from "../exporters"
import { validateProject, type ForgeProject } from "../model"
import { embedCardIntoPng } from "../pngCard"
import { auditContract } from "./contract"
import StagePanel from "./StagePanel"
import { visibleStages } from "./stages"
import { useWizardSession, useWizardStore, type WizardSession } from "./store"
import { layerReport } from "./tokens"

/** Shown once every visible stage is confirmed (or, for optional ones,
 * skipped): the wizard's exit — export both flavors, or hand off to the pack
 * pipeline. The ST export here is the TAVERN RELEASE flavor: keeper-only
 * entries stay in, the [InitVar] YAML rides verbatim, update rules become a
 * worldbook entry — a card that stands on its own in stock SillyTavern. */
function FinishPanel({ project, session }: { project: ForgeProject; session: WizardSession }) {
  const { t } = useTranslation()
  const setView = useStudioStore((s) => s.setView)
  const [notice, setNotice] = useState<string | null>(null)

  const varsDraft = session.records.variables?.draft
  const initvarSource = varsDraft?.stage === "variables" ? varsDraft.initvarYaml : undefined
  const updateRules = varsDraft?.stage === "variables" ? varsDraft.updateRules : undefined
  const report = layerReport(project.lorebook)

  const releaseCard = () => {
    const { specs } = validateProject(project)
    return exportSillyTavernCard(project, specs, { includeSecret: true, initvarSource, updateRules })
  }

  const doExport = async (flavor: "native" | "st") => {
    const payload =
      flavor === "native" ? exportNativeBundle(project, validateProject(project).specs) : releaseCard()
    const outcome = await saveTextFile(exportFileName(project, flavor), JSON.stringify(payload, null, 2))
    setNotice(t(`studio.save.${outcome}`))
  }

  const doExportPng = async () => {
    const base = await pickPngFile()
    if (base === null) return
    try {
      const png = embedCardIntoPng(base.bytes, releaseCard())
      const name = exportFileName(project, "st").replace(/\.json$/, ".png")
      const outcome = await saveBinaryFile(name, png, "png")
      setNotice(t(`studio.save.${outcome}`))
    } catch {
      setNotice(t("studio.wizard.finish.pngInvalid"))
    }
  }

  return (
    <section className="wizard-finish" aria-label={t("studio.wizard.finish.title")}>
      <h3>{t("studio.wizard.finish.title")}</h3>
      <p className="studio-hint">
        {t("studio.wizard.finish.summary", {
          lore: project.lorebook.length,
          vars: project.variables.length,
          tokens: report.constantTokens,
        })}
      </p>
      <div className="dialog-row">
        <button type="button" className="primary-button" onClick={() => void doExport("st")}>
          {t("studio.wizard.finish.exportSt")}
        </button>
        <button type="button" className="ghost-button" onClick={() => void doExportPng()}>
          {t("studio.wizard.finish.exportPng")}
        </button>
        <button type="button" className="ghost-button" onClick={() => void doExport("native")}>
          {t("studio.wizard.finish.exportNative")}
        </button>
        <button type="button" className="ghost-button" onClick={() => setView("pack")}>
          {t("studio.wizard.finish.toPack")}
        </button>
      </div>
      <p className="studio-hint">{t("studio.wizard.finish.stHint")}</p>
      {notice !== null ? (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  )
}

export default function WizardView() {
  const { t } = useTranslation()
  const project = useActiveProject()
  const createProject = useStudioStore((s) => s.createProject)
  const session = useWizardSession(project?.uid ?? null)
  const begin = useWizardStore((s) => s.begin)
  const end = useWizardStore((s) => s.end)
  const setNsfw = useWizardStore((s) => s.setNsfw)
  const gotoStage = useWizardStore((s) => s.gotoStage)
  const [nsfwStart, setNsfwStart] = useState(false)

  const audit = useMemo(
    () =>
      project !== null && session !== null
        ? auditContract(project, session.contract, session.nsfwEnabled)
        : null,
    [project, session],
  )

  const startOnNew = () => {
    createProject(t("studio.untitled"))
    const uid = useStudioStore.getState().activeUid
    if (uid !== null) begin(uid, nsfwStart)
  }

  if (project === null || session === null) {
    return (
      <div className="wizard-start">
        <h2>{t("studio.wizard.startTitle")}</h2>
        <p className="studio-hint">{t("studio.wizard.startHint")}</p>
        <label className="wizard-check">
          <input type="checkbox" checked={nsfwStart} onChange={(e) => setNsfwStart(e.target.checked)} />
          {t("studio.wizard.nsfwToggle")}
        </label>
        <p className="studio-hint">{t("studio.wizard.nsfwHint")}</p>
        <div className="dialog-row">
          <button type="button" className="primary-button" onClick={startOnNew}>
            {t("studio.wizard.startNew")}
          </button>
          {project !== null ? (
            <button type="button" className="ghost-button" onClick={() => begin(project.uid, nsfwStart)}>
              {t("studio.wizard.startCurrent", { name: project.name || t("studio.untitled") })}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const stages = visibleStages(session.nsfwEnabled)
  const finished = stages.every(
    (meta) =>
      session.contract.confirmedAt[meta.id] !== undefined ||
      (meta.optional && session.skipped[meta.id] === true),
  )

  return (
    <div className="wizard-layout">
      <nav className="wizard-nav" aria-label={t("studio.wizard.navLabel")}>
        <ol>
          {stages.map((meta, index) => {
            const confirmed = session.contract.confirmedAt[meta.id] !== undefined
            const skipped = session.skipped[meta.id] === true && !confirmed
            const stale = audit?.staleStages.includes(meta.id) ?? false
            const classes = [
              "wizard-nav-item",
              meta.id === session.stage ? "active" : "",
              confirmed ? "confirmed" : "",
            ]
              .filter(Boolean)
              .join(" ")
            return (
              <li key={meta.id}>
                <button type="button" className={classes} onClick={() => gotoStage(project.uid, meta.id)}>
                  <span className="wizard-nav-index">{index + 1}</span>
                  <span className="wizard-nav-title">{t(`studio.wizard.stages.${meta.id}.title`)}</span>
                  {confirmed ? <span className="wizard-nav-mark">✓</span> : null}
                  {skipped ? <span className="wizard-nav-mark">{t("studio.wizard.skippedMark")}</span> : null}
                  {stale ? (
                    <span className="wizard-nav-mark stale" title={t("studio.wizard.staleHint")}>
                      ⚠
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ol>
        <label className="wizard-check">
          <input
            type="checkbox"
            checked={session.nsfwEnabled}
            onChange={(e) => setNsfw(project.uid, e.target.checked)}
          />
          {t("studio.wizard.nsfwToggle")}
        </label>
        <button
          type="button"
          className="ghost-button"
          onClick={() => {
            if (window.confirm(t("studio.wizard.endConfirm"))) end(project.uid)
          }}
        >
          {t("studio.wizard.endSession")}
        </button>
      </nav>

      <div className="wizard-main">
        {audit !== null && audit.missing.length > 0 ? (
          <p className="studio-notice" role="alert">
            {t("studio.wizard.auditMissing", { n: audit.missing.length })}
          </p>
        ) : null}
        {audit !== null && audit.staleStages.length > 0 ? (
          <p className="studio-notice" role="status">
            {t("studio.wizard.auditStale", {
              stages: audit.staleStages.map((id) => t(`studio.wizard.stages.${id}.title`)).join(" · "),
            })}
          </p>
        ) : null}
        {finished ? <FinishPanel project={project} session={session} /> : null}
        <StagePanel key={session.stage} session={session} project={project} />
      </div>
    </div>
  )
}
