import type { DiceOutcome } from "@loreweaver/protocol"

/**
 * Map a dice `outcome` onto the color ramp, matching the reference TUI
 * (protocol 2.0): color by the semantic flags — critical, fumble, success,
 * fail — never by the rule pack's rank id or tier. Ungraded rolls (no
 * `outcome`) stay neutral.
 */
export function diceOutcomeClass(outcome: DiceOutcome | undefined): string {
  if (!outcome) return "rank-neutral"
  if (outcome.critical) return "rank-crit"
  if (outcome.fumble) return "rank-fumble"
  if (outcome.success) return "rank-success"
  return "rank-fail"
}
