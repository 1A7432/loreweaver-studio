import { useTranslation } from "react-i18next"
import { useConnectionStore } from "../../store/connection"

export default function StatusPill() {
  const { t } = useTranslation()
  const status = useConnectionStore((s) => s.status)
  const attempt = useConnectionStore((s) => s.attempt)
  return (
    <span className={`status-pill status-${status}`} data-status={status}>
      <span className="status-dot" aria-hidden="true" />
      {t(`connect.status.${status}`)}
      {status === "reconnecting" && attempt > 0 ? ` (${t("connect.attempt", { n: attempt })})` : null}
    </span>
  )
}
