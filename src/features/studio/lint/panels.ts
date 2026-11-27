// Reading `ui/panels.yaml` (panels 3.0) for the lint: which panels exist, who sees them, and
// which of the pack's variables, pictures and labels each one reaches for.
//
// In 3.0 a panel reads VIEWS (`docs/lwf/formats/panels.md` in the engine repository). The
// pack's own variables reach a panel through the `variables` view: a panel that declares
// `views: {vars: variables}` reads `vars.module.<id>.value` (a declared variable) or walks
// `vars.tree` with a `repeat` (the variable tree, filtered by a key `prefix`). A variable
// hidden from players is simply absent from a player's view, so a binding to it renders
// nothing for them — the trap the lint warns about.
//
// A reader, never an evaluator and never a second validator: the checks are `panelsCheck.ts`
// and the engine's build. What this adds is what builds fine and then does nothing — and the
// panels 1.x fields an old draft still carries, which the migration left for the author.

import { parse as parseYaml } from "yaml"
import { conditionReferences } from "../pack/panelsCheck"

export type PanelAudience = "all" | "player" | "admin"

/** Where a variable was named: a dead binding drops the block, a dead condition hides it. */
export type PanelVarSite = "binding" | "visibleWhen"

export interface PanelVarRef {
  /** The variable's id (`vars.module.<id>`). */
  path: string
  site: PanelVarSite
}

/** A localized field, flattened. `zh: ""` with a non-empty `en` is a bilingual gap. */
export interface PanelLabel {
  field: string
  en: string
  zh: string
}

export interface LintPanel {
  id: string
  audience: PanelAudience
  vars: PanelVarRef[]
  /** Key prefixes a `repeat` over the variable tree keeps. */
  repeatPrefixes: string[]
  /** Pack paths of picture-bearing blocks. */
  images: string[]
  labels: PanelLabel[]
  /** Panels 1.x fields still present (`$var`, `$leaf`, a choice's `input`, a page's
   * `assets`, `audience: keeper`): the engine refuses each (`replaced_2x`). */
  legacy: string[]
}

const LOCALIZED_FIELDS = new Set([
  "label",
  "title",
  "text",
  "caption",
  "alt",
  "subtitle",
  "headline",
  "body",
  "note",
  "act",
  "source",
  "from",
  "to",
  "prompt",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The variable a path reads through a `variables` view handle, or null. */
function variableOf(path: string, handles: ReadonlySet<string>): string | null {
  const [head, section, id] = path.split(".")
  return handles.has(head) && section === "module" && id ? id : null
}

/** Every reference a condition names (string literals skipped). */
export function conditionVarPaths(condition: string): string[] {
  return conditionReferences(condition)
}

function walk(node: unknown, panel: LintPanel, field: string, handles: ReadonlySet<string>): void {
  if (typeof node === "string") {
    if (LOCALIZED_FIELDS.has(field) && node.trim()) panel.labels.push({ field, en: node, zh: "" })
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, panel, field, handles)
    return
  }
  if (!isRecord(node)) return

  const keys = Object.keys(node)
  if (keys.length === 1 && typeof node.$view === "string") {
    const id = variableOf(node.$view, handles)
    if (id !== null) panel.vars.push({ path: id, site: "binding" })
    return
  }
  for (const legacy of ["$var", "$leaf", "input"]) {
    if (legacy in node && !panel.legacy.includes(legacy)) panel.legacy.push(legacy)
  }
  if ("$var" in node || "$leaf" in node) return

  if (keys.length > 0 && keys.every((key) => key === "en" || key === "zh")) {
    panel.labels.push({
      field,
      en: typeof node.en === "string" ? node.en : "",
      zh: typeof node.zh === "string" ? node.zh : "",
    })
    return
  }

  if (typeof node.visible_when === "string") {
    for (const reference of conditionReferences(node.visible_when)) {
      const id = variableOf(reference, handles)
      if (id !== null) panel.vars.push({ path: id, site: "visibleWhen" })
    }
  }
  if (typeof node.src === "string") panel.images.push(node.src)
  if (isRecord(node.repeat) && typeof node.repeat.prefix === "string") {
    const each = typeof node.repeat.each === "string" ? node.repeat.each : ""
    const [head, section] = each.split(".")
    if (handles.has(head) && section === "tree") panel.repeatPrefixes.push(node.repeat.prefix)
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "visible_when" || key === "src") continue
    walk(value, panel, key, handles)
  }
}

/** Read every panel out of `ui/panels.yaml`. Unparseable YAML yields an empty list: a broken
 * panels file is the checks' report to make. */
export function readPanels(yamlText: string): LintPanel[] {
  let parsed: unknown
  try {
    parsed = parseYaml(yamlText)
  } catch {
    return []
  }
  const root = isRecord(parsed) ? parsed.panels : null
  if (!Array.isArray(root)) return []
  const panels: LintPanel[] = []
  for (const [index, raw] of root.entries()) {
    if (!isRecord(raw)) continue
    const views = isRecord(raw.views) ? raw.views : {}
    const handles = new Set(
      Object.entries(views)
        .filter(([, view]) => view === "variables")
        .map(([handle]) => handle),
    )
    const audience = raw.audience
    const panel: LintPanel = {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `#${index + 1}`,
      audience:
        audience === "player" || audience === "admin" ? audience : audience === "keeper" ? "admin" : "all",
      vars: [],
      repeatPrefixes: [],
      images: [],
      labels: [],
      legacy: [],
    }
    if (audience === "keeper") panel.legacy.push("audience: keeper")
    if ("assets" in raw) panel.legacy.push("assets")
    for (const [key, value] of Object.entries(raw)) {
      if (["id", "audience", "slot", "views", "entry", "assets"].includes(key)) continue
      walk(value, panel, key, handles)
    }
    panels.push(panel)
  }
  return panels
}
