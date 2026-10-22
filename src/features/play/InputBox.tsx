import { useEffect, useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { transportSend } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"
import { JOIN_REPLAY_TIMEOUT_MS, useSessionStore } from "../../store/session"

export default function InputBox() {
  const { t } = useTranslation()
  const status = useConnectionStore((s) => s.status)
  const seat = useConnectionStore((s) => s.welcome?.you.name ?? "")
  const echoLocalInput = useSessionStore((s) => s.echoLocalInput)
  const failEcho = useSessionStore((s) => s.failEcho)
  // The transport is online the moment the welcome lands, but the room's history
  // is still arriving behind it: a line sent now would sit in the middle of the
  // log being rebuilt. The draft is HELD — the field stays editable, Enter keeps
  // it — until the replay ends, which is normally a beat.
  const replaySince = useSessionStore((s) => s.replay?.since ?? null)
  const expireReplay = useSessionStore((s) => s.expireReplay)
  const [text, setText] = useState("")
  const online = status === "online"
  const syncing = replaySince !== null

  // A server that never closes its replay must not hold the input for ever.
  useEffect(() => {
    if (replaySince === null) return
    const timer = setTimeout(
      () => expireReplay(Date.now()),
      Math.max(0, replaySince + JOIN_REPLAY_TIMEOUT_MS - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [replaySince, expireReplay])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = text.trim()
    if (!online || syncing || trimmed.length === 0) return
    // Echo first: a turn already running holds the room's turn lock, so this
    // line can wait in the queue for a long while before anything comes back.
    const seq = echoLocalInput(trimmed, seat)
    void transportSend({ type: "input", text: trimmed }).catch(() => {
      // The transport surfaces failures through status events; the echo says
      // so where the player is actually looking.
      failEcho(seq)
    })
    setText("")
  }

  const holding = online && syncing
  return (
    <form className="input-box" onSubmit={submit}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("session.inputPlaceholder")}
        aria-label={t("session.inputPlaceholder")}
        disabled={!online}
        spellCheck={false}
      />
      <button
        type="submit"
        disabled={!online || syncing || text.trim().length === 0}
        title={holding ? t("session.syncingHint") : undefined}
      >
        {holding ? (
          <span className="input-syncing" role="status">
            <span className="spinner spinner-inline" aria-hidden="true" />
            {t("session.syncing")}
          </span>
        ) : (
          t("session.send")
        )}
      </button>
    </form>
  )
}
