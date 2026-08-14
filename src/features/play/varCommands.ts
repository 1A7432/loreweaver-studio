// The keeper's variable writes, as commands.
//
// `.var set <id> <value>` and `.var add <id> <delta>` landed upstream
// (UPSTREAM item 11) — keeper-gated, validated by `core.modvars`. There is no
// wire frame for a variable write and there should not be: routing it through
// the ordinary command path means the same permission check, the same spec
// validation (bounds, enum options, bool coercion) and the same state push a
// keeper typing it by hand would get. This module only builds the line.
//
// Two shapes the engine's own parser imposes, mirrored here:
//   - `cmd_var` reads `rest.split(None, 1)`, so the ID must be ONE token and
//     everything after it is the payload. A variable id can be CJK but never
//     contains whitespace (`core.modvars._valid_id` rejects separators), so
//     that split is always safe.
//   - `add` runs its payload through `coerce_int`, so a delta is an integer or
//     the command fails. The UI never offers a fractional step.

import type { ModuleVariable } from "@loreweaver/protocol"

/** `.var set <id> <value>` — the value is validated against the variable's own
 * spec server-side, so this passes it through rather than second-guessing. */
export function setVarCommand(id: string, value: string | number | boolean): string {
  return `.var set ${id.trim()} ${formatValue(value)}`
}

/** `.var add <id> <delta>` — integers only. A zero delta is not a command:
 * the engine would do nothing and reply as if something happened. */
export function addVarCommand(id: string, delta: number): string | null {
  const step = Math.trunc(delta)
  if (!Number.isFinite(step) || step === 0) return null
  return `.var add ${id.trim()} ${step}`
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return String(value)
  // `ctx.args.split()` collapses runs of whitespace, so a value's internal
  // spacing is normalized server-side no matter what we send. Trimming the
  // ends is the honest half of that; nothing here can preserve the rest.
  return value.trim()
}

/** Can a keeper write this variable from the panel at all?
 *
 * A hidden (keeper-only) variable is as writable as any other — hiding governs
 * who SEES it, not who may set it. What is refused is an id the command's own
 * tokenizer could not carry. */
export function isWritable(variable: ModuleVariable): boolean {
  return variable.id.trim() !== "" && !/\s/.test(variable.id)
}

/** The step a `+`/`−` control should use for one variable: 1 normally, and
 * nothing at all once the value is against a declared bound in that direction —
 * `core.modvars` would clamp it and report a no-op change. */
export function stepFor(variable: ModuleVariable, direction: 1 | -1): number | null {
  if (variable.kind !== "number" || typeof variable.value !== "number") return null
  const next = variable.value + direction
  if (typeof variable.max === "number" && next > variable.max) return null
  if (typeof variable.min === "number" && next < variable.min) return null
  return direction
}
