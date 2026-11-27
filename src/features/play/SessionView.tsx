// The game screen: the story on the left (log, Keeper activity, notices, the tray panels
// and the input line), the desk on the right (sidebar panels, the state cards, the room's
// pictures and sound), the overlay panel above both. It also keeps the session subscribed to the views the room's
// panels read, for as long as it is open.

import { useTranslation } from "react-i18next"
import { useSessionSnapshot } from "../../store/connection"
import { quitTable } from "../../store/hostLocal"
import AudioDeck, { AudioUnlockNotice } from "./AudioDeck"
import InputBox from "./InputBox"
import MediaDeck from "./MediaDeck"
import NarrativeLog from "./NarrativeLog"
import NoticeLines from "./NoticeLines"
import { PanelSidebar, PanelTray } from "./panels/PanelDeck"
import { usePanelList } from "./panels/panelList"
import PanelMenu from "./panels/PanelMenu"
import PanelModalHost from "./panels/PanelModalHost"
import PanelNotice from "./panels/PanelNotice"
import { usePanelViews } from "./room"
import StatePanel from "./StatePanel"
import StatusPill from "./StatusPill"
import TurnStatus from "./TurnStatus"
import VersionBadge from "./VersionBadge"

export default function SessionView({ onMenu }: { onMenu?: () => void }) {
  const { t } = useTranslation()
  const welcome = useSessionSnapshot()?.welcome ?? null
  usePanelViews(usePanelList())

  return (
    <div className="session">
      <div className="chronicle-pane">
        <header className="session-head">
          {onMenu ? (
            <button type="button" className="ghost-button" onClick={onMenu}>
              {t("play.menuButton")}
            </button>
          ) : null}
          <span className="session-room">{welcome ? `${welcome.room.id} · ${welcome.you.name}` : "…"}</span>
          <PanelMenu />
          <StatusPill />
          <VersionBadge />
          <button type="button" className="ghost-button" onClick={() => void quitTable()}>
            {t("connect.disconnect")}
          </button>
        </header>
        <PanelNotice />
        <AudioUnlockNotice />
        <TurnStatus />
        <NarrativeLog />
        <NoticeLines />
        <PanelTray />
        <InputBox />
      </div>
      <aside className="desk-pane">
        <PanelSidebar />
        <StatePanel />
        <MediaDeck />
        <AudioDeck />
      </aside>
      <PanelModalHost />
    </div>
  )
}
