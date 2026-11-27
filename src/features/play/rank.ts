import type { Outcome } from "loreweaver-protocol/v3"

/**
 * Map a dice `outcome` onto the colour ramp by its semantic flags — critical, fumble,
 * success, fail — never by the rule system's rank id (protocol 3.0 §8.2: `id` is
 * presentation only). Ungraded rolls (no `outcome`) stay neutral.
 */
export function diceOutcomeClass(outcome: Outcome | undefined): string {
  if (!outcome) return "rank-neutral"
  if (outcome.critical) return "rank-crit"
  if (outcome.fumble) return "rank-fumble"
  if (outcome.success) return "rank-success"
  return "rank-fail"
}
