// One roll or check as the table saw it (protocol 3.0 §8.2), drawn from the event's own
// neutral fields only: who rolled, the notation, the dice, the total, the target, the
// outcome's label (already in the room's language) and, for a rule subsystem, its name.
// The colour comes from the outcome's flags; `tier` rides along as a data attribute for
// shading. Nothing here branches on `outcome.id` or on `detail` — the document forbids
// both. Of `detail` only its readable `text` is shown, verbatim, when it has one (a plain
// roll's `"2d6 (5, 5) = 10"`): it then stands in for the notation, total and dice it spells out.

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
  const extra = detailText(data)
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
        {extra
          ? `${stripControlChars(data.actor)} ${extra}`
          : stripControlChars(`${data.actor} ${data.expr} = ${data.total}`)}
        {typeof target === "number" ? ` vs ${target}` : ""}
        {adjusted ? ` (${data.target})` : ""}
        {outcome ? ` → ${stripControlChars(outcome.label)}` : ""}
      </span>
      {!extra && data.rolls.length > 0 ? <span className="dice-rolls">[{data.rolls.join(", ")}]</span> : null}
    </div>
  )
}
