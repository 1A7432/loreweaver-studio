// SillyTavern completion-preset import. These files are the community's
// standard distribution shape for prompt collections: top-level sampling
// knobs, a flat `prompts[]` pool, a SECOND per-character enable matrix in
// `prompt_order[]` (an entry is live only when BOTH layers say enabled, and
// the final sequence comes from the order list), plus ST-only `extensions`.
// Import is tolerant but never lossy: unknown fields land in `rawTopLevel`,
// every prompt keeps its original object in `raw`, and entries too broken to
// normalize are preserved verbatim in `malformedPrompts`.

import { z } from "zod"
import type { LlmSamplingParams } from "../../../lib/native"

// --- marker slots -----------------------------------------------------------
// Eight predefined `marker: true` identifiers. Their content is empty in ST:
// they are ORDER ANCHORS the runtime fills with its own context (persona,
// character fields, world info, chat history). They must never be injected as
// literal prompt text — assembly maps them to caller-provided slot content.

export const MARKER_SLOTS = [
  "personaDescription",
  "charDescription",
  "charPersonality",
  "scenario",
  "worldInfoBefore",
  "worldInfoAfter",
  "dialogueExamples",
  "chatHistory",
] as const

export type MarkerSlot = (typeof MARKER_SLOTS)[number]

export function isMarkerSlot(identifier: string): identifier is MarkerSlot {
  return (MARKER_SLOTS as readonly string[]).includes(identifier)
}

// --- normalized shapes ------------------------------------------------------

export interface StSampling {
  temperature?: number
  topP?: number
  topK?: number
  topA?: number
  minP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  repetitionPenalty?: number
  /** ST uses -1 for "random"; kept verbatim, filtered at send time. */
  seed?: number
  n?: number
  /** From `openai_max_tokens` — display only; the studio's own limit wins. */
  maxTokens?: number
  /** From `openai_max_context` — display only. */
  maxContext?: number
}

export interface StPromptEntry {
  identifier: string
  name: string
  /** Forced to "" for markers — their content is an anchor, not prompt text. */
  content: string
  role: "system" | "assistant" | "user"
  /** First enable layer (`prompts[].enabled`; missing means enabled). */
  enabled: boolean
  marker: boolean
  /** The 8 known slots; null for a marker with an unrecognized identifier. */
  slot: MarkerSlot | null
  systemPrompt: boolean
  forbidOverrides: boolean
  /** 0 = relative (follows the order list), 1 = absolute (depth-injected). */
  injectionPosition: 0 | 1
  injectionDepth: number
  injectionOrder?: number
  /** The original entry, verbatim — nothing is dropped on import. */
  raw: Record<string, unknown>
}

export interface StOrderRef {
  identifier: string
  /** Second enable layer — independent from `prompts[].enabled`. */
  enabled: boolean
}

export interface StOrderGroup {
  /** ST's pseudo character ids: 100001 is the modern global default. */
  characterId: string | null
  order: StOrderRef[]
}

export interface MacroUse {
  name: string
  count: number
  /** Whether THIS runtime expands it (see SUPPORTED_MACROS). */
  supported: boolean
}

export interface MacroReport {
  total: number
  uses: MacroUse[]
}

export interface StPresetImport {
  name: string
  sampling: StSampling
  prompts: StPromptEntry[]
  promptOrder: StOrderGroup[]
  /** ST-only machinery (regex_scripts, tavern_helper, …) — carried, never run. */
  extensions: Record<string, unknown>
  /** Every top-level field we did not map — kept so nothing is discarded. */
  rawTopLevel: Record<string, unknown>
  /** Prompt entries too broken to normalize, verbatim. */
  malformedPrompts: unknown[]
  macroReport: MacroReport
  warnings: string[]
}

// --- tolerant field schemas -------------------------------------------------
// Per-field `.catch()` mirrors the split/mvu.ts philosophy: a single odd field
// degrades to its ST default instead of sinking the whole 250-entry file; only
// a missing/empty identifier disqualifies an entry (into malformedPrompts).

const identifierSchema = z.union([z.string().min(1), z.number()]).transform((value) => String(value))

const promptEntrySchema = z.object({
  identifier: identifierSchema,
  name: z.string().catch(""),
  content: z.string().catch(""),
  role: z.enum(["system", "assistant", "user"]).catch("system"),
  enabled: z.boolean().catch(true),
  marker: z.boolean().catch(false),
  system_prompt: z.boolean().catch(false),
  forbid_overrides: z.boolean().catch(false),
  injection_position: z.number().int().catch(0),
  injection_depth: z.number().int().nonnegative().catch(4),
  injection_order: z.number().int().optional().catch(undefined),
})

const orderRefSchema = z.object({
  identifier: identifierSchema,
  enabled: z.boolean().catch(true),
})

const orderGroupSchema = z.object({
  character_id: z.union([z.string(), z.number()]).optional().catch(undefined),
  order: z.array(z.unknown()).catch([]),
})

const SAMPLING_KEYS: Record<string, keyof StSampling> = {
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK",
  top_a: "topA",
  min_p: "minP",
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
  repetition_penalty: "repetitionPenalty",
  seed: "seed",
  n: "n",
  openai_max_tokens: "maxTokens",
  openai_max_context: "maxContext",
}

const STRUCTURAL_KEYS = new Set(["prompts", "prompt_order", "extensions"])

// --- macros -----------------------------------------------------------------
// These presets lean on {{setvar::…}}/{{getvar::…}}/{{random::…}} far more
// than the classic {{char}}/{{user}}. Content is kept verbatim — no static
// expansion — and the import produces a capability report instead.

/** Macros this runtime actually expands during assembly. Currently none: the
 * card-forge sends preset text verbatim, so every macro reaches the model
 * as-is. Grow this set when real expansion lands. */
export const SUPPORTED_MACROS: ReadonlySet<string> = new Set()

const MACRO_RE = /\{\{([^{}]*)\}\}/g

/** `{{setvar::x::1}}` → setvar, `{{random:a,b}}` → random, `{{// note}}` → "//". */
function macroName(body: string): string {
  const trimmed = body.trim()
  if (trimmed.startsWith("//")) return "//"
  const head = trimmed.split("::")[0].split(":")[0].trim().toLowerCase()
  return head
}

export function scanMacros(prompts: readonly StPromptEntry[]): MacroReport {
  const counts = new Map<string, number>()
  let total = 0
  for (const prompt of prompts) {
    if (prompt.marker) continue
    for (const match of prompt.content.matchAll(MACRO_RE)) {
      const name = macroName(match[1])
      if (name === "") continue
      total += 1
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  const uses = [...counts.entries()]
    .map(([name, count]) => ({ name, count, supported: SUPPORTED_MACROS.has(name) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return { total, uses }
}

// --- parsing ----------------------------------------------------------------

export interface ParseStPresetResult {
  preset: StPresetImport | null
  /** Non-null only when the file is unusable (bad JSON / not an object). */
  error: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizePrompt(rawEntry: Record<string, unknown>, warnings: string[]): StPromptEntry | null {
  const parsed = promptEntrySchema.safeParse(rawEntry)
  if (!parsed.success) return null
  const fields = parsed.data
  const marker = fields.marker
  const slot = marker && isMarkerSlot(fields.identifier) ? (fields.identifier as MarkerSlot) : null
  if (marker && slot === null) {
    warnings.push(`marker "${fields.identifier}" is not one of the 8 standard slots`)
  }
  if (marker && fields.content.trim() !== "") {
    warnings.push(`marker "${fields.identifier}" carried content — treated as an anchor, content ignored`)
  }
  return {
    identifier: fields.identifier,
    name: fields.name,
    content: marker ? "" : fields.content,
    role: fields.role,
    enabled: fields.enabled,
    marker,
    slot,
    systemPrompt: fields.system_prompt,
    forbidOverrides: fields.forbid_overrides,
    injectionPosition: fields.injection_position === 1 ? 1 : 0,
    injectionDepth: fields.injection_depth,
    injectionOrder: fields.injection_order,
    raw: rawEntry,
  }
}

function normalizeOrderGroups(value: unknown, warnings: string[]): StOrderGroup[] {
  if (!Array.isArray(value)) {
    if (value !== undefined) warnings.push("prompt_order is not an array — ignored")
    return []
  }
  const groups: StOrderGroup[] = []
  for (const rawGroup of value) {
    const record = asRecord(rawGroup)
    if (record === null) {
      warnings.push("prompt_order carried a non-object group — skipped")
      continue
    }
    const parsed = orderGroupSchema.safeParse(record)
    if (!parsed.success) {
      warnings.push("prompt_order group failed to parse — skipped")
      continue
    }
    const refs: StOrderRef[] = []
    for (const rawRef of parsed.data.order) {
      const ref = orderRefSchema.safeParse(rawRef)
      if (ref.success) refs.push(ref.data)
      else warnings.push("prompt_order entry without identifier — skipped")
    }
    groups.push({
      characterId: parsed.data.character_id === undefined ? null : String(parsed.data.character_id),
      order: refs,
    })
  }
  return groups
}

function extractSampling(
  top: Record<string, unknown>,
  warnings: string[],
): { sampling: StSampling; consumed: Set<string> } {
  const sampling: StSampling = {}
  const consumed = new Set<string>()
  for (const [stKey, ourKey] of Object.entries(SAMPLING_KEYS)) {
    if (!(stKey in top)) continue
    const parsed = z.number().finite().safeParse(top[stKey])
    if (parsed.success) {
      sampling[ourKey] = parsed.data
      consumed.add(stKey)
    } else {
      // Left in rawTopLevel so the odd value is still carried, just not mapped.
      warnings.push(`sampling field "${stKey}" is not a finite number — kept raw only`)
    }
  }
  return { sampling, consumed }
}

/** Parse one ST completion-preset JSON file. Fail-closed on unusable input
 * (mirroring mvu.ts); everything recoverable degrades with a warning. */
export function parseStPreset(text: string, fallbackName: string): ParseStPresetResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (cause) {
    return { preset: null, error: cause instanceof Error ? cause.message : String(cause) }
  }
  const top = asRecord(data)
  if (top === null) return { preset: null, error: "top level is not a JSON object" }

  const warnings: string[] = []
  const prompts: StPromptEntry[] = []
  const malformedPrompts: unknown[] = []

  const rawPrompts = top.prompts
  if (rawPrompts !== undefined && !Array.isArray(rawPrompts)) {
    warnings.push("prompts is not an array — treated as a sampling-only preset")
  }
  for (const rawEntry of Array.isArray(rawPrompts) ? rawPrompts : []) {
    const record = asRecord(rawEntry)
    const normalized = record === null ? null : normalizePrompt(record, warnings)
    if (normalized === null) {
      malformedPrompts.push(rawEntry)
      warnings.push("a prompt entry had no usable identifier — kept verbatim, not normalized")
    } else {
      prompts.push(normalized)
    }
  }

  const promptOrder = normalizeOrderGroups(top.prompt_order, warnings)
  const { sampling, consumed } = extractSampling(top, warnings)

  const extensions = asRecord(top.extensions) ?? {}
  if (top.extensions !== undefined && asRecord(top.extensions) === null) {
    warnings.push("extensions is not an object — kept raw only")
  }

  const rawTopLevel: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(top)) {
    if (STRUCTURAL_KEYS.has(key) && (key !== "extensions" || asRecord(top.extensions) !== null)) continue
    if (consumed.has(key)) continue
    rawTopLevel[key] = value
  }

  const preset: StPresetImport = {
    name: fallbackName,
    sampling,
    prompts,
    promptOrder,
    extensions,
    rawTopLevel,
    malformedPrompts,
    macroReport: scanMacros(prompts),
    warnings,
  }
  return { preset, error: null }
}

// --- effective enablement + ordering ----------------------------------------

/** Pick the order list ST itself would use: pseudo-character 100001 (modern
 * global default), then 100000, then the first group present. */
export function resolveOrderGroup(groups: readonly StOrderGroup[]): StOrderGroup | null {
  return (
    groups.find((g) => g.characterId === "100001") ??
    groups.find((g) => g.characterId === "100000") ??
    groups[0] ??
    null
  )
}

export interface EffectivePrompt {
  entry: StPromptEntry
  /** Layer 1: `prompts[].enabled`. */
  promptEnabled: boolean
  /** Layer 2: the order list; null when the entry is absent from it. */
  orderEnabled: boolean | null
  /** Both layers agree AND the entry is present in the order list. */
  effective: boolean
  /** Position in the resolved order list; null when absent. */
  position: number | null
}

/** The two-layer enable matrix, resolved. Sequence: order-list entries first
 * (the order list IS the final sequence), then pool entries the order list
 * never mentions — inert, shown so nothing silently disappears. */
export function effectivePromptList(
  preset: Pick<StPresetImport, "prompts" | "promptOrder">,
): EffectivePrompt[] {
  const group = resolveOrderGroup(preset.promptOrder)
  const byIdentifier = new Map(preset.prompts.map((p) => [p.identifier, p]))
  const out: EffectivePrompt[] = []
  const placed = new Set<string>()
  for (const ref of group?.order ?? []) {
    const entry = byIdentifier.get(ref.identifier)
    if (entry === undefined || placed.has(ref.identifier)) continue
    placed.add(ref.identifier)
    out.push({
      entry,
      promptEnabled: entry.enabled,
      orderEnabled: ref.enabled,
      effective: entry.enabled && ref.enabled,
      position: out.length,
    })
  }
  for (const entry of preset.prompts) {
    if (placed.has(entry.identifier)) continue
    out.push({ entry, promptEnabled: entry.enabled, orderEnabled: null, effective: false, position: null })
  }
  return out
}

/** User tweaks from the preview UI sit in a separate override layer so the
 * imported two-layer matrix stays intact and revertible. */
export function isEffectivelyEnabled(
  view: EffectivePrompt,
  overrides: Readonly<Record<string, boolean>>,
): boolean {
  return overrides[view.entry.identifier] ?? view.effective
}

// --- assembly ---------------------------------------------------------------

export interface AssembledPrompt {
  system: string
  /** Marker slots that received caller content, in injection order. */
  usedSlots: MarkerSlot[]
  /** Effective marker slots the caller had no content for (skipped). */
  emptySlots: MarkerSlot[]
  /** Non-marker segments that made it into `system`. */
  segmentCount: number
}

/** Flatten the effective sequence into one system-prompt string. Markers are
 * replaced by the caller's slot content (never their own text); absolute
 * depth-injected entries have no chat depth to anchor to here, so they keep
 * their order-list position — a documented approximation for the card forge. */
export function assembleSystemPrompt(
  preset: Pick<StPresetImport, "prompts" | "promptOrder">,
  overrides: Readonly<Record<string, boolean>>,
  slots: Partial<Record<MarkerSlot, string>>,
): AssembledPrompt {
  const segments: string[] = []
  const usedSlots: MarkerSlot[] = []
  const emptySlots: MarkerSlot[] = []
  let segmentCount = 0
  for (const view of effectivePromptList(preset)) {
    if (view.position === null || !isEffectivelyEnabled(view, overrides)) continue
    const { entry } = view
    if (entry.marker) {
      if (entry.slot === null) continue
      const filler = slots[entry.slot]?.trim() ?? ""
      if (filler === "") {
        emptySlots.push(entry.slot)
      } else {
        segments.push(filler)
        usedSlots.push(entry.slot)
      }
      continue
    }
    const content = entry.content.trim()
    if (content === "") continue
    segments.push(content)
    segmentCount += 1
  }
  return { system: segments.join("\n\n"), usedSlots, emptySlots, segmentCount }
}

// --- sampling → wire --------------------------------------------------------

/** The keys we can actually send (standard OpenAI/Anthropic knobs). ST-only
 * knobs (top_a, min_p, repetition_penalty, n, context size) stay display-only
 * so strict endpoints never reject the request. */
export function toLlmSampling(sampling: StSampling): LlmSamplingParams {
  const out: LlmSamplingParams = {}
  if (sampling.temperature !== undefined) out.temperature = sampling.temperature
  if (sampling.topP !== undefined) out.topP = sampling.topP
  if (sampling.topK !== undefined && Number.isInteger(sampling.topK) && sampling.topK > 0) {
    out.topK = sampling.topK
  }
  if (sampling.frequencyPenalty !== undefined) out.frequencyPenalty = sampling.frequencyPenalty
  if (sampling.presencePenalty !== undefined) out.presencePenalty = sampling.presencePenalty
  if (sampling.seed !== undefined && Number.isInteger(sampling.seed) && sampling.seed >= 0) {
    out.seed = sampling.seed
  }
  return out
}

/** Present-but-not-sent sampling keys, for the "display only" badge. */
export function unsentSamplingKeys(sampling: StSampling): (keyof StSampling)[] {
  const unsent: (keyof StSampling)[] = []
  const displayOnly: (keyof StSampling)[] = [
    "topA",
    "minP",
    "repetitionPenalty",
    "n",
    "maxTokens",
    "maxContext",
  ]
  for (const key of displayOnly) {
    if (sampling[key] !== undefined) unsent.push(key)
  }
  if (sampling.seed !== undefined && sampling.seed < 0) unsent.push("seed")
  if (sampling.topK !== undefined && !(Number.isInteger(sampling.topK) && sampling.topK > 0)) {
    unsent.push("topK")
  }
  return unsent
}
