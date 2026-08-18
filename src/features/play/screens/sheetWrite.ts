/** The `.st` write that lands `target` on an attribute.
 *
 * The EXPLICIT form, `.st <name>=<value>` (engine ≥ 2.3): `=` assigns ABSOLUTELY, so
 * a negative target is simply written with its sign, and the name is everything left
 * of the `=` — a storage key with a digit or a space in it (`skill2`, `spot hidden`)
 * cannot be mis-split. The bare `.st <name> <n>` form reads a leading sign as RELATIVE
 * and scans for the value inside the name, which is why a client that builds writes
 * out of arbitrary pack keys does not use it. */
export function sheetWrite(name: string, target: number): string {
  return `.st ${name}=${target}`
}
