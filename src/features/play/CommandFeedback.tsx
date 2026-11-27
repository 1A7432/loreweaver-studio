// What came back to this person from the command a control ran — the answer, the refusal,
// or "nothing was sent" — shown beside that control. The server writes answers and refusal
// messages in this member's language (protocol 3.0 §12.2): they are shown as written.

import { useTranslation } from "react-i18next"
import { stripControlChars } from "loreweaver-protocol/v3"
import type { Feedback } from "./room"

export default function CommandFeedback({
  feedback,
  onDismiss,
}: {
  feedback: Feedback | null
  onDismiss?: () => void
}) {
  const { t } = useTranslation()
  if (feedback === null) return null
  const text =
    feedback.kind === "failed"
      ? t("play.sendFailed")
      : stripControlChars(feedback.text).trim() || feedback.text
  return (
    <div
      className={`command-feedback is-${feedback.kind}`}
      role={feedback.kind === "answer" ? "status" : "alert"}
    >
      <p className="command-feedback-text">{text}</p>
      {onDismiss ? (
        <button
          type="button"
          className="icon-button"
          aria-label={t("session.dismiss")}
          title={t("session.dismiss")}
          onClick={onDismiss}
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
