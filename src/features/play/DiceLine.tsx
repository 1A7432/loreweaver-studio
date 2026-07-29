import { stripControlChars, type DiceFrame } from "@loreweaver/protocol"
import { diceRankClass } from "./rank"

export default function DiceLine({ frame }: { frame: DiceFrame }) {
  const hasOutcome = typeof frame.level === "string" || typeof frame.success === "boolean"
  const level = frame.level ?? (frame.success ? "SUCCESS" : "FAIL")
  return (
    <div className={`dice-line ${diceRankClass(frame.rank)}`} data-kind={frame.kind}>
      <span className="dice-glyph" aria-hidden="true">
        ⚄
      </span>
      <span className="dice-text">
        {stripControlChars(`${frame.actor} ${frame.expr} = ${frame.total}`)}
        {typeof frame.target === "number" ? ` vs ${frame.target}` : ""}
        {hasOutcome ? ` → ${stripControlChars(level)}` : ""}
      </span>
      {frame.rolls.length > 0 ? <span className="dice-rolls">[{frame.rolls.join(", ")}]</span> : null}
    </div>
  )
}
