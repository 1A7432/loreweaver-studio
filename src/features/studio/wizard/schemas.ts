// Deterministic gates for every wizard stage — same iron rule as ai/schemas.ts:
// the model DRAFTS, code DECIDES. Each gate coerces the JSON block field by
// field and hands `draftWithRetries` an English problem list on failure.
//
// The mandatory-manual defense lives here too: the palette gate NEVER reads a
// "derivation" field and the nsfw gate NEVER reads "motivation" — even a model
// that ignores the prompt cannot land words in the author's handwritten slots.

import { asText, isRecord } from "../split/charcard"
import { flattenLeaves, parseInitvar } from "../split/mvu"
import { promoteLeaves } from "../split/promote"
import type {
  CharacterFacet,
  NpcDraft,
  PaletteColor,
  StageDraft,
  StageId,
  WizardLoreDraft,
  WorldPath,
} from "./stages"

export interface StageGateContext {
  /** The author's worldview-path choice (UI state, never model output). */
  path: WorldPath
  /** Character display name for source labels ("" before basics lands). */
  characterName: string
}

export interface GateResult {
  value: StageDraft | null
  problems: string[]
}

function listOfStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter((item) => item.length > 0)
  const text = asText(value)
  return text
    ? text
        .split(/[\n,，、]/)
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

/** Coerce one worldbook-entry draft; `layer` defaults from the keys (has
 * trigger keys → triggered, none → constant), and a triggered entry without
 * keys is a hard problem — it could never fire. */
function gateLoreEntries(
  raw: unknown,
  scope: string,
  slotPrefix: string,
  sourceLabel: string,
  problems: string[],
  defaultLayer?: "constant" | "triggered",
): WizardLoreDraft[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    problems.push(`${scope}: must be an array`)
    return []
  }
  const entries: WizardLoreDraft[] = []
  raw.forEach((item, index) => {
    if (!isRecord(item)) {
      problems.push(`${scope}[${index}]: must be an object`)
      return
    }
    const title = asText(item.title)
    const content = asText(item.content)
    if (!title) problems.push(`${scope}[${index}].title: required`)
    if (!content) problems.push(`${scope}[${index}].content: required`)
    const keys = listOfStrings(item.keys)
    const rawLayer = asText(item.layer)
    let layer: "constant" | "triggered"
    if (rawLayer === "constant" || rawLayer === "triggered") layer = rawLayer
    else if (rawLayer) {
      problems.push(`${scope}[${index}].layer: "${rawLayer}" must be constant|triggered`)
      layer = "triggered"
    } else layer = defaultLayer ?? (keys.length > 0 ? "triggered" : "constant")
    if (layer === "triggered" && keys.length === 0) {
      problems.push(`${scope}[${index}].keys: a triggered entry needs at least one trigger keyword`)
    }
    entries.push({
      slot: `${slotPrefix}:${index}`,
      title,
      content,
      keys,
      layer,
      secret: item.secret === true,
      sourceLabel,
    })
  })
  return entries
}

function gatePaletteColor(raw: unknown, scope: string, problems: string[]): PaletteColor {
  // NOTE: no `derivation` read on purpose — that slot is handwritten-only.
  if (!isRecord(raw)) {
    problems.push(`${scope}: must be an object {name, detail}`)
    return { name: "", detail: "", derivation: "" }
  }
  const name = asText(raw.name)
  if (!name) problems.push(`${scope}.name: required`)
  return { name, detail: asText(raw.detail), derivation: "" }
}

function gateWorldview(parsed: Record<string, unknown>, ctx: StageGateContext): GateResult {
  const problems: string[] = []
  const entries = gateLoreEntries(parsed.entries, "entries", "wv", "worldview", problems)
  if (entries.length === 0) problems.push("entries: at least one worldbook entry is required")
  if (ctx.path === "large" && !entries.some((entry) => entry.layer === "constant")) {
    problems.push("entries: a large world needs a constant core layer (mark the always-on truths constant)")
  }
  if (problems.length > 0) return { value: null, problems }
  return { value: { stage: "worldview", path: ctx.path, entries }, problems: [] }
}

function gateBasics(parsed: Record<string, unknown>): GateResult {
  const problems: string[] = []
  const name = asText(parsed.name)
  const description = asText(parsed.description)
  if (!name) problems.push("name: required")
  if (!description) problems.push("description: required")
  if (problems.length > 0) return { value: null, problems }
  return { value: { stage: "basics", name, tags: listOfStrings(parsed.tags), description }, problems: [] }
}

function gatePalette(parsed: Record<string, unknown>): GateResult {
  const problems: string[] = []
  const base = gatePaletteColor(parsed.base, "base", problems)
  const rawMains = Array.isArray(parsed.mains) ? parsed.mains : []
  if (rawMains.length < 1 || rawMains.length > 2) {
    problems.push("mains: exactly 1-2 main colors")
  }
  const mains = rawMains.slice(0, 2).map((raw, i) => gatePaletteColor(raw, `mains[${i}]`, problems))
  const accent =
    parsed.accent === undefined || parsed.accent === null
      ? null
      : gatePaletteColor(parsed.accent, "accent", problems)
  if (problems.length > 0) return { value: null, problems }
  return { value: { stage: "palette", base, mains, accent }, problems: [] }
}

function gateFacets(parsed: Record<string, unknown>): GateResult {
  const problems: string[] = []
  const rawFacets = Array.isArray(parsed.facets) ? parsed.facets : []
  if (rawFacets.length < 1 || rawFacets.length > 3) problems.push("facets: 1-3 facets")
  const facets: CharacterFacet[] = rawFacets.slice(0, 3).map((raw, index) => {
    if (!isRecord(raw)) {
      problems.push(`facets[${index}]: must be an object`)
      return { name: "", trigger: "", energy: "", voice: "", body: "", role: "", bleed: "" }
    }
    const name = asText(raw.name)
    const trigger = asText(raw.trigger)
    if (!name) problems.push(`facets[${index}].name: required`)
    if (!trigger) problems.push(`facets[${index}].trigger: required`)
    return {
      name,
      trigger,
      energy: asText(raw.energy),
      voice: asText(raw.voice),
      body: asText(raw.body),
      role: asText(raw.function) || asText(raw.role),
      bleed: asText(raw.bleed),
    }
  })
  if (problems.length > 0) return { value: null, problems }
  return { value: { stage: "facets", facets }, problems: [] }
}

function gateWardrobe(parsed: Record<string, unknown>, ctx: StageGateContext): GateResult {
  const problems: string[] = []
  const label = ctx.characterName || "character"
  const entries = gateLoreEntries(parsed.entries, "entries", "wd", label, problems, "triggered")
  if (problems.length > 0) return { value: null, problems }
  return { value: { stage: "wardrobe", entries }, problems: [] }
}

function gateNsfw(parsed: Record<string, unknown>): GateResult {
  // NOTE: no `motivation` read on purpose — handwritten-only.
  const problems: string[] = []
  const entries = gateLoreEntries(parsed.entries, "entries", "nsfw", "nsfw", problems, "triggered")
  if (problems.length > 0) return { value: null, problems }
  return { value: { stage: "nsfw", motivation: "", entries }, problems: [] }
}

function gateNpcs(parsed: Record<string, unknown>): GateResult {
  const problems: string[] = []
  const rawNpcs = Array.isArray(parsed.npcs) ? parsed.npcs : []
  const seen = new Set<string>()
  const npcs: NpcDraft[] = []
  rawNpcs.forEach((raw, index) => {
    if (!isRecord(raw)) {
      problems.push(`npcs[${index}]: must be an object`)
      return
    }
    const name = asText(raw.name)
    const content = asText(raw.content)
    if (!name) problems.push(`npcs[${index}].name: required`)
    if (!content) problems.push(`npcs[${index}].content: required`)
    if (name && seen.has(name)) problems.push(`npcs[${index}].name: duplicate "${name}"`)
    seen.add(name)
    const keys = listOfStrings(raw.keys)
    npcs.push({ name, role: asText(raw.role), content, keys: keys.length > 0 ? keys : [name] })
  })
  if (problems.length > 0) return { value: null, problems }
  return { value: { stage: "npcs", npcs }, problems: [] }
}

function gateOverview(parsed: Record<string, unknown>): GateResult {
  const content = asText(parsed.content)
  if (!content) return { value: null, problems: ["content: required"] }
  return { value: { stage: "overview", content }, problems: [] }
}

function gateOpening(parsed: Record<string, unknown>): GateResult {
  const firstMes = asText(parsed.first_mes) || asText(parsed.firstMes)
  if (!firstMes) return { value: null, problems: ["first_mes: required"] }
  const alternates = Array.isArray(parsed.alternate_greetings)
    ? parsed.alternate_greetings
        .map(asText)
        .filter((greeting) => greeting.length > 0)
        .slice(0, 3)
    : []
  return {
    value: {
      stage: "opening",
      firstMes,
      mesExample: asText(parsed.mes_example),
      alternateGreetings: alternates,
    },
    problems: [],
  }
}

function gateVariables(parsed: Record<string, unknown>): GateResult {
  const problems: string[] = []
  const initvarYaml = asText(parsed.initvar_yaml)
  if (!initvarYaml) {
    return { value: null, problems: ["initvar_yaml: required (a YAML mapping of initial variables)"] }
  }
  const tree = parseInitvar(initvarYaml)
  if (tree === null) {
    return {
      value: null,
      problems: ["initvar_yaml: not parseable as an [InitVar] mapping (YAML block mapping or JSON5 object)"],
    }
  }
  const promotable = promoteLeaves(flattenLeaves(tree).leaves).filter((draft) => draft.include)
  if (promotable.length === 0) {
    problems.push("initvar_yaml: no promotable scalar leaves (numbers, booleans, strings)")
  }
  if (problems.length > 0) return { value: null, problems }
  return {
    value: { stage: "variables", initvarYaml, updateRules: asText(parsed.update_rules) },
    problems: [],
  }
}

/** The gate for one stage, ready to hand to `draftWithRetries`. */
export function stageGate(stage: StageId, ctx: StageGateContext): (parsed: unknown) => GateResult {
  return (parsed: unknown): GateResult => {
    if (!isRecord(parsed)) return { value: null, problems: ["reply must be a single JSON object"] }
    switch (stage) {
      case "worldview":
        return gateWorldview(parsed, ctx)
      case "basics":
        return gateBasics(parsed)
      case "palette":
        return gatePalette(parsed)
      case "facets":
        return gateFacets(parsed)
      case "exegesis":
        return { value: null, problems: ["exegesis is handwritten-only — no AI structuring pass exists"] }
      case "wardrobe":
        return gateWardrobe(parsed, ctx)
      case "nsfw":
        return gateNsfw(parsed)
      case "npcs":
        return gateNpcs(parsed)
      case "overview":
        return gateOverview(parsed)
      case "opening":
        return gateOpening(parsed)
      case "variables":
        return gateVariables(parsed)
    }
  }
}

/** A draft back in the model's wire shape — the YAML preview and the rewrite
 * loop's assistant turn both use this. Handwritten fields (derivations, the
 * motivation, the exegesis) are NOT serialized: they never travel to the model. */
export function stageDraftToWire(draft: StageDraft): Record<string, unknown> {
  const wireLore = (entries: WizardLoreDraft[]) =>
    entries.map((entry) => ({
      title: entry.title,
      content: entry.content,
      keys: entry.keys,
      layer: entry.layer,
      secret: entry.secret,
    }))
  switch (draft.stage) {
    case "worldview":
      return { entries: wireLore(draft.entries) }
    case "basics":
      return { name: draft.name, tags: draft.tags, description: draft.description }
    case "palette": {
      const color = (c: PaletteColor) => ({ name: c.name, detail: c.detail })
      return {
        base: color(draft.base),
        mains: draft.mains.map(color),
        accent: draft.accent !== null ? color(draft.accent) : null,
      }
    }
    case "facets":
      return {
        facets: draft.facets.map((facet) => ({
          name: facet.name,
          trigger: facet.trigger,
          energy: facet.energy,
          voice: facet.voice,
          body: facet.body,
          function: facet.role,
          bleed: facet.bleed,
        })),
      }
    case "exegesis":
      return {}
    case "wardrobe":
      return { entries: wireLore(draft.entries) }
    case "nsfw":
      return { entries: wireLore(draft.entries) }
    case "npcs":
      return {
        npcs: draft.npcs.map((npc) => ({
          name: npc.name,
          role: npc.role,
          content: npc.content,
          keys: npc.keys,
        })),
      }
    case "overview":
      return { content: draft.content }
    case "opening":
      return {
        first_mes: draft.firstMes,
        mes_example: draft.mesExample,
        alternate_greetings: draft.alternateGreetings,
      }
    case "variables":
      return { initvar_yaml: draft.initvarYaml, update_rules: draft.updateRules }
  }
}

export interface GuidanceDraft {
  questions: string[]
  example: string
}

/** Gate for the "help me ask" pass on handwritten slots: questions and ONE
 * clearly-separate example are all the model may deliver — never the content. */
export function gateGuidance(parsed: unknown): { value: GuidanceDraft | null; problems: string[] } {
  if (!isRecord(parsed)) return { value: null, problems: ["reply must be a single JSON object"] }
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map(asText).filter((q) => q.length > 0)
    : []
  if (questions.length < 1 || questions.length > 8) {
    return { value: null, problems: ["questions: 1-8 non-empty guiding questions"] }
  }
  return { value: { questions, example: asText(parsed.example) }, problems: [] }
}

/** Re-attach the author's handwritten slots after a re-structuring pass:
 * palette derivations follow the color NAME first (index as fallback), the
 * nsfw motivation carries over verbatim. AI output never reaches these fields
 * (the gates above guarantee it), so whatever lives here is the author's. */
export function carryManualSlots(prev: StageDraft | null, next: StageDraft): StageDraft {
  if (prev === null || prev.stage !== next.stage) return next
  if (next.stage === "palette" && prev.stage === "palette") {
    const mains = next.mains.map((main, index) => {
      const byName = prev.mains.find((old) => old.name === main.name)
      const source = byName ?? prev.mains[index]
      return source !== undefined && source.derivation.trim()
        ? { ...main, derivation: source.derivation }
        : main
    })
    const base =
      prev.base.derivation.trim() && !next.base.derivation
        ? { ...next.base, derivation: prev.base.derivation }
        : next.base
    return { ...next, base, mains }
  }
  if (next.stage === "nsfw" && prev.stage === "nsfw") {
    return { ...next, motivation: prev.motivation }
  }
  return next
}
