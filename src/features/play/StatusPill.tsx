import { useTranslation } from "react-i18next"
import { displayStatus } from "../../lib/connection"
import { useConnectionState } from "../../store/connection"

/** Connecting · online · reconnecting (with the attempt) · offline — read from
 * the connection owner, not from any store copy. */
export default function StatusPill() {
  const { t } = useTranslation()
  const state = useConnectionState()
  const status = displayStatus(state)
  return (
    <span className={`status-pill status-${status}`} data-status={status}>
      <span className="status-dot" aria-hidden="true" />
      {t(`connect.status.${status}`)}
      {status === "reconnecting" && state.attempt > 0
        ? ` (${t("connect.attempt", { n: state.attempt })})`
        : null}
    </span>
  )
}
