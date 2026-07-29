import { useTranslation } from "react-i18next"
import { useConnectionStore } from "../../store/connection"
import InputBox from "./InputBox"
import NarrativeLog from "./NarrativeLog"
import StatePanel from "./StatePanel"
import TurnStatus from "./TurnStatus"

function StatusPill() {
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

export default function SessionView() {
  const { t } = useTranslation()
  const welcome = useConnectionStore((s) => s.welcome)
  const disconnect = useConnectionStore((s) => s.disconnect)

  return (
    <div className="session">
      <div className="chronicle-pane">
        <header className="session-head">
          <span className="session-room">{welcome ? `${welcome.room} · ${welcome.you.name}` : "…"}</span>
          <StatusPill />
          <button type="button" className="ghost-button" onClick={() => void disconnect()}>
            {t("connect.disconnect")}
          </button>
        </header>
        <TurnStatus />
        <NarrativeLog />
        <InputBox />
      </div>
      <aside className="desk-pane">
        <StatePanel />
      </aside>
    </div>
  )
}
