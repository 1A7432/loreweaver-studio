// Out-of-band lines for the table — a turn that failed, a provider that is down (protocol
// 3.0 §9.3 `notice`). The session does not keep signals, so the few recent ones live in
// this component's state alone: a small list, the oldest dropped first, each dismissable.
// A notice marked `spinner` (a long operation under way) shows animated until the turn
// goes idle. The text is in the room's language, as the server wrote it.

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars, type SignalPayloads } from "loreweaver-protocol/v3"
import type { Connection } from "../../lib/connection"
import { useConnection } from "../../store/connection"

/** Notices shown at once; the oldest go first. */
export const MAX_NOTICES = 5

interface Shown {
  readonly id: number
  readonly notice: SignalPayloads["notice"]
}

export default function NoticeLines() {
  const { t } = useTranslation()
  const connection = useConnection()
  // The lines belong to the connection they came on: another table starts with none.
  const [held, setHeld] = useState<{ owner: Connection | null; list: readonly Shown[] }>({
    owner: connection,
    list: [],
  })
  const shown = held.owner === connection ? held.list : []
  const setShown = (change: (list: readonly Shown[]) => readonly Shown[]) =>
    setHeld((state) => ({ owner: connection, list: change(state.owner === connection ? state.list : []) }))

  useEffect(() => {
    if (connection === null) return
    let next = 0
    const update = (change: (list: readonly Shown[]) => readonly Shown[]) =>
      setHeld((state) => ({ owner: connection, list: change(state.owner === connection ? state.list : []) }))
    return connection.session.onSignal((frame) => {
      if (frame.kind === "notice") {
        const entry = { id: ++next, notice: frame.data }
        update((list) => [...list, entry].slice(-MAX_NOTICES))
      } else if (frame.kind === "turn" && frame.data.status === "idle") {
        update((list) =>
          list.some((entry) => entry.notice.spinner) ? list.filter((entry) => !entry.notice.spinner) : list,
        )
      }
    })
  }, [connection])

  if (shown.length === 0) return null
  return (
    <div className="notice-lines" role="log" aria-live="polite">
      {shown.map((entry) => (
        <div key={entry.id} className={`system-line level-${entry.notice.level}`}>
          {entry.notice.spinner ? <span className="spinner spinner-inline" aria-hidden="true" /> : null}
          <span>{stripControlChars(entry.notice.text)}</span>
          <button
            type="button"
            className="icon-button"
            aria-label={t("session.dismiss")}
            title={t("session.dismiss")}
            onClick={() => setShown((list) => list.filter((other) => other.id !== entry.id))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
