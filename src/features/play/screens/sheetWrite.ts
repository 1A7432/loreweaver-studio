/** The `sheet` command's write that lands `target` on one sheet value (protocol 3.0
 * §6.8: `writes` of `{name, op, value}`, the value as text). The explicit `=` assigns
 * absolutely, so a negative target is simply written with its sign, and `name` is the
 * sheet's own key — a key with a digit or a space in it is carried exactly. */
export function sheetSetArgs(name: string, target: number): Record<string, unknown> {
  return { op: "set", writes: [{ name, op: "=", value: String(target) }] }
}
