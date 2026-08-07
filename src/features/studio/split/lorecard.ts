// Loreweaver native bundle (`*.lorecard.json`) — the studio-side reader,
// mirroring the engine's `core/lorecard.py`. Two consumers:
//
//  - the pack bench turns a bundle into an `StCharacterCard` whose
//    `characterBook` holds importer-shaped entry dicts and whose `raw` is the
//    original document — exactly what the engine's parser does — so
//    `splitCard` classifies a native bundle like any other card (hooks,
//    `[InitVar]` declaration entries, `secret` lore, EJS spans);
//  - the forge imports a bundle LOSSLESSLY as a `ForgeProject` (typed specs,
//    keeper-only visibility, native `condition`/`secret` fields), closing the
//    round trip with `exportNativeBundle`.
//
// Versions: v1 is the frozen M16 consolidation shape (native field names,
// top-level `hooks`, entry `id`s, `pregens`). We ALSO read v0 — the studio's
// own historical exports — even though the engine deliberately refuses it:
// the studio is an authoring tool, and importing its old exports losslessly
// is the author's expectation. That asymmetry is intentional.
//
// Junk rows are skipped and reported as warnings, never fatal — same tolerance
// as the engine. Structural garbage (wrong format tag / version) throws.

import { asText, isRecord, type StCharacterCard } from "./charcard"
import {
  isValidVarId,
  MAX_PREGENS,
  MAX_PREGEN_SKILLS,
  newLoreEntry,
  newPregen,
  newProject,
  newVariable,
  normalizeVarId,
  type ForgeLoreEntry,
  type ForgePregen,
  type ForgeProject,
  type ForgeVariable,
  type LorePosition,
  type SelectiveLogic,
  type VarKind,
  type VarVisibility,
} from "../model"

export const LORECARD_FORMAT = "loreweaver.card"
export const SUPPORTED_FORMAT_VERSIONS = new Set<number>([0, 1])

const SELECTIVE_LOGICS = new Set<string>(["and_any", "and_all", "not_any", "not_all"])
const VAR_KINDS = new Set<string>(["number", "bool", "text", "enum"])
/** Native `"" | "before" | "after"` → the ST names the engine importer reads. */
const POSITIONS_TO_ST: Record<string, string> = { before: "before_char", after: "after_char" }

/** Cheap sniff on an already-parsed JSON document (the studio always has the
 * parse in hand before caring). Mirrors `core.lorecard.looks_like_lorecard`.
 * Deliberately NOT a type predicate: a predicate for the same record type the
 * caller already narrowed to would collapse the else-branch to `never`. */
export function looksLikeLorecard(parsed: unknown): boolean {
  return isRecord(parsed) && parsed.format === LORECARD_FORMAT
}

function requireVersion(raw: Record<string, unknown>): number {
  const version = raw.format_version
  if (typeof version !== "number" || !SUPPORTED_FORMAT_VERSIONS.has(version)) {
    throw new Error(`unsupported lorecard format_version ${String(version)}`)
  }
  return version
}

function textList(value: unknown): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : []
  return items.map((item) => asText(item).trim()).filter((item) => item.length > 0)
}

function intOr(value: unknown, fallback: number, low?: number, high?: number): number {
  let parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback
  if (low !== undefined) parsed = Math.max(low, parsed)
  if (high !== undefined) parsed = Math.min(high, parsed)
  return parsed
}

/** Hook sources out of a raw hooks list — code strings or `{code}` dicts,
 * matching the engine's `_parse_hooks` / `card_hook_codes` tolerance. */
function codesFromList(entries: unknown): string[] {
  if (typeof entries === "string") entries = [entries]
  if (!Array.isArray(entries)) return []
  const codes: string[] = []
  for (const item of entries) {
    const code = typeof item === "string" ? item : isRecord(item) ? item.code : undefined
    if (typeof code === "string" && code.trim()) codes.push(code)
  }
  return codes
}

/** v1 carries hooks as the top-level `hooks` list; v0 hid them under
 * `extensions.loreweaver_hooks`. */
function hookCodes(raw: Record<string, unknown>, version: number): string[] {
  if (version >= 1) return codesFromList(raw.hooks)
  const extensions = isRecord(raw.extensions) ? raw.extensions : {}
  return codesFromList(extensions.loreweaver_hooks)
}

/** One native worldbook row → the importer-shaped ST entry dict (the same
 * mapping `core/lorecard.py::_parse_entry` emits). Returns null for junk. */
function entryToStDict(raw: unknown, index: number, warnings: string[]): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    warnings.push(`worldbook[${index}]: skipped (entry must be a JSON object)`)
    return null
  }
  const content = asText(raw.content)
  if (!content.trim()) {
    warnings.push(`worldbook[${index}]: skipped (empty content)`)
    return null
  }
  const condition = asText(raw.condition).split(/\s+/).join(" ").trim()
  const body = condition ? `@@if ${condition}\n${content}` : content
  const secondaryKeys = textList(raw.secondary_keys)
  const logic = asText(raw.selective_logic).trim()
  // The optional stable entry id — the cross-pack reference handle
  // (`<pack-id>#<entry-id>`). Carried verbatim, like the engine.
  const id = asText(raw.id).trim()
  return {
    ...(id ? { id } : {}),
    comment: asText(raw.title).trim() || "Untitled Lore",
    content: body,
    keys: textList(raw.keys),
    secondary_keys: secondaryKeys,
    selective: secondaryKeys.length > 0,
    selective_logic: SELECTIVE_LOGICS.has(logic) ? logic : "and_any",
    category: asText(raw.category).trim() || "lore",
    secret: raw.secret === true,
    constant: raw.constant === true,
    priority: intOr(raw.priority, 0),
    enabled: raw.enabled === undefined ? true : raw.enabled !== false,
    probability: intOr(raw.probability, 100, 0, 100),
    case_sensitive: raw.case_sensitive === true,
    match_whole_words: raw.match_whole_words === true,
    scan_depth: intOr(raw.scan_depth, 0, 0, 200),
    position: POSITIONS_TO_ST[asText(raw.position).trim()] ?? "",
    sticky: intOr(raw.sticky, 0, 0, 999),
    cooldown: intOr(raw.cooldown, 0, 0, 999),
    delay: intOr(raw.delay, 0, 0, 9999),
  }
}

export interface ParsedLorecard {
  card: StCharacterCard
  alternateGreetings: string[]
  hooks: string[]
  warnings: string[]
}

/** Engine `core.modvars.coerce_int`: bools, ints, floats (truncated) and
 * numeric strings; null on anything else (bounds/defaults that fail this kill
 * the spec at normalization). */
function coerceInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === "string") {
    const text = value.trim()
    if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10)
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) {
      const parsed = Number(text)
      return Number.isFinite(parsed) ? Math.trunc(parsed) : null
    }
  }
  return null
}

/** Engine `core.modvars.coerce_bool`: real bools, 0/1, and the usual words. */
function coerceBoolValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase()
    if (["true", "1", "yes", "y", "on"].includes(lowered)) return true
    if (["false", "0", "no", "n", "off"].includes(lowered)) return false
  }
  return null
}

const MAX_OPTION_LEN = 50
const MAX_OPTIONS = 20

/** Engine `build_spec`'s enum-options cleaning (strip, truncate, case-folded
 * dedupe); null when nothing usable remains — which kills the spec. */
function cleanEnumOptions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const cleaned: string[] = []
  for (const option of raw) {
    if (typeof option !== "string" || !option.trim()) continue
    const text = option.trim().slice(0, MAX_OPTION_LEN)
    if (!cleaned.some((existing) => existing.toLowerCase() === text.toLowerCase())) cleaned.push(text)
  }
  return cleaned.length > 0 ? cleaned.slice(0, MAX_OPTIONS) : null
}

/** Engine `validate_value` as a bare validity check (the normalized VALUE is
 * irrelevant here — only whether the spec survives). */
function defaultSurvives(kind: string, value: unknown, options: string[] | null): boolean {
  switch (kind) {
    case "number":
      return coerceInt(value) !== null
    case "bool":
      return coerceBoolValue(value) !== null
    case "enum": {
      const text = String(value).trim()
      return (options ?? []).some((option) => option.toLowerCase() === text.toLowerCase())
    }
    default:
      // text: containers are unusable, everything else stringifies.
      return !(typeof value === "object" && value !== null)
  }
}

/** Count the bundle's typed `variables` specs that survive engine
 * normalization — the mirror of `core/lorecard.py::_parse_variables` feeding
 * `core/modvars.normalize_spec` (junk rows, unusable ids/kinds, bad
 * bounds/defaults and duplicate ids are all skipped). The pack build folds
 * this count into `detect_world_payloads` (`core/pack.py:644-652`), so the
 * studio's kind detection must count exactly the same specs. */
export function countVariableSpecs(raw: Record<string, unknown>): number {
  const list = raw.variables
  if (!Array.isArray(list)) return 0
  const seen = new Set<string>()
  let count = 0
  for (const item of list) {
    if (!isRecord(item)) continue
    const id = normalizeVarId(asText(item.id))
    if (!isValidVarId(id) || seen.has(id)) continue
    const kind = asText(item.kind).trim()
    if (!VAR_KINDS.has(kind)) continue
    if (kind === "number") {
      // Bounds are read only for the number kind; present-but-uncoercible or
      // inverted bounds kill the spec (`build_spec` raises, `normalize_spec`
      // drops it).
      const hasMin = item.minimum !== undefined && item.minimum !== null
      const hasMax = item.maximum !== undefined && item.maximum !== null
      const low = hasMin ? coerceInt(item.minimum) : null
      const high = hasMax ? coerceInt(item.maximum) : null
      if ((hasMin && low === null) || (hasMax && high === null)) continue
      if (low !== null && high !== null && low > high) continue
    }
    let options: string[] | null = null
    if (kind === "enum") {
      options = cleanEnumOptions(item.options)
      if (options === null) continue
    }
    if (
      item.default !== undefined &&
      item.default !== null &&
      !defaultSurvives(kind, item.default, options)
    ) {
      continue
    }
    seen.add(id)
    count += 1
  }
  return count
}

/** Native bundle → a character-card view for the pack/split machinery. Throws
 * on a wrong format tag or unsupported version; skips junk rows with warnings. */
export function lorecardToCard(raw: Record<string, unknown>): ParsedLorecard {
  if (!looksLikeLorecard(raw)) throw new Error(`not a Loreweaver native card (format tag missing)`)
  const version = requireVersion(raw)
  const v1 = version >= 1
  const warnings: string[] = []
  const worldbook = Array.isArray(raw.worldbook) ? raw.worldbook : []
  const entries: Record<string, unknown>[] = []
  for (const [index, item] of worldbook.entries()) {
    const entry = entryToStDict(item, index, warnings)
    if (entry !== null) entries.push(entry)
  }
  // v1's native prose names map onto the same CharacterCard slots the engine
  // fills (`opening` → `first_mes` etc.); v0 used the ST-era names directly.
  const card: StCharacterCard = {
    name: asText(raw.name).trim(),
    description: asText(raw.description),
    personality: asText(raw.personality),
    scenario: asText(raw.scenario),
    firstMes: asText(v1 ? raw.opening : raw.first_mes),
    mesExample: asText(v1 ? raw.dialogue_examples : raw.mes_example),
    creatorNotes: asText(v1 ? raw.author_notes : raw.creator_notes),
    tags: textList(raw.tags),
    characterBook: entries,
    raw,
  }
  const alternateGreetings = textList(v1 ? raw.alternate_openings : raw.alternate_greetings)
  return { card, alternateGreetings, hooks: hookCodes(raw, version), warnings }
}

/** One engine-shaped variable spec → the forge's raw form state. */
function specToForgeVariable(raw: unknown, index: number, warnings: string[]): ForgeVariable | null {
  if (!isRecord(raw)) {
    warnings.push(`variables[${index}]: skipped (spec must be a JSON object)`)
    return null
  }
  const id = asText(raw.id).trim()
  const kind = asText(raw.kind).trim()
  if (!id || !VAR_KINDS.has(kind)) {
    warnings.push(`variables[${index}]: skipped (unusable id or kind)`)
    return null
  }
  const variable = newVariable()
  variable.id = id
  variable.kind = kind as VarKind
  variable.visibility = (raw.visibility === "keeper" ? "keeper" : "player") as VarVisibility
  const labels = isRecord(raw.labels) ? raw.labels : {}
  variable.labelEn = asText(labels.en).trim()
  variable.labelZh = asText(labels.zh).trim()
  if (typeof raw.minimum === "number" && Number.isFinite(raw.minimum)) {
    variable.minimum = String(Math.trunc(raw.minimum))
  }
  if (typeof raw.maximum === "number" && Number.isFinite(raw.maximum)) {
    variable.maximum = String(Math.trunc(raw.maximum))
  }
  const fallback = raw.default
  if (typeof fallback === "boolean") variable.defaultValue = fallback ? "true" : "false"
  else if (typeof fallback === "number" && Number.isFinite(fallback)) {
    variable.defaultValue = String(fallback)
  } else variable.defaultValue = asText(fallback)
  variable.options = textList(raw.options).join("\n")
  return variable
}

/** One native worldbook row → the forge editor's entry, NATIVE fields kept
 * (typed `condition`, `secret`) rather than round-tripped through `@@if`. */
function entryToForgeLore(raw: unknown, index: number, warnings: string[]): ForgeLoreEntry | null {
  if (!isRecord(raw)) {
    warnings.push(`worldbook[${index}]: skipped (entry must be a JSON object)`)
    return null
  }
  const content = asText(raw.content)
  if (!content.trim()) {
    warnings.push(`worldbook[${index}]: skipped (empty content)`)
    return null
  }
  const entry = newLoreEntry()
  entry.title = asText(raw.title).trim()
  const stableId = asText(raw.id).trim()
  if (stableId) entry.stableId = stableId
  entry.content = content
  entry.keys = textList(raw.keys).join(", ")
  entry.secondaryKeys = textList(raw.secondary_keys).join(", ")
  const logic = asText(raw.selective_logic).trim()
  if (SELECTIVE_LOGICS.has(logic)) entry.selectiveLogic = logic as SelectiveLogic
  entry.condition = asText(raw.condition).trim()
  entry.constant = raw.constant === true
  entry.secret = raw.secret === true
  entry.enabled = raw.enabled === undefined ? true : raw.enabled !== false
  entry.priority = intOr(raw.priority, 0)
  entry.probability = intOr(raw.probability, 100, 0, 100)
  entry.caseSensitive = raw.case_sensitive === true
  entry.matchWholeWords = raw.match_whole_words === true
  entry.scanDepth = intOr(raw.scan_depth, 0, 0, 200)
  const position = asText(raw.position).trim()
  entry.position = (position === "before" || position === "after" ? position : "") as LorePosition
  entry.sticky = intOr(raw.sticky, 0, 0, 999)
  entry.cooldown = intOr(raw.cooldown, 0, 0, 9999)
  entry.delay = intOr(raw.delay, 0, 0, 9999)
  return entry
}

export interface ImportedLorecard {
  project: ForgeProject
  warnings: string[]
}

/** One native pregen row → the forge editor's form state, mirroring the
 * engine's `_parse_pregens` tolerance (caps, int skills, junk skipped with
 * warnings). The skills mapping flattens back to one `name value` per line. */
function pregenToForge(raw: unknown, index: number, warnings: string[]): ForgePregen | null {
  if (!isRecord(raw)) {
    warnings.push(`pregens[${index}]: skipped (entry must be a JSON object)`)
    return null
  }
  const name = asText(raw.name).trim()
  if (!name) {
    warnings.push(`pregens[${index}]: skipped (missing name)`)
    return null
  }
  const pregen = newPregen()
  pregen.name = name
  // v1 writes `concept`; the engine also accepts `blurb`.
  pregen.concept = asText(raw.concept ?? raw.blurb).trim()
  pregen.notes = asText(raw.notes).trim()
  const skillsRaw = raw.skills
  if (isRecord(skillsRaw)) {
    const lines: string[] = []
    for (const [key, value] of Object.entries(skillsRaw).slice(0, MAX_PREGEN_SKILLS)) {
      const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null
      if (parsed === null) {
        warnings.push(`pregens[${index}].skills.${key}: skipped (not an integer)`)
        continue
      }
      lines.push(`${key.trim()} ${parsed}`)
    }
    pregen.skillsText = lines.join("\n")
  }
  return pregen
}

/** Native bundle → a ForgeProject, losslessly (the inverse of
 * `exportNativeBundle`). Throws on structural garbage; junk rows warn. */
export function lorecardToProject(raw: Record<string, unknown>): ImportedLorecard {
  if (!looksLikeLorecard(raw)) throw new Error(`not a Loreweaver native card (format tag missing)`)
  const version = requireVersion(raw)
  const v1 = version >= 1
  const warnings: string[] = []
  const project = newProject(asText(raw.name).trim() || "Imported card")
  project.description = asText(raw.description)
  project.personality = asText(raw.personality)
  project.scenario = asText(raw.scenario)
  project.firstMes = asText(v1 ? raw.opening : raw.first_mes)
  project.mesExample = asText(v1 ? raw.dialogue_examples : raw.mes_example)
  project.alternateGreetings = textList(v1 ? raw.alternate_openings : raw.alternate_greetings)
  project.creatorNotes = asText(v1 ? raw.author_notes : raw.creator_notes)
  project.tags = textList(raw.tags).join(", ")

  const variables: ForgeVariable[] = []
  const rawVariables = Array.isArray(raw.variables) ? raw.variables : []
  for (const [index, item] of rawVariables.entries()) {
    const variable = specToForgeVariable(item, index, warnings)
    if (variable !== null) variables.push(variable)
  }
  project.variables = variables

  const lorebook: ForgeLoreEntry[] = []
  const rawWorldbook = Array.isArray(raw.worldbook) ? raw.worldbook : []
  for (const [index, item] of rawWorldbook.entries()) {
    const entry = entryToForgeLore(item, index, warnings)
    if (entry !== null) lorebook.push(entry)
  }
  project.lorebook = lorebook

  const pregens: ForgePregen[] = []
  const rawPregens = Array.isArray(raw.pregens) ? raw.pregens : []
  for (const [index, item] of rawPregens.entries()) {
    if (pregens.length >= MAX_PREGENS) {
      warnings.push(`pregens: truncated to ${MAX_PREGENS} entries`)
      break
    }
    const pregen = pregenToForge(item, index, warnings)
    if (pregen !== null) pregens.push(pregen)
  }
  project.pregens = pregens

  const hooks = hookCodes(raw, version)
  if (hooks.length > 0) project.hooks = hooks.join("\n\n")
  return { project, warnings }
}
