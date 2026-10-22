import { useTranslation } from "react-i18next"
import { stripControlChars, type DiceFrame } from "@loreweaver/protocol"
import { readDiceDetail, subsystemChipText, type OpposedSide, type TensReroll } from "./diceDetail"
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

/** The bonus/penalty-die cluster as ONE chip: "bonus die 1: rolled 98, extra
 * tens 6, tens taken 6". The kept digit is stated, not compared with the roll's
 * own tens — "taken" is true whether or not the extra dice changed anything. */
function TensChip({ tens }: { tens: TensReroll }) {
  const { t } = useTranslation()
  const head =
    tens.bonus > 0 && tens.penalty > 0
      ? t("play.dice.tens.both", { bonus: tens.bonus, penalty: tens.penalty })
      : tens.bonus > 0
        ? t("play.dice.tens.bonus", { n: tens.bonus })
        : tens.penalty > 0
          ? t("play.dice.tens.penalty", { n: tens.penalty })
          : t("play.dice.tens.plain")
  const value =
    tens.extra.length > 0
      ? t("play.dice.tens.value", { base: tens.base, extra: tens.extra.join("/"), final: tens.final })
      : t("play.dice.tens.valueBare", { base: tens.base, final: tens.final })
  return (
    <span className="dice-chip">
      <span className="dice-chip-label">{head}</span>
      <span className="dice-chip-value">{value}</span>
    </span>
  )
}

export default function DiceLine({ frame }: { frame: DiceFrame }) {
  const { t } = useTranslation()
  const outcome = frame.outcome
  const subsystem = subsystemChipText(frame)
  // The raw id is the tooltip only when the chip shows something else: a pack with
  // no display name gets `subsystem_label` = the id back from the engine.
  const subsystemId = typeof frame.subsystem === "string" ? stripControlChars(frame.subsystem).trim() : ""
  // `detail` is system-declared data a client "may surface verbatim but never
  // needs to understand" — so the two shapes the protocol names get layout, and
  // the rest is shown as-is rather than dropped.
  const { opposed, tens, chips } = readDiceDetail(frame)

  return (
    <div className={`dice-line ${diceOutcomeClass(outcome)}`} data-kind={frame.kind}>
      <span className="dice-glyph" aria-hidden="true">
        ⚄
      </span>
      <span className="dice-text">
        {subsystem ? (
          <span
            className="dice-subsystem"
            title={subsystemId && subsystemId !== subsystem ? subsystemId : undefined}
          >
            {subsystem}
          </span>
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
      {tens !== null || chips.length > 0 ? (
        <span className="dice-detail">
          {tens !== null ? <TensChip tens={tens} /> : null}
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
