// A stored draft's panels 1.x → panels 3.0, where the mapping is mechanical
// (`docs/lwf/formats/panels.md` §9 in the engine repository):
//
//   {$var: day}                 → {$view: vars.module.day.value}, with `views: {vars: variables}`
//   repeat {prefix, block} with {$leaf: id|value}
//                               → repeat {each: vars.tree, as: leaf, prefix, block} with
//                                 {$view: leaf.path} / {$view: leaf.value}
//   visible_when: "day >= 46"   → visible_when: "vars.module.day.value >= 46"
//   audience: keeper            → audience: admin
//
// Everything else is LEFT AS WRITTEN — a dotted variable id (a tree leaf, which a single
// path cannot name), `{$leaf: label}`, a choice's typed `input`, a 1.x page with its
// `assets` list — so the checks (and the pack lint) flag it and the author decides. Nothing
// here guesses.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { conditionReferences } from "./panelsCheck"

/** The handle the migration declares for the `variables` view. */
export const MIGRATED_VARIABLES_HANDLE = "vars"
const LEAF_HANDLE = "leaf"
const SEGMENT = /^[\p{L}_][\p{L}\p{N}_]*$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export interface PanelsMigration {
  yamlText: string
  /** Whether anything 1.x-shaped was found at all. */
  legacy: boolean
  /** Whether something 1.x-shaped stayed (the checks flag it). */
  leftover: boolean
}

/** Whether a panels value carries anything only panels 1.x had. */
function hasLegacy(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasLegacy)
  if (!isRecord(node)) return false
  if ("$var" in node || "$leaf" in node || "input" in node || "assets" in node) return true
  if (node.audience === "keeper") return true
  if (isRecord(node.repeat) && !("each" in node.repeat)) return true
  return Object.values(node).some(hasLegacy)
}

/** One `visible_when` with every bare variable id rewritten; null when a reference cannot be. */
function migrateCondition(
  condition: string,
  handles: ReadonlySet<string>,
  inner: string | null,
): string | null {
  const references = conditionReferences(condition)
  let out = condition
  for (const reference of references) {
    const head = reference.split(".")[0]
    if (handles.has(head) || head === inner) continue
    if (reference.includes(".") || !SEGMENT.test(reference)) return null
    // Whole identifiers only, outside string literals.
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_.'"])${reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`,
      "gu",
    )
    out = out.replace(pattern, `${MIGRATED_VARIABLES_HANDLE}.module.${reference}.value`)
  }
  return out
}

interface Context {
  handles: ReadonlySet<string>
  usedVariables: boolean
  leftover: boolean
}

function migrateValue(value: unknown, context: Context, inRepeat: boolean): unknown {
  if (isRecord(value) && Object.keys(value).length === 1 && typeof value.$var === "string") {
    const id = value.$var
    if (!SEGMENT.test(id)) {
      context.leftover = true
      return value
    }
    context.usedVariables = true
    return { $view: `${MIGRATED_VARIABLES_HANDLE}.module.${id}.value` }
  }
  if (isRecord(value) && Object.keys(value).length === 1 && "$leaf" in value) {
    if (inRepeat && value.$leaf === "id") return { $view: `${LEAF_HANDLE}.path` }
    if (inRepeat && value.$leaf === "value") return { $view: `${LEAF_HANDLE}.value` }
    context.leftover = true
    return value
  }
  return value
}

function migrateBlock(raw: unknown, context: Context, inRepeat: boolean): unknown {
  if (!isRecord(raw)) return raw
  if (isRecord(raw.repeat) && typeof raw.repeat.prefix === "string" && !("each" in raw.repeat)) {
    const out: Record<string, unknown> = { ...raw }
    context.usedVariables = true
    const repeat: Record<string, unknown> = {
      each: `${MIGRATED_VARIABLES_HANDLE}.tree`,
      as: LEAF_HANDLE,
      prefix: raw.repeat.prefix,
      block: migrateBlock(raw.repeat.block, context, true),
    }
    for (const [key, value] of Object.entries(raw.repeat)) {
      if (!["prefix", "block"].includes(key)) repeat[key] = value
    }
    out.repeat = repeat
    if (typeof raw.visible_when === "string") out.visible_when = migrateGate(raw.visible_when, context, null)
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "visible_when" && typeof value === "string") {
      out[key] = migrateGate(value, context, inRepeat ? LEAF_HANDLE : null)
    } else if (key === "options" && Array.isArray(value)) {
      out[key] = value.map((option) => {
        if (!isRecord(option)) return option
        if ("input" in option) context.leftover = true
        return {
          ...option,
          ...(option.label !== undefined ? { label: migrateValue(option.label, context, inRepeat) } : {}),
        }
      })
    } else {
      out[key] = migrateValue(value, context, inRepeat)
    }
  }
  return out
}

function migrateGate(condition: string, context: Context, inner: string | null): string {
  const migrated = migrateCondition(condition, context.handles, inner)
  if (migrated === null) {
    context.leftover = true
    return condition
  }
  if (migrated !== condition) context.usedVariables = true
  return migrated
}

function migratePanel(raw: unknown): { panel: unknown; leftover: boolean } {
  if (!isRecord(raw)) return { panel: raw, leftover: false }
  const declared = isRecord(raw.views) ? raw.views : {}
  const context: Context = { handles: new Set(Object.keys(declared)), usedVariables: false, leftover: false }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === "audience" && value === "keeper") out[key] = "admin"
    else if ((key === "blocks" || key === "fallback") && Array.isArray(value)) {
      out[key] = value.map((block) => migrateBlock(block, context, false))
    } else out[key] = value
  }
  if ("assets" in raw) context.leftover = true
  if (context.usedVariables && !(MIGRATED_VARIABLES_HANDLE in declared)) {
    // Declared right after the slot/audience, where a reader expects it.
    const ordered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(out)) {
      if (key === "blocks" || key === "entry")
        ordered.views = { ...declared, [MIGRATED_VARIABLES_HANDLE]: "variables" }
      if (key !== "views") ordered[key] = value
    }
    if (!("views" in ordered)) ordered.views = { ...declared, [MIGRATED_VARIABLES_HANDLE]: "variables" }
    return { panel: ordered, leftover: context.leftover }
  }
  return { panel: out, leftover: context.leftover }
}

/** Migrate a panels file's text. A file with nothing 1.x-shaped comes back unchanged. */
export function migratePanelsYaml(yamlText: string): PanelsMigration {
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch {
    return { yamlText, legacy: false, leftover: false }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.panels) || !hasLegacy(parsed)) {
    return { yamlText, legacy: false, leftover: false }
  }
  let leftover = false
  const panels = parsed.panels.map((panel) => {
    const migrated = migratePanel(panel)
    leftover ||= migrated.leftover
    return migrated.panel
  })
  return { yamlText: stringifyYaml({ ...parsed, panels }, { lineWidth: 0 }), legacy: true, leftover }
}
