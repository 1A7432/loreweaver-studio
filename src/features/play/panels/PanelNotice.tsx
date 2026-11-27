// Player consent, one line: the first join to a room whose packs bring panels
// states what arrived (N panels, X MB of page content) — dismissed once per room.

import { useTranslation } from "react-i18next"
import { useSessionSnapshot } from "../../../store/connection"
import { usePanelsStore } from "../../../store/panels"
import { pageFootprintBytes } from "./assets"
import { usePanelList } from "./panelList"

export default function PanelNotice() {
  const { t } = useTranslation()
  const panels = usePanelList()
  const noticeRooms = usePanelsStore((s) => s.noticeRooms)
  const markNoticeSeen = usePanelsStore((s) => s.markNoticeSeen)
  const room = useSessionSnapshot()?.welcome?.room.id ?? null

  if (!room || panels.length === 0 || noticeRooms.includes(room)) return null
  const mb = (pageFootprintBytes(panels) / (1024 * 1024)).toFixed(1)
  return (
    <div className="panel-notice" role="status">
      <span className="panel-notice-text">{t("panels.notice", { n: panels.length, mb })}</span>
      <button type="button" className="ghost-button" onClick={() => markNoticeSeen(room)}>
        {t("panels.noticeOk")}
      </button>
    </div>
  )
}
