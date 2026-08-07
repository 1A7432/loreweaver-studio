import { stripControlChars, type DiceFrame } from "@loreweaver/protocol"
import { diceOutcomeClass } from "./rank"

export default function DiceLine({ frame }: { frame: DiceFrame }) {
  const outcome = frame.outcome
  return (
    <div className={`dice-line ${diceOutcomeClass(outcome)}`} data-kind={frame.kind}>
      <span className="dice-glyph" aria-hidden="true">
        ⚄
      </span>
      <span className="dice-text">
        {stripControlChars(`${frame.actor} ${frame.expr} = ${frame.total}`)}
        {typeof frame.target === "number" ? ` vs ${frame.target}` : ""}
        {outcome ? ` → ${stripControlChars(outcome.label)}` : ""}
      </span>
      {frame.rolls.length > 0 ? <span className="dice-rolls">[{frame.rolls.join(", ")}]</span> : null}
    </div>
  )
}
