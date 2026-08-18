// Protocol 2.3 fields, typed locally until `loreweaver-protocol` publishes 2.3.0 and
// this package's dependency moves off 2.2.0. ONE module so there is one place to
// delete, not a cast at every use site.
//
// Both fields are optional on purpose either way: a server older than 2.3 omits them,
// and each has a well-defined reading when missing — a card with no `kind` is a
// character card (what every client assumed before the field existed), and a state
// frame with no `systems` simply cannot offer character creation.

import type { PackCardEntry, StateFrame } from "@loreweaver/protocol"

/** One discoverable rule system. `make_char` is the dot-command word that creates a
 * sheet in it (`.coc`, `.dnd`, a pack's own); absent when the pack declares none. */
export interface RuleSystemEntry {
  id: string
  make_char?: string
}

export type PackCardEntry23 = PackCardEntry & { kind?: "character" | "world" }

export type StateFrame23 = StateFrame & { systems?: RuleSystemEntry[] }

/** The one empty list every "no systems" answer returns. A fresh `[]` per call makes a
 * zustand selector look changed on every render, which is an infinite re-render, not a
 * style point. */
const NO_SYSTEMS: RuleSystemEntry[] = []

/** The rule systems a state frame carries, or an empty list. Safe as a store selector:
 * it returns the frame's own array, or the shared empty one. */
export function ruleSystems(game: StateFrame | null | undefined): RuleSystemEntry[] {
  const systems = (game as StateFrame23 | null | undefined)?.systems
  return Array.isArray(systems) ? systems : NO_SYSTEMS
}
