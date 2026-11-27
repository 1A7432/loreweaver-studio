// The start-up notes of the server this app hosts (no model yet, say), shown on the
// menu to the room admin who is also that server's operator — read once, put away.

import { useTranslation } from "react-i18next"
import { useHostLocalStore, useIsHostedTable } from "../../store/hostLocal"
import { describeHostNote } from "./hostLocalText"
import type { PlayScreen } from "./OnlineView"

/** What the server this app hosts said when it started (no model yet, say), for the
 * room admin who is also its operator; read once and put away. */
export default function HostedNotes({ onNavigate }: { onNavigate: (screen: PlayScreen) => void }) {
  const { t } = useTranslation()
  const hostedTable = useIsHostedTable()
  const hosted = useHostLocalStore((s) => s.hosted)
  const dismissed = useHostLocalStore((s) => s.notesDismissed)
  const dismiss = useHostLocalStore((s) => s.dismissNotes)
  if (!hostedTable || hosted === null || dismissed) return null
  const lines = [
    ...(hosted.keySource === "minted" ? [t("connect.hostLocal.keyMinted")] : []),
    ...hosted.notes.map((note) => describeHostNote(note, t)),
  ]
  if (lines.length === 0) return null
  return (
    <div className="hosted-notes" role="status">
      <p className="hosted-notes-head">{t("connect.hostLocal.notesTitle")}</p>
      {lines.map((line, index) => (
        <p key={index} className="system-line level-info">
          {line}
        </p>
      ))}
      <div className="hosted-notes-actions">
        {hosted.notes.includes("model_not_configured") ? (
          <button type="button" className="ghost-button" onClick={() => onNavigate("model")}>
            {t("connect.hostLocal.openModels")}
          </button>
        ) : null}
        <button type="button" className="ghost-button" onClick={dismiss}>
          {t("session.dismiss")}
        </button>
      </div>
    </div>
  )
}
