import { useTranslation } from "react-i18next"
import { stripControlChars, type DiceFrame } from "@loreweaver/protocol"
import { readDiceDetail, type OpposedSide } from "./diceDetail"
import { diceOutcomeClass } from "./rank"

function OpposedRow({ side, won }: { side: OpposedSide; won: boolean }) {
  return (
    <span className={won ? "dice-side won" : "dice-side"}>
      <span className="dice-side-name">{stripControlChars(side.name)}</span>
      {side.total !== null ? <span className="dice-side-total">{side.total}</span> : null}
      {side.target !== null ? <span className="dice-side-target">/{side.target}</span> : null}
      {side.outcomeLabel ? (
        <span className="dice-side-outcome">{stripControlChars(side.outcomeLabel)}</span>
      ) : null}
    </span>
  )
}

export default function DiceLine({ frame }: { frame: DiceFrame }) {
  const { t } = useTranslation()
  const outcome = frame.outcome
  // `detail` is system-declared data a client "may surface verbatim but never
  // needs to understand" — so the two shapes the protocol names get layout, and
  // the rest is shown as-is rather than dropped.
  const { opposed, chips } = readDiceDetail(frame)

  return (
    <div className={`dice-line ${diceOutcomeClass(outcome)}`} data-kind={frame.kind}>
      <span className="dice-glyph" aria-hidden="true">
        ⚄
      </span>
      <span className="dice-text">
        {frame.subsystem ? (
          <span className="dice-subsystem">{stripControlChars(frame.subsystem)}</span>
        ) : null}
        {stripControlChars(`${frame.actor} ${frame.expr} = ${frame.total}`)}
        {typeof frame.target === "number" ? ` vs ${frame.target}` : ""}
        {outcome ? ` → ${stripControlChars(outcome.label)}` : ""}
      </span>
      {frame.rolls.length > 0 ? <span className="dice-rolls">[{frame.rolls.join(", ")}]</span> : null}
      {opposed !== null ? (
        <span className="dice-opposed">
          <OpposedRow side={opposed.left} won={opposed.winner === "left"} />
          <span className="dice-versus">{t("play.dice.versus")}</span>
          <OpposedRow side={opposed.right} won={opposed.winner === "right"} />
          {opposed.winner !== "" ? (
            <span className="dice-winner">
              {opposed.winner === "tie"
                ? t("play.dice.tie")
                : t("play.dice.winner", {
                    name: (opposed.winner === "left" ? opposed.left : opposed.right).name,
                  })}
            </span>
          ) : null}
        </span>
      ) : null}
      {chips.length > 0 ? (
        <span className="dice-detail">
          {chips.map((chip) => (
            <span className="dice-chip" key={chip.key}>
              <span className="dice-chip-label">
                {chip.labelKey === null ? chip.key : t(`play.dice.detail.${chip.labelKey}`)}
              </span>
              <span className="dice-chip-value">{stripControlChars(chip.value)}</span>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  )
}
