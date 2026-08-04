// The card contract — TavernWeave's idea made native: a lightweight ledger of
// where every piece of the project came from (which wizard stage, which slot,
// which source label) plus when each stage was last confirmed. It is what makes
// regeneration INCREMENTAL (same slot → same project uid) and what powers the
// cross-stage consistency audit (missing targets, untracked manual additions,
// stages gone stale because an upstream stage re-confirmed after them).

import type { ForgeProject } from "../model"
import { visibleStages, type StageId } from "./stages"

export interface ContractSlot {
  stage: StageId
  /** Stable per-stage key (e.g. "wv:2", "npc:老陈", "var:理.好感度", "field:first_mes"). */
  slot: string
  kind: "lore" | "variable" | "field"
  /** lore/variable → the project uid; field → the ForgeProject field name. */
  target: string
  /** Source tag shown in tracking UIs: the worldview, the character's name, an NPC's name. */
  label: string
}

export interface CardContract {
  slots: ContractSlot[]
  confirmedAt: Partial<Record<StageId, number>>
}

export function emptyContract(): CardContract {
  return { slots: [], confirmedAt: {} }
}

export interface ContractAudit {
  /** Contract points at project pieces that no longer exist (deleted by hand). */
  missing: ContractSlot[]
  /** Project lore uids no wizard stage owns (added by hand — informational). */
  untrackedLore: string[]
  /** Project variable uids no wizard stage owns. */
  untrackedVariables: string[]
  /** Confirmed stages whose upstream (earlier) stages re-confirmed after them. */
  staleStages: StageId[]
}

/** The consistency check run between stages and before packing hand-off.
 * Stage order IS the dependency order (the methodology layers each stage on
 * the previous ones), so "stale" means: some earlier stage confirmed later
 * than this one did. */
export function auditContract(
  project: ForgeProject,
  contract: CardContract,
  nsfwEnabled: boolean,
): ContractAudit {
  const loreUids = new Set(project.lorebook.map((entry) => entry.uid))
  const varUids = new Set(project.variables.map((variable) => variable.uid))

  const missing = contract.slots.filter((slot) => {
    if (slot.kind === "lore") return !loreUids.has(slot.target)
    if (slot.kind === "variable") return !varUids.has(slot.target)
    return false
  })

  const ownedTargets = new Set(contract.slots.map((slot) => slot.target))
  const untrackedLore = project.lorebook.map((e) => e.uid).filter((u) => !ownedTargets.has(u))
  const untrackedVariables = project.variables.map((v) => v.uid).filter((u) => !ownedTargets.has(u))

  const staleStages: StageId[] = []
  const order = visibleStages(nsfwEnabled).map((meta) => meta.id)
  for (let i = 0; i < order.length; i++) {
    const stamp = contract.confirmedAt[order[i]]
    if (stamp === undefined) continue
    const upstreamNewer = order.slice(0, i).some((up) => (contract.confirmedAt[up] ?? 0) > stamp)
    if (upstreamNewer) staleStages.push(order[i])
  }

  return { missing, untrackedLore, untrackedVariables, staleStages }
}
