// The room admin's variable writes, as the `var` command's arguments (protocol 3.0 §6.8:
// `op` set|add, `path`, `value` a string, `delta` an integer). There is no frame for a
// variable write and there should not be: the command path means the same permission
// check, the same validation against the variable's own spec (bounds, enum options, bool
// coercion) and the same view refresh a typed `.var set` gets. This module only builds the
// argument objects; nothing here second-guesses a value the server will check.

import type { ViewModuleVariable } from "loreweaver-protocol/v3"

/** The longest `path` the `var` command takes, in code points. */
export const MAX_VAR_PATH_CHARS = 200

/** `var {op: "set", path, value}` — the value travels as text and is parsed by the server. */
export function setVarArgs(path: string, value: string | number | boolean): Record<string, unknown> {
  return { op: "set", path, value: typeof value === "string" ? value.trim() : String(value) }
}

/** `var {op: "add", path, delta}` — integers only. A zero delta is not a command: the server
 * would change nothing and answer as if something happened. */
export function addVarArgs(path: string, delta: number): Record<string, unknown> | null {
  const step = Math.trunc(delta)
  if (!Number.isFinite(step) || step === 0) return null
  return { op: "add", path, delta: step }
}

/** Can a variable be written from the panel at all? A hidden one is as writable as any
 * other — hiding governs who SEES it — but a path the command could not carry is not. */
export function isWritablePath(path: string): boolean {
  return path.trim() !== "" && Array.from(path).length <= MAX_VAR_PATH_CHARS
}

/** The step a `+`/`−` control uses: 1, or nothing once the value is against a declared
 * bound in that direction (the server would clamp it and report a no-op). */
export function stepFor(variable: ViewModuleVariable, direction: 1 | -1): number | null {
  if (variable.kind !== "number" || typeof variable.value !== "number") return null
  const next = variable.value + direction
  if (typeof variable.max === "number" && next > variable.max) return null
  if (typeof variable.min === "number" && next < variable.min) return null
  return direction
}
