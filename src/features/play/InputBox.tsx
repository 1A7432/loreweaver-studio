// The line a person types: speech or a text command, sent as one `input` (protocol 3.0
// §5.2). The server decides which it is; the session does the rest — speech comes back
// as the table's `narrative` event, so there is no local echo to keep in step with it.
// What the result says is shown under the field: a command's answer, or a refusal in the
// member's own language, as written. A line that never reached the room is put back in
// the field when the field is still empty, so nobody retypes it.

import { useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useConnection } from "../../store/connection"
import CommandFeedback from "./CommandFeedback"
import { feedbackOf, useOnline, type Feedback } from "./room"

export default function InputBox() {
  const { t } = useTranslation()
  const connection = useConnection()
  const online = useOnline()
  const [text, setText] = useState("")
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const line = text.trim()
    if (connection === null || !online || line.length === 0) return
    setText("")
    setFeedback(null)
    connection.session.input(line).then(
      (result) => setFeedback(feedbackOf(result)),
      (error: unknown) => {
        const code =
          typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failed"
        setFeedback(feedbackOf({ failed: code }))
        setText((current) => (current === "" ? line : current))
      },
    )
  }

  return (
    <div className="input-area">
      <CommandFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />
      <form className="input-box" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("session.inputPlaceholder")}
          aria-label={t("session.inputPlaceholder")}
          disabled={!online}
          spellCheck={false}
        />
        <button type="submit" disabled={!online || text.trim().length === 0}>
          {t("session.send")}
        </button>
      </form>
    </div>
  )
}
