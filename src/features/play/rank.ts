/**
 * Map a dice `rank` (-2..+4) onto the color ramp, matching the reference TUI:
 * ≥4 crit, 3 extreme, 2 hard, 1 success, -1 fail, ≤-2 fumble, else neutral.
 */
export function diceRankClass(rank: number | undefined): string {
  const r = rank ?? 0
  if (r >= 4) return "rank-crit"
  if (r === 3) return "rank-extreme"
  if (r === 2) return "rank-hard"
  if (r >= 1) return "rank-success"
  if (r <= -2) return "rank-fumble"
  if (r <= -1) return "rank-fail"
  return "rank-neutral"
}
