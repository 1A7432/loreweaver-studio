// The session report: the short scoreboard (`report` without arguments) shown here as the
// server wrote it, and the whole session as a page (`report {format: "html"}`). The page comes
// back as a reference — `data.media` — and is fetched by hash at once (the next page replaces
// it), verified natively, then saved or opened in the system browser; it never renders inside
// this window. The room admin also gets the reveal edition, which prints what was hidden from
// the players: it asks first.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars } from "loreweaver-protocol/v3"
import {
  reportFetch,
  reportOffer,
  reportOpen,
  safeReportName,
  saveReportAs,
  type ReportOffer,
} from "../../../lib/report"
import CommandFeedback from "../CommandFeedback"
import { useCommand, useCommandRunner, useOnline, useRole } from "../room"
import { transferErrorText } from "../transfer"
import ScreenShell from "./ScreenShell"

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "fetching"; readonly reveal: boolean }
  | { readonly kind: "ready"; readonly offer: ReportOffer }
  | { readonly kind: "failed"; readonly text: string }

export default function ReportScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const online = useOnline()
  const admin = useRole() === "admin"
  const canText = useCommand("report") !== null
  const canPage = useCommand("report", ["format"]) !== null
  const revealCommand = useCommand("report", ["format", "reveal"])
  const canReveal = admin && revealCommand !== null
  const scoreboard = useCommandRunner()
  const page = useCommandRunner()
  const [phase, setPhase] = useState<Phase>({ kind: "idle" })
  const [confirmReveal, setConfirmReveal] = useState(false)
  const [action, setAction] = useState<{ ok: boolean; text: string } | null>(null)

  const fetchPage = async (reveal: boolean) => {
    setConfirmReveal(false)
    setAction(null)
    setPhase({ kind: "fetching", reveal })
    const result = await page.run("report", reveal ? { format: "html", reveal: true } : { format: "html" })
    const offer = reportOffer(result)
    if (offer === null) {
      // A refusal (or no answer) is already shown by the runner's feedback.
      setPhase({ kind: "idle" })
      return
    }
    try {
      await reportFetch(offer.hash)
      setPhase({ kind: "ready", offer })
    } catch (error) {
      setPhase({ kind: "failed", text: transferErrorText(error, t) })
    }
  }

  const save = async (offer: ReportOffer) => {
    setAction(null)
    try {
      const path = await saveReportAs(offer)
      if (path !== null) setAction({ ok: true, text: t("play.report.saved", { path }) })
    } catch {
      setAction({ ok: false, text: t("play.report.actionFailed") })
    }
  }

  const open = async (offer: ReportOffer) => {
    setAction(null)
    try {
      await reportOpen(offer.hash, safeReportName(offer.name, offer.hash))
    } catch {
      setAction({ ok: false, text: t("play.report.actionFailed") })
    }
  }

  const busy = phase.kind === "fetching" || page.pending
  return (
    <ScreenShell title={t("play.menu.report")} onBack={onBack}>
      {!canText && !canPage ? <p className="placeholder">{t("play.report.unavailable")}</p> : null}
      {canText ? (
        <div className="play-form">
          <h4 className="play-form-title">{t("play.report.scoreboard")}</h4>
          <button
            type="button"
            className="ghost-button"
            disabled={!online || scoreboard.pending}
            onClick={() => void scoreboard.run("report")}
          >
            {t("play.report.showScoreboard")}
          </button>
          <CommandFeedback feedback={scoreboard.feedback} onDismiss={scoreboard.dismiss} />
        </div>
      ) : null}
      {canPage ? (
        <div className="play-form">
          <h4 className="play-form-title">{t("play.report.page")}</h4>
          <p className="studio-hint">{t("play.report.pageHint")}</p>
          <div className="chip-row">
            <button
              type="button"
              className="primary-button"
              disabled={!online || busy}
              onClick={() => void fetchPage(false)}
            >
              {t("play.report.makePage")}
            </button>
            {canReveal && !confirmReveal ? (
              <button
                type="button"
                className="ghost-button"
                disabled={!online || busy}
                onClick={() => setConfirmReveal(true)}
              >
                {t("play.report.makeReveal")}
              </button>
            ) : null}
          </div>
          {confirmReveal ? (
            <div className="report-notice report-notice-reveal" role="alert">
              <p className="report-notice-warn">{t("play.report.revealWarning")}</p>
              <div className="chip-row">
                <button
                  type="button"
                  className="primary-button"
                  disabled={!online || busy}
                  onClick={() => void fetchPage(true)}
                >
                  {t("play.report.revealConfirm")}
                </button>
                <button type="button" className="ghost-button" onClick={() => setConfirmReveal(false)}>
                  {t("play.report.revealCancel")}
                </button>
              </div>
            </div>
          ) : null}
          {phase.kind === "fetching" ? (
            <p className="play-busy" role="status">
              {phase.reveal ? t("play.report.fetchingReveal") : t("play.report.fetching")}
            </p>
          ) : null}
          <CommandFeedback feedback={page.feedback} onDismiss={page.dismiss} />
          {phase.kind === "failed" ? (
            <p className="connect-error" role="alert">
              {t("play.report.failed", { error: phase.text })}
            </p>
          ) : null}
          {phase.kind === "ready" ? (
            <div
              className={
                phase.offer.edition === "reveal" ? "report-notice report-notice-reveal" : "report-notice"
              }
            >
              <p className="report-notice-title">
                {phase.offer.edition === "reveal" ? t("play.report.readyReveal") : t("play.report.ready")}
                {phase.offer.edition === "reveal" ? (
                  <span className="report-badge">{t("play.report.spoilerBadge")}</span>
                ) : null}
              </p>
              <p className="report-notice-name">
                {stripControlChars(safeReportName(phase.offer.name, phase.offer.hash))}
              </p>
              <div className="chip-row">
                <button type="button" className="primary-button" onClick={() => void save(phase.offer)}>
                  {t("play.report.save")}
                </button>
                <button type="button" className="ghost-button" onClick={() => void open(phase.offer)}>
                  {t("play.report.open")}
                </button>
              </div>
            </div>
          ) : null}
          {action ? (
            <p className={action.ok ? "studio-hint" : "connect-error"} role={action.ok ? "status" : "alert"}>
              {action.text}
            </p>
          ) : null}
        </div>
      ) : null}
    </ScreenShell>
  )
}
