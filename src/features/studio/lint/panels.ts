// Reading `ui/panels.yaml` for the lint: which panels exist, who sees them,
// and which variables and assets each one reaches for.
//
// Mirror of the engine's `core/panels.py` (the schema authority) and the
// portable condition grammar in `@loreweaver/protocol`'s `condexpr.ts` /
// `core/condexpr.py`:
//   - any scalar field may be `{$var: "<id>"}` — substituted client-side from
//     that viewer's own `state.variables`; a binding that does not resolve
//     DROPS the block;
//   - `{repeat: {prefix, block}}` renders one instance per VISIBLE variable
//     whose id starts with `prefix`, with `{$leaf: id|label|value}` inside;
//   - a block may carry `visible_when: "<condition>"`, evaluated client-side
//     over the same filtered variables — undecidable means hidden;
//   - `audience` is `all` | `player` | `keeper`, resolved server-side;
//   - an `image` / `map_pin` block names its picture by pack-relative `src`;
//   - a localized string is an `{en, zh}` map, or a plain string read as `en`.
// The lint needs the references, not the values, so this is a reader — never
// an evaluator, and never a second validator (the engine build owns that).

import { parse as parseYaml } from "yaml"

export type PanelAudience = "all" | "player" | "keeper"

/** Where a variable was named. The two sites differ in what going wrong means:
 * a dead binding drops the block, a dead condition hides it. */
export type PanelVarSite = "binding" | "visibleWhen"

export interface PanelVarRef {
  /** The path as written; `mvu.内部.真凶` keeps its dots. */
  path: string
  site: PanelVarSite
}

/** A localized field, flattened. `zh: ""` with a non-empty `en` is the gap the
 * bilingual rule is looking for — including the plain-string shorthand, which
 * IS an en-only label. */
export interface PanelLabel {
  field: string
  en: string
  zh: string
}

export interface LintPanel {
  id: string
  audience: PanelAudience
  vars: PanelVarRef[]
  /** Variable-id prefixes a `repeat` block iterates over. */
  repeatPrefixes: string[]
  /** Pack-relative `src` paths of picture-bearing blocks. */
  images: string[]
  labels: PanelLabel[]
}

/** Fields whose string value a human reads, so a plain (en-only) string in one
 * is a missing zh rather than a slug. Mirrors the localized fields in
 * `core/panels.py` / `core/hooks.py`. */
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
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Mirror of `condexpr.ts`'s tokenizer: an identifier starts with a letter
 * (CJK included) or `_` and continues with letters/digits/`_`; `.` joins them
 * into a dotted path. Keywords are literals, not references.
 *
 * This SCANS rather than parses because the lint wants every name in the
 * expression, including the ones a real evaluation would short-circuit past. */
const IDENT_PATH_RE = /[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*/gu
const CONDITION_KEYWORDS = new Set(["true", "false", "null", "undefined", "none", "and", "or", "not"])

export function conditionVarPaths(condition: string): string[] {
  // Strings are literals; a quoted value must never read as a reference.
  const withoutStrings = condition.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, " ")
  const paths: string[] = []
  for (const match of withoutStrings.matchAll(IDENT_PATH_RE)) {
    const path = match[0]
    if (CONDITION_KEYWORDS.has(path.toLowerCase())) continue
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}

function walk(node: unknown, panel: LintPanel, field: string): void {
  if (typeof node === "string") {
    if (LOCALIZED_FIELDS.has(field) && node.trim()) panel.labels.push({ field, en: node, zh: "" })
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, panel, field)
    return
  }
  if (!isRecord(node)) return

  const keys = Object.keys(node)
  if (keys.length === 1 && typeof node.$var === "string") {
    panel.vars.push({ path: node.$var, site: "binding" })
    return
  }
  // `{$leaf: …}` names a field of the repeat's current variable, never a
  // variable of its own — nothing to check.
  if (keys.length === 1 && node.$leaf !== undefined) return

  if (keys.length > 0 && keys.every((key) => key === "en" || key === "zh")) {
    panel.labels.push({
      field,
      en: typeof node.en === "string" ? node.en : "",
      zh: typeof node.zh === "string" ? node.zh : "",
    })
    return
  }

  if (typeof node.visible_when === "string") {
    for (const path of conditionVarPaths(node.visible_when)) {
      panel.vars.push({ path, site: "visibleWhen" })
    }
  }
  if (typeof node.src === "string") panel.images.push(node.src)
  if (isRecord(node.repeat) && typeof node.repeat.prefix === "string") {
    panel.repeatPrefixes.push(node.repeat.prefix)
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "visible_when" || key === "src") continue
    walk(value, panel, key)
  }
}

/** Read every panel out of `ui/panels.yaml`. Unparseable YAML yields an empty
 * list: a broken panels file is the engine build's report to make, and a lint
 * that shouts about syntax the author is mid-typing is a lint they turn off. */
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
    const audience = raw.audience
    const panel: LintPanel = {
      id: typeof raw.id === "string" && raw.id.trim() ? raw.id : `#${index + 1}`,
      audience: audience === "player" || audience === "keeper" ? audience : "all",
      vars: [],
      repeatPrefixes: [],
      images: [],
      labels: [],
    }
    if (typeof raw.visible_when === "string") {
      for (const path of conditionVarPaths(raw.visible_when)) {
        panel.vars.push({ path, site: "visibleWhen" })
      }
    }
    for (const [key, value] of Object.entries(raw)) {
      if (key === "id" || key === "audience" || key === "slot" || key === "visible_when") continue
      walk(value, panel, key)
    }
    panels.push(panel)
  }
  return panels
}
