import { useTranslation } from "react-i18next"
import { useConnectionStore } from "../../store/connection"
import InputBox from "./InputBox"
import NarrativeLog from "./NarrativeLog"
import { PanelSidebar, PanelTray } from "./panels/PanelDeck"
import PanelMenu from "./panels/PanelMenu"
import PanelModalHost from "./panels/PanelModalHost"
import PanelNotice from "./panels/PanelNotice"
import StatePanel from "./StatePanel"
import StatusPill from "./StatusPill"
import TurnStatus from "./TurnStatus"

export default function SessionView({ onMenu }: { onMenu?: () => void }) {
  const { t } = useTranslation()
  const welcome = useConnectionStore((s) => s.welcome)
  const disconnect = useConnectionStore((s) => s.disconnect)

  return (
    <div className="session">
      <div className="chronicle-pane">
        <header className="session-head">
          {onMenu ? (
            <button type="button" className="ghost-button" onClick={onMenu}>
              {t("play.menuButton")}
            </button>
          ) : null}
          <span className="session-room">{welcome ? `${welcome.room} · ${welcome.you.name}` : "…"}</span>
          <PanelMenu />
          <StatusPill />
          <button type="button" className="ghost-button" onClick={() => void disconnect()}>
            {t("connect.disconnect")}
          </button>
        </header>
        <PanelNotice />
        <TurnStatus />
        <NarrativeLog />
        <PanelTray />
        <InputBox />
      </div>
      <aside className="desk-pane">
        <PanelSidebar />
        <StatePanel />
      </aside>
      <PanelModalHost />
    </div>
  )
}
