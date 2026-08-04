// Dual export, per the M14 card-forge draft:
//  - a Loreweaver-native bundle (lossless: keeps keeper-only variables and
//    secret lore; typed specs ride verbatim);
//  - a SillyTavern V3 card (plays in stock ST *and* imports back into
//    Loreweaver): typed specs become a generated [InitVar] entry, `condition`
//    becomes an `@@if` decorator line, hooks ride extensions.loreweaver_hooks.
//    Keeper-only variables and secret entries are EXCLUDED (no safe ST shape).
// docs/FORMATS.md documents both shapes.

import {
  splitKeys,
  type ForgeLoreEntry,
  type ForgeProject,
  type ModvarSpec,
  type SelectiveLogic,
} from "./model"

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
  return {
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

export function exportNativeBundle(project: ForgeProject, specs: ModvarSpec[]): Record<string, unknown> {
  return {
    format: "loreweaver.card",
    // Provisional: the upstream native-bundle importer is M14 (not landed).
    // Versioned so a future importer can migrate whatever we emitted.
    format_version: 0,
    name: project.name.trim(),
    description: project.description,
    personality: project.personality,
    scenario: project.scenario,
    first_mes: project.firstMes,
    mes_example: project.mesExample,
    alternate_greetings: (project.alternateGreetings ?? []).filter((g) => g.trim().length > 0),
    creator_notes: project.creatorNotes,
    tags: splitKeys(project.tags),
    variables: specs,
    worldbook: project.lorebook.map(loreToNative),
    extensions: project.hooks.trim() ? { loreweaver_hooks: [project.hooks] } : {},
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
  return {
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
