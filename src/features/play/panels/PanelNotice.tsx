// Player consent, one line: the first join to a room whose keeper enabled
// panels states what arrived (N panels, X MB of Tier-2 content) — dismissed
// once per room. Rendering stays default-on; the sandbox is what makes that
// defensible, and blocks-only mode lives one click away in the panels menu.

import { useTranslation } from "react-i18next"
import { useConnectionStore } from "../../../store/connection"
import { usePanelsStore } from "../../../store/panels"
import { tier2FootprintBytes } from "./assets"

export default function PanelNotice() {
  const { t } = useTranslation()
  const manifest = usePanelsStore((s) => s.manifest)
  const noticeRooms = usePanelsStore((s) => s.noticeRooms)
  const markNoticeSeen = usePanelsStore((s) => s.markNoticeSeen)
  const room = useConnectionStore((s) => s.welcome?.room ?? null)

  if (!room || manifest.length === 0 || noticeRooms.includes(room)) return null
  const mb = (tier2FootprintBytes(manifest) / (1024 * 1024)).toFixed(1)
  return (
    <div className="panel-notice" role="status">
      <span className="panel-notice-text">{t("panels.notice", { n: manifest.length, mb })}</span>
      <button type="button" className="ghost-button" onClick={() => markNoticeSeen(room)}>
        {t("panels.noticeOk")}
      </button>
    </div>
  )
}
