// Stage output → project, incrementally. Everything lands in the NATIVE forge
// structures (fields, worldbook entries, typed variables) — never a parallel
// store. The contract keeps slot→uid stable across regenerations: re-confirming
// a stage replaces exactly the pieces that stage produced (same slot keeps its
// uid, vanished slots delete their pieces, other stages' work is untouched).
// Pure functions throughout; the wizard store owns the write-back.

import { newLoreEntry, type ForgeLoreEntry, type ForgeProject } from "../model"
import { flattenLeaves, parseInitvar } from "../split/mvu"
import { promoteLeaves } from "../split/promote"
import { emptyContract, type CardContract, type ContractSlot } from "./contract"
import type { StageDraft, StageId, WizardLoreDraft } from "./stages"

export interface ApplyResult {
  project: ForgeProject
  contract: CardContract
}

function loreFromDraft(draft: WizardLoreDraft, keepUid?: string): ForgeLoreEntry {
  const entry = newLoreEntry()
  if (keepUid !== undefined) entry.uid = keepUid
  entry.title = draft.title
  entry.content = draft.content
  entry.keys = draft.keys.join(", ")
  entry.constant = draft.layer === "constant"
  entry.secret = draft.secret
  return entry
}

/** Replace one stage's lore output: same slot → same uid (in place), new slots
 * append, vanished slots delete. Slots of other stages are never touched. */
function upsertStageLore(
  project: ForgeProject,
  contract: CardContract,
  stage: StageId,
  drafts: WizardLoreDraft[],
): ApplyResult {
  const prevSlots = new Map(
    contract.slots.filter((s) => s.stage === stage && s.kind === "lore").map((s) => [s.slot, s]),
  )
  const existingUids = new Set(project.lorebook.map((entry) => entry.uid))
  let lorebook = [...project.lorebook]
  const nextSlots: ContractSlot[] = []

  for (const draft of drafts) {
    const prev = prevSlots.get(draft.slot)
    if (prev !== undefined && existingUids.has(prev.target)) {
      lorebook = lorebook.map((entry) =>
        entry.uid === prev.target ? loreFromDraft(draft, prev.target) : entry,
      )
      nextSlots.push({ ...prev, label: draft.sourceLabel })
    } else {
      const entry = loreFromDraft(draft)
      lorebook.push(entry)
      nextSlots.push({ stage, slot: draft.slot, kind: "lore", target: entry.uid, label: draft.sourceLabel })
    }
  }

  const removedTargets = new Set(
    [...prevSlots.values()]
      .filter((prev) => !nextSlots.some((next) => next.slot === prev.slot))
      .map((prev) => prev.target),
  )
  lorebook = lorebook.filter((entry) => !removedTargets.has(entry.uid))

  const slots = contract.slots.filter((s) => !(s.stage === stage && s.kind === "lore")).concat(nextSlots)
  return { project: { ...project, lorebook }, contract: { ...contract, slots } }
}

/** Record that `stage` owns a project FIELD (name, personality, first_mes, …). */
function recordFieldSlots(
  contract: CardContract,
  stage: StageId,
  fields: string[],
  label: string,
): CardContract {
  const kept = contract.slots.filter((s) => !(s.stage === stage && s.kind === "field"))
  const added: ContractSlot[] = fields.map((field) => ({
    stage,
    slot: `field:${field}`,
    kind: "field",
    target: field,
    label,
  }))
  return { ...contract, slots: [...kept, ...added] }
}

/** The character's display label for source tags, once basics has landed. */
function characterLabel(project: ForgeProject): string {
  return project.name.trim() || "character"
}

/** Assemble the personality field from the palette: base coat, 1-2 main colors
 * (each with its HANDWRITTEN derivation loops), optional accent. The labels are
 * language-neutral lowercase keys, ST-card style; the content is the author's. */
function personalityFromPalette(draft: Extract<StageDraft, { stage: "palette" }>): string {
  const parts: string[] = []
  parts.push(`core: ${draft.base.name} — ${draft.base.detail}`.trim())
  for (const main of draft.mains) {
    parts.push(`main: ${main.name} — ${main.detail}`.trim())
    if (main.derivation.trim()) parts.push(main.derivation.trim())
  }
  if (draft.accent !== null && draft.accent.name.trim()) {
    parts.push(`accent: ${draft.accent.name} — ${draft.accent.detail}`.trim())
  }
  return parts.join("\n\n")
}

/** One facet → one constant entry: gears of one engine, every register spelled
 * out (trigger/energy/voice/body/function) plus the bleed into other facets. */
function facetContent(facet: Extract<StageDraft, { stage: "facets" }>["facets"][number]): string {
  const lines = [
    `trigger: ${facet.trigger}`,
    `energy: ${facet.energy}`,
    `voice: ${facet.voice}`,
    `body: ${facet.body}`,
    `function: ${facet.role}`,
    `bleed: ${facet.bleed}`,
  ]
  return lines.filter((line) => !/: $/.test(line)).join("\n")
}

/** The update-rules draft lands as commented hooks source + an empty handler
 * skeleton — legal JS, ready for the author to turn into real handlers. */
function hooksFromRules(rules: string): string {
  const commented = rules
    .split("\n")
    .map((line) => `// ${line}`.trimEnd())
    .join("\n")
  return `// Variable update rules (wizard draft) — refine into real handlers:\n${commented}\non('reply_ready', (event) => {\n  // TODO: apply the rules above with setvar/incvar\n})\n`
}

function applyVariables(
  project: ForgeProject,
  contract: CardContract,
  draft: Extract<StageDraft, { stage: "variables" }>,
): ApplyResult {
  const tree = parseInitvar(draft.initvarYaml)
  if (tree === null) return { project, contract } // confirm gate keeps this unreachable
  const drafts = promoteLeaves(flattenLeaves(tree).leaves).filter((d) => d.include)

  const prevSlots = new Map(
    contract.slots.filter((s) => s.stage === "variables" && s.kind === "variable").map((s) => [s.slot, s]),
  )
  const existingUids = new Set(project.variables.map((variable) => variable.uid))
  let variables = [...project.variables]
  const nextSlots: ContractSlot[] = []

  for (const promo of drafts) {
    const slotKey = `var:${promo.mvuPath}`
    const prev = prevSlots.get(slotKey)
    if (prev !== undefined && existingUids.has(prev.target)) {
      variables = variables.map((variable) =>
        variable.uid === prev.target ? { ...promo.variable, uid: prev.target } : variable,
      )
      nextSlots.push(prev)
    } else {
      variables.push(promo.variable)
      nextSlots.push({
        stage: "variables",
        slot: slotKey,
        kind: "variable",
        target: promo.variable.uid,
        label: "InitVar",
      })
    }
  }

  const removedTargets = new Set(
    [...prevSlots.values()]
      .filter((prev) => !nextSlots.some((next) => next.slot === prev.slot))
      .map((prev) => prev.target),
  )
  variables = variables.filter((variable) => !removedTargets.has(variable.uid))

  let next: ForgeProject = { ...project, variables }
  let nextContract: CardContract = {
    ...contract,
    slots: contract.slots
      .filter((s) => !(s.stage === "variables" && s.kind === "variable"))
      .concat(nextSlots),
  }
  if (draft.updateRules.trim()) {
    next = { ...next, hooks: hooksFromRules(draft.updateRules) }
    nextContract = recordFieldSlots(nextContract, "variables", ["hooks"], "InitVar")
  }
  return { project: next, contract: nextContract }
}

/** Land one confirmed stage into the project and stamp the contract. */
export function applyStage(
  project: ForgeProject,
  contractIn: CardContract | null,
  draft: StageDraft,
  now: number,
): ApplyResult {
  const contract = contractIn ?? emptyContract()
  let result: ApplyResult

  switch (draft.stage) {
    case "worldview":
      result = upsertStageLore(project, contract, "worldview", draft.entries)
      break
    case "basics": {
      const next = {
        ...project,
        name: draft.name,
        description: draft.description,
        tags: draft.tags.join(", "),
      }
      result = {
        project: next,
        contract: recordFieldSlots(contract, "basics", ["name", "description", "tags"], draft.name),
      }
      break
    }
    case "palette": {
      const next = { ...project, personality: personalityFromPalette(draft) }
      result = {
        project: next,
        contract: recordFieldSlots(contract, "palette", ["personality"], characterLabel(project)),
      }
      break
    }
    case "facets": {
      const label = characterLabel(project)
      const entries = draft.facets.map((facet, index) => ({
        slot: `facet:${index}`,
        title: facet.name,
        content: facetContent(facet),
        keys: [],
        layer: "constant" as const,
        secret: false,
        sourceLabel: label,
      }))
      result = upsertStageLore(project, contract, "facets", entries)
      break
    }
    case "exegesis":
      result = upsertStageLore(project, contract, "exegesis", [
        {
          slot: "exegesis",
          // i18n-exempt: lorebook entry titles are card CONTENT the model reads,
          // not studio chrome — they ship inside the exported card verbatim.
          title: "二次解释 · Author's Exegesis",
          content: draft.text,
          keys: [],
          layer: "constant",
          secret: true,
          sourceLabel: characterLabel(project),
        },
      ])
      break
    case "wardrobe":
      result = upsertStageLore(project, contract, "wardrobe", draft.entries)
      break
    case "nsfw": {
      const entries: WizardLoreDraft[] = [
        {
          slot: "nsfw:motivation",
          // i18n-exempt: card CONTENT, see the exegesis entry above.
          title: "亲密动机 · Intimacy Core",
          content: draft.motivation,
          keys: [],
          layer: "constant",
          secret: true,
          sourceLabel: "nsfw",
        },
        ...draft.entries.map((entry) => ({ ...entry, secret: true })),
      ]
      result = upsertStageLore(project, contract, "nsfw", entries)
      break
    }
    case "npcs": {
      const entries = draft.npcs.map((npc) => ({
        slot: `npc:${npc.name}`,
        title: npc.name,
        content: npc.role ? `${npc.role}\n${npc.content}` : npc.content,
        keys: npc.keys.length > 0 ? npc.keys : [npc.name],
        layer: "triggered" as const,
        secret: false,
        sourceLabel: npc.name,
      }))
      result = upsertStageLore(project, contract, "npcs", entries)
      break
    }
    case "overview":
      result = upsertStageLore(project, contract, "overview", [
        {
          slot: "overview",
          // i18n-exempt: card CONTENT, see the exegesis entry above.
          title: "角色速览 · Quick Reference",
          content: draft.content,
          keys: [],
          layer: "constant",
          secret: false,
          sourceLabel: characterLabel(project),
        },
      ])
      break
    case "opening": {
      const next = {
        ...project,
        firstMes: draft.firstMes,
        mesExample: draft.mesExample,
        alternateGreetings: draft.alternateGreetings.filter((greeting) => greeting.trim().length > 0),
      }
      result = {
        project: next,
        contract: recordFieldSlots(
          contract,
          "opening",
          ["firstMes", "mesExample", "alternateGreetings"],
          characterLabel(project),
        ),
      }
      break
    }
    case "variables":
      result = applyVariables(project, contract, draft)
      break
  }

  result.contract = {
    ...result.contract,
    confirmedAt: { ...result.contract.confirmedAt, [draft.stage]: now },
  }
  return result
}
