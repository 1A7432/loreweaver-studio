// Dual export, per the M14 card-forge draft:
//  - a Loreweaver-native bundle (lossless: keeps keeper-only variables and
//    secret lore; typed specs ride verbatim) — format v1, the frozen M16
//    consolidation shape parsed by the engine's `core/lorecard.py`;
//  - a SillyTavern V3 card (plays in stock ST *and* imports back into
//    Loreweaver): typed specs become a generated [InitVar] entry, `condition`
//    becomes an `@@if` decorator line, hooks ride extensions.loreweaver_hooks.
//    Keeper-only variables and secret entries are EXCLUDED (no safe ST shape).
// docs/FORMATS.md documents both shapes.

import {
  MAX_PREGEN_CONCEPT_LEN,
  MAX_PREGEN_NAME_LEN,
  MAX_PREGEN_NOTES_LEN,
  parsePregenSkills,
  splitKeys,
  type ForgeLoreEntry,
  type ForgePregen,
  type ForgeProject,
  type ModvarSpec,
  type SelectiveLogic,
} from "./model"
import { EPISODE_FIELD } from "./split/episodes"

/** Stock SillyTavern world-info selectiveLogic integers (confirmed against the
 * Loreweaver importer's `_SELECTIVE_LOGIC_INTS`). */
export const SELECTIVE_LOGIC_TO_INT: Record<SelectiveLogic, number> = {
  and_any: 0,
  not_all: 1,
  not_any: 2,
  and_all: 3,
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.trunc(value)))

function loreToNative(entry: ForgeLoreEntry): Record<string, unknown> {
  const stableId = entry.stableId?.trim() ?? ""
  const episode = entry.episode?.trim() ?? ""
  return {
    // Studio-private serialization tag, carried so a later "build up to episode
    // N" can still tell which installment this entry belongs to. It never
    // reaches a built pack — `filterEpisodeContent` strips it at write time.
    ...(episode ? { [EPISODE_FIELD]: episode } : {}),
    // The stable entry id rides first when set — the cross-pack reference
    // handle (`<pack-id>#<entry-id>`), carried verbatim by the engine.
    ...(stableId ? { id: stableId } : {}),
    title: entry.title.trim() || "Untitled Lore",
    content: entry.content,
    keys: splitKeys(entry.keys),
    category: "lore",
    secret: entry.secret,
    constant: entry.constant,
    priority: Math.trunc(entry.priority),
    enabled: entry.enabled,
    condition: entry.condition.trim(),
    secondary_keys: splitKeys(entry.secondaryKeys),
    selective_logic: entry.selectiveLogic,
    probability: clamp(entry.probability, 0, 100),
    case_sensitive: entry.caseSensitive,
    match_whole_words: entry.matchWholeWords,
    scan_depth: clamp(entry.scanDepth, 0, 200),
    position: entry.position,
    sticky: clamp(entry.sticky, 0, 999),
    cooldown: clamp(entry.cooldown, 0, 999),
    delay: clamp(entry.delay, 0, 9999),
  }
}

/** One pregen → the native cast row. Lengths are capped to the engine's
 * truncation limits so the export parses back to exactly what we wrote;
 * invalid skill lines are dropped here and surfaced by `validateProject`. */
function pregenToNative(pregen: ForgePregen): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: pregen.name.trim().slice(0, MAX_PREGEN_NAME_LEN),
  }
  const episode = pregen.episode?.trim() ?? ""
  if (episode) out[EPISODE_FIELD] = episode
  const concept = pregen.concept.trim().slice(0, MAX_PREGEN_CONCEPT_LEN)
  if (concept) out["concept"] = concept
  const notes = pregen.notes.trim().slice(0, MAX_PREGEN_NOTES_LEN)
  if (notes) out["notes"] = notes
  const { skills } = parsePregenSkills(pregen.skillsText)
  if (Object.keys(skills).length > 0) out["skills"] = skills
  return out
}

export function exportNativeBundle(project: ForgeProject, specs: ModvarSpec[]): Record<string, unknown> {
  const hooks = project.hooks.trim()
  const pregens = (project.pregens ?? []).map(pregenToNative)
  return {
    format: "loreweaver.card",
    // Format v1: the frozen M16 consolidation shape — native field names,
    // top-level `hooks`, entry `id`s, and the `pregens` cast. v0 (the
    // pre-freeze provisional shape) is deliberately unmigratable engine-side.
    format_version: 1,
    name: project.name.trim(),
    description: project.description,
    personality: project.personality,
    scenario: project.scenario,
    opening: project.firstMes,
    dialogue_examples: project.mesExample,
    alternate_openings: (project.alternateGreetings ?? []).filter((g) => g.trim().length > 0),
    author_notes: project.creatorNotes,
    tags: splitKeys(project.tags),
    variables: specs,
    worldbook: project.lorebook.map(loreToNative),
    // Both sections are optional engine-side; omitting empty keys keeps the
    // document cleaner than writing `"hooks": []` / `"pregens": []`.
    ...(hooks ? { hooks: [project.hooks] } : {}),
    ...(pregens.length > 0 ? { pregens } : {}),
  }
}

/** Human-readable bounds/meaning line for the [InitVar] description slot. */
function specDescription(spec: ModvarSpec): string {
  const label = spec.labels.en || spec.labels.zh || spec.id
  const parts: string[] = [label]
  if (spec.kind === "number") {
    if (spec.minimum !== undefined || spec.maximum !== undefined) {
      parts.push(`range ${spec.minimum ?? "-∞"}..${spec.maximum ?? "∞"}`)
    }
  } else if (spec.kind === "enum" && spec.options) {
    parts.push(`one of: ${spec.options.join(" | ")}`)
  } else if (spec.kind === "bool") {
    parts.push("true/false")
  }
  return parts.join("; ")
}

/** MVU-convention initial-variables tree: `{name: [initial, "description"]}`. */
export function buildInitVarContent(specs: ModvarSpec[]): string {
  const tree: Record<string, [number | boolean | string, string]> = {}
  for (const spec of specs) {
    if (spec.visibility !== "player") continue
    tree[spec.id] = [spec.default, specDescription(spec)]
  }
  return JSON.stringify(tree, null, 2)
}

/** Which SillyTavern card comes out. The difference is load-bearing: keeper-only
 * (secret) lore has no safe representation in an ST card, where everything is
 * player-visible. Stripping it makes a card safe to circulate; keeping it makes
 * a card that stands on its own at the author's own table. */
export type ExportFlavor = "safe" | "release"

/** The single place a flavor becomes an exporter option. */
export function includeSecretFor(flavor: ExportFlavor): boolean {
  return flavor === "release"
}

/** Options for the "tavern release" flavor of the ST export — the wizard's
 * one-click path where the ST card is a first-class deliverable, not a lossy
 * side export. All default OFF so the forge-toolbar export keeps its shape. */
export interface StExportOptions {
  /** Keep keeper-only (secret) lore in the card. In the release flavor that
   * content IS the card — the author's exegesis and the NSFW core would
   * otherwise be stripped and the tavern card would ship hollow. */
  includeSecret?: boolean
  /** Verbatim [InitVar] source (the wizard's YAML). When set it replaces the
   * specs-synthesized flat tree, so hierarchy, CJK keys and keeper-side leaves
   * ride exactly as authored — the shape the MVU ecosystem expects. */
  initvarSource?: string
  /** Plain-language variable update rules → one constant worldbook entry
   * ("变量更新规则"), the MVU-card convention; carried verbatim. */
  updateRules?: string
}

function loreToStEntry(entry: ForgeLoreEntry, index: number): Record<string, unknown> {
  const secondary = splitKeys(entry.secondaryKeys)
  const condition = entry.condition.trim()
  const content = condition ? `@@if ${condition}\n${entry.content}` : entry.content
  const episode = entry.episode?.trim() ?? ""
  return {
    // The same studio-private tag `loreToNative` writes, in the same place —
    // `filterEpisodeContent` reads it off the entry root for the ST and PNG
    // shapes too. Without it every ST card and every PNG the studio produced was
    // untagged, so the release filter passed it through whole and chapter-2 lore
    // shipped inside an "up to episode 1" build. The serialized-module promise
    // ("the circulating file contains no future-episode content, by
    // construction") only holds if it holds on EVERY deliverable path.
    ...(episode ? { [EPISODE_FIELD]: episode } : {}),
    id: index,
    keys: splitKeys(entry.keys),
    secondary_keys: secondary,
    comment: entry.title.trim(),
    content,
    constant: entry.constant,
    selective: secondary.length > 0,
    insertion_order: Math.trunc(entry.priority),
    enabled: entry.enabled,
    position: entry.position === "before" ? "before_char" : "after_char",
    use_regex: false,
    extensions: {
      display_index: index,
      probability: clamp(entry.probability, 0, 100),
      useProbability: true,
      selectiveLogic: SELECTIVE_LOGIC_TO_INT[entry.selectiveLogic],
      case_sensitive: entry.caseSensitive,
      match_whole_words: entry.matchWholeWords,
      scan_depth: clamp(entry.scanDepth, 0, 200),
      sticky: clamp(entry.sticky, 0, 999),
      cooldown: clamp(entry.cooldown, 0, 999),
      delay: clamp(entry.delay, 0, 9999),
      exclude_recursion: false,
      prevent_recursion: false,
      group: "",
      group_weight: 100,
    },
  }
}

function plainStEntry(index: number, comment: string, content: string): Record<string, unknown> {
  return {
    id: index,
    keys: [],
    secondary_keys: [],
    comment,
    content,
    constant: true,
    selective: false,
    insertion_order: 0,
    enabled: true,
    position: "before_char",
    use_regex: false,
    extensions: { display_index: index, probability: 100, useProbability: true, selectiveLogic: 0 },
  }
}

export function exportSillyTavernCard(
  project: ForgeProject,
  specs: ModvarSpec[],
  options: StExportOptions = {},
): Record<string, unknown> {
  const entries: Record<string, unknown>[] = []
  let index = 0
  // The wizard's YAML source wins over the specs-synthesized flat tree.
  const initVar = options.initvarSource?.trim() ? options.initvarSource : buildInitVarContent(specs)
  if (initVar !== "{}") {
    entries.push(plainStEntry(index, "[InitVar]", initVar))
    index += 1
  }
  if (options.updateRules?.trim()) {
    // i18n-exempt: the SillyTavern-side entry title is card CONTENT, a fixed
    // convention like `[InitVar]` above — the reader is the model, not our UI.
    entries.push(plainStEntry(index, "变量更新规则", options.updateRules))
    index += 1
  }
  for (const entry of project.lorebook) {
    // Secret lore has no safe SillyTavern representation (everything in an ST
    // card is player-visible); it stays native-only — unless the release
    // flavor deliberately opts it in.
    if (entry.secret && options.includeSecret !== true) continue
    entries.push(loreToStEntry(entry, index))
    index += 1
  }

  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: project.name.trim(),
      description: project.description,
      personality: project.personality,
      scenario: project.scenario,
      first_mes: project.firstMes,
      mes_example: project.mesExample,
      creator_notes: project.creatorNotes,
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: (project.alternateGreetings ?? []).filter((g) => g.trim().length > 0),
      tags: splitKeys(project.tags),
      creator: "",
      character_version: "",
      group_only_greetings: [],
      extensions: project.hooks.trim() ? { loreweaver_hooks: [project.hooks] } : {},
      character_book: {
        name: `${project.name.trim()} Worldbook`,
        entries,
        extensions: {},
      },
    },
  }
}

export function exportFileName(project: ForgeProject, flavor: "native" | "st"): string {
  const base = (project.name.trim() || "card").replace(/[^\p{L}\p{N}_-]+/gu, "_")
  return flavor === "native" ? `${base}.lorecard.json` : `${base}.st.json`
}
