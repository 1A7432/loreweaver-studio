// Room-wide Keeper activity: the latest `turn` signal (protocol 3.0 §9.2), held by the
// session. `busy` is a state, not an event, and always renders as an animated spinner,
// never static text. The session forgets it when the link drops, and a member who
// connects mid-turn is sent `busy` right after the replay.

import { useTranslation } from "react-i18next"
import { stripControlChars } from "loreweaver-protocol/v3"
import { useSessionSnapshot } from "../../store/connection"

export default function TurnStatus() {
  const { t } = useTranslation()
  const turn = useSessionSnapshot()?.turn ?? null
  if (turn === null || turn.status !== "busy") return null
  // `activity` and `round` are optional and presentation only; the 3.0 server sends neither.
  const activity = turn.activity ? t(`session.turnActivity.${turn.activity}`) : null
  return (
    <div className="turn-status" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{t("session.turnBusy", { actor: stripControlChars(turn.actor) })}</span>
      {activity ? (
        <span className="turn-activity">
          {activity}
          {typeof turn.round === "number" ? ` ${t("session.turnRound", { n: turn.round })}` : null}
        </span>
      ) : null}
    </div>
  )
}
