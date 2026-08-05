// The staged co-creation wizard's registry: eleven stages, run in order, each
// one "guided questions → author answers → AI structures → author confirms →
// lands in the project". The methodology distills the three most-loved
// community card tools; the Loreweaver-specific "variables" stage closes with
// [InitVar] YAML + typed trackers.
//
// Design rule #1 (outranking the stage list itself): the mandatory-manual
// slots. Personality derivations, the second exegesis, and the NSFW motivation
// are ALWAYS typed by the author — the AI contributes guiding questions and
// examples only. That is enforced three times: prompts forbid it, the schema
// gates never read those fields from model output, and the UI marks the slots
// as handwritten-only.

import { parseInitvar } from "../split/mvu"

export type StageId =
  | "worldview"
  | "basics"
  | "palette"
  | "facets"
  | "exegesis"
  | "wardrobe"
  | "nsfw"
  | "npcs"
  | "overview"
  | "opening"
  | "variables"

/** Worldview stage path: real-world backdrop / small iterated world / big
 * layered world (constant core + triggered detail). */
export type WorldPath = "real" | "small" | "large"

/** One wizard-drafted worldbook entry. `slot` is the stable per-stage key the
 * contract maps to a project uid — regeneration keeps the uid, so downstream
 * references survive. */
export interface WizardLoreDraft {
  slot: string
  title: string
  content: string
  keys: string[]
  /** Blue light (constant, always in prompt) vs green light (keyword-triggered). */
  layer: "constant" | "triggered"
  secret: boolean
  /** Source tag for tracking: the worldview, the character's name, an NPC's name. */
  sourceLabel: string
}

export interface PaletteColor {
  /** e.g. 底色 "自卑", 主色调 "好胜" */
  name: string
  /** What this trait looks like in behavior, written as observable facts. */
  detail: string
  /** MANDATORY-MANUAL: the scene→behavior→line closed loops. Never AI-written;
   * the schema gate discards any model attempt to fill it. */
  derivation: string
}

/** One face of the three-facet model — gears of ONE engine, not three
 * personalities. Every facet keeps trigger/energy/voice/body/function plus the
 * bleed-through into the other facets. */
export interface CharacterFacet {
  name: string
  trigger: string
  energy: string
  voice: string
  body: string
  role: string
  bleed: string
}

export interface NpcDraft {
  name: string
  role: string
  content: string
  keys: string[]
}

export type StageDraft =
  | { stage: "worldview"; path: WorldPath; entries: WizardLoreDraft[] }
  | { stage: "basics"; name: string; tags: string[]; description: string }
  | { stage: "palette"; base: PaletteColor; mains: PaletteColor[]; accent: PaletteColor | null }
  | { stage: "facets"; facets: CharacterFacet[] }
  | { stage: "exegesis"; text: string }
  | { stage: "wardrobe"; entries: WizardLoreDraft[] }
  | { stage: "nsfw"; motivation: string; entries: WizardLoreDraft[] }
  | { stage: "npcs"; npcs: NpcDraft[] }
  | { stage: "overview"; content: string }
  | { stage: "opening"; firstMes: string; mesExample: string; alternateGreetings: string[] }
  | { stage: "variables"; initvarYaml: string; updateRules: string }

export type ManualSlot = "derivations" | "exegesis" | "motivation"

export interface StageMeta {
  id: StageId
  /** Optional stages may be skipped outright (facets, nsfw). */
  optional: boolean
  /** Hidden entirely unless the session's NSFW toggle is on. */
  nsfwGated: boolean
  /** Number of static guided questions (i18n keys studio.wizard.stages.<id>.q1..qN). */
  questions: number
  /** The mandatory-manual slot this stage carries, if any. */
  manual: ManualSlot | null
  /** False for handwriting-only stages (exegesis): no AI structuring pass at all. */
  aiAssisted: boolean
}

export const STAGES: StageMeta[] = [
  { id: "worldview", optional: false, nsfwGated: false, questions: 4, manual: null, aiAssisted: true },
  { id: "basics", optional: false, nsfwGated: false, questions: 4, manual: null, aiAssisted: true },
  { id: "palette", optional: false, nsfwGated: false, questions: 4, manual: "derivations", aiAssisted: true },
  { id: "facets", optional: true, nsfwGated: false, questions: 4, manual: null, aiAssisted: true },
  { id: "exegesis", optional: false, nsfwGated: false, questions: 3, manual: "exegesis", aiAssisted: false },
  { id: "wardrobe", optional: false, nsfwGated: false, questions: 3, manual: null, aiAssisted: true },
  { id: "nsfw", optional: true, nsfwGated: true, questions: 3, manual: "motivation", aiAssisted: true },
  { id: "npcs", optional: false, nsfwGated: false, questions: 3, manual: null, aiAssisted: true },
  { id: "overview", optional: false, nsfwGated: false, questions: 2, manual: null, aiAssisted: true },
  { id: "opening", optional: false, nsfwGated: false, questions: 3, manual: null, aiAssisted: true },
  { id: "variables", optional: false, nsfwGated: false, questions: 3, manual: null, aiAssisted: true },
]

export const STAGE_ORDER: StageId[] = STAGES.map((meta) => meta.id)

export function stageMeta(id: StageId): StageMeta {
  const meta = STAGES.find((entry) => entry.id === id)
  if (meta === undefined) throw new Error(`unknown wizard stage: ${id}`)
  return meta
}

/** The stages a session actually walks (drops nsfw-gated ones when off). */
export function visibleStages(nsfwEnabled: boolean): StageMeta[] {
  return STAGES.filter((meta) => !meta.nsfwGated || nsfwEnabled)
}

/** The prose fields of a draft, split by authorship for the lint UI: `ai`
 * fields feed the one-click rewrite loop; `manual` fields are the author's —
 * hits there are shown as advisory only and never sent for AI rewriting. */
export function draftProseFields(draft: StageDraft): {
  ai: Record<string, string>
  manual: Record<string, string>
} {
  const ai: Record<string, string> = {}
  const manual: Record<string, string> = {}
  switch (draft.stage) {
    case "worldview":
    case "wardrobe":
      for (const entry of draft.entries) ai[entry.title || entry.slot] = entry.content
      break
    case "basics":
      ai.description = draft.description
      break
    case "palette":
      ai[draft.base.name || "base"] = draft.base.detail
      for (const main of draft.mains) {
        ai[main.name || "main"] = main.detail
        if (main.derivation) manual[main.name || "main"] = main.derivation
      }
      if (draft.accent !== null) ai[draft.accent.name || "accent"] = draft.accent.detail
      break
    case "facets":
      for (const facet of draft.facets) {
        ai[facet.name || "facet"] = [facet.trigger, facet.energy, facet.voice, facet.body, facet.bleed]
          .filter(Boolean)
          .join("\n")
      }
      break
    case "exegesis":
      manual.exegesis = draft.text
      break
    case "nsfw":
      for (const entry of draft.entries) ai[entry.title || entry.slot] = entry.content
      if (draft.motivation) manual.motivation = draft.motivation
      break
    case "npcs":
      for (const npc of draft.npcs) ai[npc.name || "npc"] = npc.content
      break
    case "overview":
      ai.overview = draft.content
      break
    case "opening":
      ai.first_mes = draft.firstMes
      if (draft.mesExample.trim()) ai.mes_example = draft.mesExample
      draft.alternateGreetings.forEach((greeting, index) => {
        if (greeting.trim()) ai[`alternate_${index + 1}`] = greeting
      })
      break
    case "variables":
      break
  }
  return { ai, manual }
}

/** An empty, editable draft for a stage — the hand-first path. EVERY stage has
 * one, so the wizard never dead-ends when no AI provider is configured; the
 * confirm gate below still holds each draft to its stage's requirements. */
export function blankDraft(stage: StageId, path: WorldPath): StageDraft {
  switch (stage) {
    case "worldview":
      return { stage, path, entries: [] }
    case "basics":
      return { stage, name: "", tags: [], description: "" }
    case "palette":
      return {
        stage,
        base: { name: "", detail: "", derivation: "" },
        mains: [{ name: "", detail: "", derivation: "" }],
        accent: null,
      }
    case "facets":
      return {
        stage,
        facets: [{ name: "", trigger: "", energy: "", voice: "", body: "", role: "", bleed: "" }],
      }
    case "exegesis":
      return { stage, text: "" }
    case "wardrobe":
      return { stage, entries: [] }
    case "nsfw":
      return { stage, motivation: "", entries: [] }
    case "npcs":
      return { stage, npcs: [] }
    case "overview":
      return { stage, content: "" }
    case "opening":
      return { stage, firstMes: "", mesExample: "", alternateGreetings: [] }
    case "variables":
      return { stage, initvarYaml: "", updateRules: "" }
  }
}

/** Why a confirm is refused — i18n keys under studio.wizard.block.*. */
export type ConfirmBlock =
  | "noDraft"
  | "nameRequired"
  | "entriesRequired"
  | "derivationRequired"
  | "exegesisRequired"
  | "motivationRequired"
  | "contentRequired"
  | "yamlUnparseable"

/** The deterministic confirm gate: what must hold before a stage may land.
 * This is where the mandatory-manual rule bites — empty handwritten slots
 * block the confirm, no matter how complete the AI structuring looks. */
export function confirmBlocks(draft: StageDraft | null): ConfirmBlock[] {
  if (draft === null) return ["noDraft"]
  const blocks: ConfirmBlock[] = []
  switch (draft.stage) {
    case "worldview":
      if (draft.entries.length === 0) blocks.push("entriesRequired")
      break
    case "basics":
      if (!draft.name.trim()) blocks.push("nameRequired")
      if (!draft.description.trim()) blocks.push("contentRequired")
      break
    case "palette":
      if (draft.mains.length === 0) blocks.push("entriesRequired")
      if (draft.mains.some((color) => !color.derivation.trim())) blocks.push("derivationRequired")
      break
    case "facets":
      if (draft.facets.length === 0) blocks.push("entriesRequired")
      break
    case "exegesis":
      if (!draft.text.trim()) blocks.push("exegesisRequired")
      break
    case "nsfw":
      if (!draft.motivation.trim()) blocks.push("motivationRequired")
      break
    case "overview":
      if (!draft.content.trim()) blocks.push("contentRequired")
      break
    case "opening":
      if (!draft.firstMes.trim()) blocks.push("contentRequired")
      break
    case "variables":
      if (parseInitvar(draft.initvarYaml) === null) blocks.push("yamlUnparseable")
      break
    case "wardrobe":
    case "npcs":
      // Empty is legal: "this card has no NPCs" is a confirmable answer.
      break
  }
  return blocks
}
