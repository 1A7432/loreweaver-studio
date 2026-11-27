// One roll or check as the table saw it (protocol 3.0 §8.2), drawn from the event's own
// neutral fields only: who rolled, the notation, the dice, the total, the target, the
// outcome's label (already in the room's language) and, for a rule subsystem, its name.
// The colour comes from the outcome's flags; `tier` rides along as a data attribute for
// shading. Nothing here branches on `outcome.id` or on `detail` — the document forbids
// both.
//
// The words follow the event the way the document says to read it: when the server sent the
// whole roll as one line (`text` — an opposed roll, a subsystem roll with its consequence, a
// plain roll), that line is shown after the actor and nothing is composed beside it; otherwise
// the line is composed from what was rolled for (`label`: the skill or stat), the notation,
// the total, the target and the outcome's label. `detail.text` is read only where an event
// has no `text` of its own.

import { stripControlChars, type DiceData } from "loreweaver-protocol/v3"
import { diceOutcomeClass } from "./rank"

function detailText(data: DiceData): string {
  const text = data.detail?.text
  return typeof text === "string" ? stripControlChars(text).trim() : ""
}

export default function DiceLine({ data }: { data: DiceData }) {
  const outcome = data.outcome
  const label = typeof data.subsystemLabel === "string" ? stripControlChars(data.subsystemLabel).trim() : ""
  const id = typeof data.subsystem === "string" ? stripControlChars(data.subsystem).trim() : ""
  const subsystem = label || id
  const target = data.effectiveTarget ?? data.target
  const adjusted =
    typeof data.target === "number" &&
    typeof data.effectiveTarget === "number" &&
    data.effectiveTarget !== data.target
  const whole = typeof data.text === "string" ? stripControlChars(data.text).trim() : ""
  const what = typeof data.label === "string" ? stripControlChars(data.label).trim() : ""
  const extra = whole ? "" : detailText(data)
  const actor = stripControlChars(data.actor)
  return (
    <div
      className={`dice-line ${diceOutcomeClass(outcome)}`}
      data-kind={data.kind}
      data-tier={outcome ? outcome.tier : undefined}
    >
      <span className="dice-glyph" aria-hidden="true">
        ⚄
      </span>
      <span className="dice-text">
        {subsystem ? (
          <span className="dice-subsystem" title={label && id && id !== label ? id : undefined}>
            {subsystem}
          </span>
        ) : null}
        {whole
          ? `${actor}: ${whole}`
          : extra
            ? `${actor} ${extra}`
            : `${actor} ${what ? `${what} ` : ""}${stripControlChars(`${data.expr} = ${data.total}`)}`}
        {!whole && typeof target === "number" ? ` vs ${target}` : ""}
        {!whole && adjusted ? ` (${data.target})` : ""}
        {!whole && outcome ? ` → ${stripControlChars(outcome.label)}` : ""}
      </span>
      {!whole && !extra && data.rolls.length > 0 ? (
        <span className="dice-rolls">[{data.rolls.join(", ")}]</span>
      ) : null}
    </div>
  )
}
