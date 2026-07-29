import { useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { transportSend } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"

export default function InputBox() {
  const { t } = useTranslation()
  const status = useConnectionStore((s) => s.status)
  const [text, setText] = useState("")
  const online = status === "online"

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = text.trim()
    if (!online || trimmed.length === 0) return
    void transportSend({ type: "input", text: trimmed }).catch(() => {
      // The transport surfaces failures through status events.
    })
    setText("")
  }

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
      <button type="submit" disabled={!online || text.trim().length === 0}>
        {t("session.send")}
      </button>
    </form>
  )
}
