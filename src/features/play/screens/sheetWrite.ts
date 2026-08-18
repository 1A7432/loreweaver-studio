/** The `.st` write that lands `target` on an attribute now at `current`.
 *
 * `.st <name> <n>` sets `n`; but the engine reads a leading sign as RELATIVE
 * (`gateway/commands.py` `_apply_value_expr`: `-5` is current−5, `+5` current+5), and
 * it has no syntax for an absolute negative. So a non-negative target goes out as
 * itself, and a negative one as the signed delta from the value on the wire —
 * reachable either way with the engine's own grammar, and the next `state` frame is
 * still the truth. */
export function sheetWrite(name: string, current: number, target: number): string {
  if (target >= 0) return `.st ${name} ${target}`
  const delta = target - current
  return `.st ${name} ${delta >= 0 ? `+${delta}` : `${delta}`}`
}
