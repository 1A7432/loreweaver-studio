import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars } from "@loreweaver/protocol"
import { useSessionStore } from "../../store/session"

const SAFETY_SWEEP_MS = 5_000

/**
 * Room-wide AI-keeper activity. `busy` must always render as an animated
 * spinner (never static text); a sweep clears it if the idle frame got lost.
 */
export default function TurnStatus() {
  const turn = useSessionStore((s) => s.turn)
  const expire = useSessionStore((s) => s.expireTurnSafety)
  const { t } = useTranslation()

  useEffect(() => {
    if (!turn.busy) return
    const timer = setInterval(() => expire(Date.now()), SAFETY_SWEEP_MS)
    return () => clearInterval(timer)
  }, [turn.busy, expire])

  if (!turn.busy) return null
  // The activity/round hints are optional (protocol 2.3.1): without them the
  // line is exactly what it always was.
  const activity = turn.activity ? t(`session.turnActivity.${turn.activity}`) : null
  return (
    <div className="turn-status" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{t("session.turnBusy", { actor: stripControlChars(turn.actor ?? "") })}</span>
      {activity ? (
        <span className="turn-activity">
          {activity}
          {turn.round !== null ? ` ${t("session.turnRound", { n: turn.round })}` : null}
        </span>
      ) : null}
    </div>
  )
}
