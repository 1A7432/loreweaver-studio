// Session-report offers (protocol 2.4), one line each above the chronicle.
//
// Non-blocking by design: the table keeps playing while the file waits to be
// saved. The reveal edition is the keeper's debrief — every secret of the
// module — so it wears its own colour, a spoiler badge and a plain warning;
// whoever asked for it must not mistake it for the copy they can pass around.
// The HTML is never shown here (protocol rule): Save writes the verified file,
// Open hands it to the system browser.

import { useTranslation } from "react-i18next"
import { useReportStore, type ReportOffer } from "../../store/report"

function errorText(t: (key: string, options?: Record<string, unknown>) => string, error: string): string {
  return error.startsWith("play.report.err.") ? t(error) : error
}

function ReportRow({ offer }: { offer: ReportOffer }) {
  const { t } = useTranslation()
  const save = useReportStore((s) => s.save)
  const openInBrowser = useReportStore((s) => s.openInBrowser)
  const dismiss = useReportStore((s) => s.dismiss)
  const reveal = offer.variant === "reveal"
  const ready = offer.phase === "ready"

  const title =
    offer.phase === "fetching"
      ? t(reveal ? "play.report.fetchingReveal" : "play.report.fetching")
      : offer.phase === "error"
        ? t("play.report.failed", { error: errorText(t, offer.error ?? "") })
        : t(reveal ? "play.report.readyReveal" : "play.report.ready")

  return (
    <div
      className={`report-notice${reveal ? " report-notice-reveal" : ""}${offer.phase === "error" ? " report-notice-error" : ""}`}
      data-variant={offer.variant}
      role="status"
      aria-live="polite"
    >
      {reveal ? <span className="report-badge">{t("play.report.spoilerBadge")}</span> : null}
      <span className="report-notice-text">
        <span className="report-notice-title">{title}</span>
        <span className="report-notice-name">{offer.fileName}</span>
        {reveal ? <span className="report-notice-warn">{t("play.report.revealWarning")}</span> : null}
        {offer.savedPath ? (
          <span className="report-notice-detail">{t("play.report.saved", { path: offer.savedPath })}</span>
        ) : null}
        {offer.actionError ? (
          <span className="report-notice-detail report-notice-fail">
            {t("play.report.actionFailed", { error: errorText(t, offer.actionError) })}
          </span>
        ) : null}
      </span>
      {ready ? (
        <>
          <button
            type="button"
            className="primary-button"
            disabled={offer.busy}
            onClick={() => void save(offer.hash)}
          >
            {t("play.report.save")}
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={offer.busy}
            onClick={() => void openInBrowser(offer.hash)}
          >
            {t("play.report.open")}
          </button>
        </>
      ) : null}
      <button type="button" className="ghost-button" onClick={() => dismiss(offer.hash)}>
        {t("play.report.dismiss")}
      </button>
    </div>
  )
}

export default function ReportNotice() {
  const { t } = useTranslation()
  const offers = useReportStore((s) => s.offers)
  if (offers.length === 0) return null
  return (
    <section className="report-notices" aria-label={t("play.report.region")}>
      {offers.map((offer) => (
        <ReportRow key={offer.hash} offer={offer} />
      ))}
    </section>
  )
}
