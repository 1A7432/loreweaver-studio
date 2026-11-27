// The checks a 3.0 engine makes on a panels file (`ui/panels.yaml`), run while the author
// types, so the wizard goes red before the build does.
//
// A line-by-line mirror of the engine's reader (`server/src/core/panels/format.ts`): the
// same problem codes, at the same dotted paths, for the same reasons. The engine stays the
// authority — its `pack` command validates the file again, and the round-trip gate
// (`scripts/check_roundtrip.sh`) runs both readers on the panels Studio writes. The one
// place this is not a copy is `visible_when`: the engine compiles a condition with its own
// expression compiler; here the shared evaluator from the protocol package decides whether
// it parses and stays in the portable subset, and a scan collects its references.

import {
  BUILT_IN_VIEW_SCHEMAS,
  DEFAULT_REPEAT_AS,
  evaluate,
  isAdminViewName,
  MAX_CONDITION_CHARS,
  MAX_PANEL_BLOCKS,
  MAX_PANEL_VIEWS,
  MAX_PANELS_PER_PACK,
  MAX_REPEAT_PREFIX_CHARS,
  PANEL_SLOTS,
  parsePath,
  VIEW_HANDLE,
} from "loreweaver-protocol"
import { parse as parseYaml } from "yaml"

/** `server/src/core/panels/format.ts` caps. */
export const MAX_PANELS_FILE_BYTES = 256 * 1024
export const MAX_PANEL_TITLE_CHARS = 120
export const MAX_LABEL_CHARS = 120
export const MAX_TEXT_CHARS = 2_000
export const MAX_BODY_CHARS = 4_000
export const MAX_CAPTION_CHARS = 300
export const MAX_PROMPT_CHARS = 200
export const MAX_OPTIONS = 12
export const MAX_OPTION_ID_CHARS = 64
export const MAX_COMMAND_CHARS = 128
export const MAX_ARGS_BYTES = 2_000
export const MAX_ARGS_DEPTH = 4

export const PANEL_AUDIENCES = ["all", "player", "admin"] as const
export type PanelAudience = (typeof PANEL_AUDIENCES)[number]

const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const NAME = /^[a-z][a-z0-9_]{0,63}$/u
/** A command id: an engine command (`roll`), a rule system's (`rules.sanity_check`), a module's (`harbor/ring`). */
export const COMMAND_ID = /^[a-z][a-z0-9_]{0,63}(?:[./][a-z][a-z0-9_]{0,63})?$/u
const ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const PAGE_EXTENSIONS: readonly string[] = [".html", ".htm"]
/** Built-in views a panel may read: every one but `panels` itself. */
export const PANEL_READABLE_BUILT_INS: readonly string[] = Object.keys(BUILT_IN_VIEW_SCHEMAS).filter(
  (name) => name !== "panels",
)

export type PanelCode =
  | "too_large"
  | "bad_yaml"
  | "not_a_mapping"
  | "missing_field"
  | "unknown_key"
  | "bad_field"
  | "bad_id"
  | "too_long"
  | "too_many"
  | "duplicate"
  | "bad_path"
  | "bad_view_name"
  | "bad_binding"
  | "bad_path_syntax"
  | "unknown_handle"
  | "unused_view"
  | "handle_shadowed"
  | "repeat_nested"
  | "bad_condition"
  | "replaced_2x"
  | "audience_conflict"

export interface PanelProblem {
  code: PanelCode
  /** Dotted path of what it concerns (`panels.0.blocks.2.value.$view`). */
  path: string
  detail?: string
}

type Raw = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`
}

/** Text counted in code points, as the engine counts it. */
function charCount(text: string): number {
  return Array.from(text).length
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/iu

/** `server/src/infra/zip.ts` `checkEntryPath`: the one path rule of a pack. */
export function checkPackPath(path: string): string | null {
  if (path === "") return "empty"
  if (charCount(path) > 512) return "too_long"
  if (path.includes("\\")) return "backslash"
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/u.test(path)) return "control_character"
  if (path.startsWith("/")) return "absolute"
  const segments = path.split("/")
  if (/^[A-Za-z]:/u.test(segments[0] ?? "")) return "drive_letter"
  if (path.includes(":")) return "colon"
  for (const segment of segments) {
    if (segment === "") return "empty_segment"
    if (segment === "." || segment === "..") return "dot_segment"
    if (segment.trim() === "") return "empty_segment"
    if (charCount(segment) > 255) return "segment_too_long"
    if (segment.endsWith(".") || segment.endsWith(" ")) return "trailing_dot_or_space"
    if (RESERVED.test(segment)) return "reserved_name"
  }
  return null
}

/** Whether a view name is one a panel may declare. */
export function isPanelViewName(name: string): boolean {
  if (PANEL_READABLE_BUILT_INS.includes(name)) return true
  const parts = name.split("/")
  return parts.length === 2 && NAME.test(parts[0]) && NAME.test(parts[1])
}

/** The references of a condition: dotted paths, string literals skipped. A scan, so it sees
 * every name, including those an evaluation would short-circuit past. */
const REFERENCE_RE = /[\p{L}_][\p{L}\p{N}_]*(?:\.(?:[\p{L}_][\p{L}\p{N}_]*|0|[1-9][0-9]*))*/gu
const CONDITION_WORDS = new Set(["true", "false", "null", "undefined", "none", "and", "or", "not"])

export function conditionReferences(condition: string): string[] {
  const withoutStrings = condition.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, " ")
  const references: string[] = []
  for (const match of withoutStrings.matchAll(REFERENCE_RE)) {
    const before = withoutStrings[(match.index ?? 0) - 1] ?? " "
    // A digit run's tail (`1e5`, `2abc`) is not a reference.
    if (/[0-9.]/.test(before)) continue
    if (CONDITION_WORDS.has(match[0].toLowerCase())) continue
    if (!references.includes(match[0])) references.push(match[0])
  }
  return references
}

/** Whether a condition parses and stays in the portable subset. The probe value is "1":
 * it compares as a number AND orders as a string, so a type only a live view decides never
 * fails here. Null when fine, else the evaluator's reason. */
export function conditionProblem(condition: string): string | null {
  try {
    evaluate(condition, () => "1")
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const PERFORMANCE: ReadonlyMap<string, { required: readonly string[]; optional: readonly string[] }> =
  new Map([
    ["letter", { required: ["body"], optional: ["from", "to", "date"] }],
    ["clipping", { required: ["headline", "body"], optional: ["source", "date"] }],
    ["map_pin", { required: ["src", "label", "x", "y"], optional: ["note"] }],
    ["title_card", { required: ["title"], optional: ["subtitle", "act"] }],
  ])
const TEXT_CAPS: ReadonlyMap<string, number> = new Map([
  ["label", MAX_LABEL_CHARS],
  ["headline", MAX_LABEL_CHARS],
  ["title", MAX_LABEL_CHARS],
  ["from", MAX_LABEL_CHARS],
  ["to", MAX_LABEL_CHARS],
  ["date", MAX_LABEL_CHARS],
  ["source", MAX_LABEL_CHARS],
  ["act", MAX_LABEL_CHARS],
  ["alt", MAX_LABEL_CHARS],
  ["text", MAX_TEXT_CHARS],
  ["body", MAX_BODY_CHARS],
  ["note", MAX_CAPTION_CHARS],
  ["subtitle", MAX_CAPTION_CHARS],
  ["caption", MAX_CAPTION_CHARS],
  ["prompt", MAX_PROMPT_CHARS],
])
export const BLOCK_KIND_NAMES: readonly string[] = [
  "meter",
  "stat",
  "badge",
  "text",
  "divider",
  "choices",
  "image",
  ...PERFORMANCE.keys(),
]

class PanelReader {
  readonly reads = new Set<string>()
  readonly images: string[] = []
  readonly problems: PanelProblem[]
  readonly handles: ReadonlySet<string>

  constructor(problems: PanelProblem[], handles: ReadonlySet<string>) {
    this.problems = problems
    this.handles = handles
  }

  fail(code: PanelCode, path: string, detail?: string): void {
    this.problems.push(detail === undefined ? { code, path } : { code, path, detail })
  }

  closed(raw: Raw, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) this.fail("unknown_key", join(path, key))
  }

  path(raw: unknown, at: string, inner: string | null): boolean {
    const parts = parsePath(raw)
    if (parts === null) {
      this.fail("bad_path_syntax", at)
      return false
    }
    const handle = parts[0]
    if (handle === inner) return true
    if (!this.handles.has(handle)) {
      this.fail("unknown_handle", at, handle)
      return false
    }
    this.reads.add(handle)
    return true
  }

  /** True/false when `raw` is a binding (well-formed or not); undefined when it is none. */
  binding(raw: unknown, at: string, inner: string | null): boolean | undefined {
    if (!isRecord(raw)) return undefined
    if (Object.hasOwn(raw, "$var") || Object.hasOwn(raw, "$leaf")) {
      this.fail("replaced_2x", at, Object.hasOwn(raw, "$var") ? "$var" : "$leaf")
      return false
    }
    if (!Object.hasOwn(raw, "$view")) return undefined
    if (Object.keys(raw).length !== 1) {
      this.fail("bad_binding", at)
      return false
    }
    return this.path(raw.$view, join(at, "$view"), inner)
  }

  /** A text field: true when usable (binding or text), false when not. */
  text(raw: unknown, at: string, cap: number, inner: string | null): "binding" | "text" | null {
    const bound = this.binding(raw, at, inner)
    if (bound !== undefined) return bound ? "binding" : null
    if (typeof raw === "string") {
      const value = raw.trim()
      if (value === "") this.fail("missing_field", at)
      else if (charCount(value) > cap) this.fail("too_long", at)
      return value === "" ? null : "text"
    }
    if (!isRecord(raw)) {
      this.fail("bad_field", at)
      return null
    }
    this.closed(raw, at, ["en", "zh"])
    let any = false
    for (const locale of ["en", "zh"] as const) {
      if (!Object.hasOwn(raw, locale)) continue
      const value = raw[locale]
      if (typeof value !== "string" || value.trim() === "") this.fail("bad_field", join(at, locale))
      else if (charCount(value.trim()) > cap) this.fail("too_long", join(at, locale))
      else any = true
    }
    if (!any) {
      this.fail("missing_field", at)
      return null
    }
    return "text"
  }

  scalar(raw: unknown, at: string, inner: string | null, types: readonly string[]): unknown {
    const bound = this.binding(raw, at, inner)
    if (bound !== undefined) return bound ? raw : null
    const type = typeof raw
    if (
      (type === "number" && Number.isFinite(raw) && types.includes("number")) ||
      (type === "string" && types.includes("string")) ||
      (type === "boolean" && types.includes("boolean"))
    ) {
      return raw
    }
    this.fail("bad_field", at)
    return null
  }

  image(raw: unknown, at: string): void {
    if (typeof raw !== "string" || raw.trim() === "") {
      this.fail(raw === undefined ? "missing_field" : "bad_field", at)
      return
    }
    const value = raw.trim()
    const problem = checkPackPath(value)
    if (problem !== null) {
      this.fail("bad_path", at, problem)
      return
    }
    if (!this.images.includes(value)) this.images.push(value)
  }

  condition(raw: unknown, at: string, inner: string | null): void {
    if (typeof raw !== "string" || raw.trim() === "") {
      this.fail("bad_condition", at, "EMPTY")
      return
    }
    const source = raw.trim()
    if (charCount(source) > MAX_CONDITION_CHARS) {
      this.fail("too_long", at)
      return
    }
    const problem = conditionProblem(source)
    if (problem !== null) {
      this.fail("bad_condition", at, problem)
      return
    }
    for (const reference of conditionReferences(source)) this.path(reference, at, inner)
  }

  args(raw: unknown, at: string): void {
    if (!isRecord(raw)) {
      this.fail("bad_field", at)
      return
    }
    const ok = (value: unknown, depth: number): boolean => {
      if (depth > MAX_ARGS_DEPTH) return false
      if (value === null || typeof value === "string" || typeof value === "boolean") return true
      if (typeof value === "number") return Number.isFinite(value)
      if (Array.isArray(value)) return value.every((item) => ok(item, depth + 1))
      if (isRecord(value)) {
        return Object.entries(value).every(([key, item]) => ARG_KEY.test(key) && ok(item, depth + 1))
      }
      return false
    }
    if (!ok(raw, 1)) {
      this.fail("bad_field", at)
      return
    }
    if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_ARGS_BYTES) this.fail("too_long", at)
  }

  blocks(raw: unknown, at: string): void {
    if (!Array.isArray(raw) || raw.length === 0) {
      this.fail(raw === undefined ? "missing_field" : "bad_field", at)
      return
    }
    if (raw.length > MAX_PANEL_BLOCKS) {
      this.fail("too_many", at)
      return
    }
    raw.forEach((item, index) => this.block(item, join(at, index), null))
  }

  block(raw: unknown, at: string, inner: string | null): void {
    if (!isRecord(raw)) {
      this.fail("not_a_mapping", at)
      return
    }
    const gate = Object.hasOwn(raw, "visible_when") ? raw.visible_when : undefined
    if (Object.hasOwn(raw, "repeat")) {
      this.closed(raw, at, ["repeat", "visible_when"])
      if (inner !== null) {
        this.fail("repeat_nested", join(at, "repeat"))
        return
      }
      if (gate !== undefined) this.condition(gate, join(at, "visible_when"), null)
      const spec = raw.repeat
      const specAt = join(at, "repeat")
      if (!isRecord(spec)) {
        this.fail("not_a_mapping", specAt)
        return
      }
      this.closed(spec, specAt, ["each", "as", "prefix", "block"])
      if (Object.hasOwn(spec, "each")) this.path(spec.each, join(specAt, "each"), null)
      else this.fail("missing_field", join(specAt, "each"))
      let as = DEFAULT_REPEAT_AS
      if (Object.hasOwn(spec, "as")) {
        if (typeof spec.as !== "string" || !VIEW_HANDLE.test(spec.as)) this.fail("bad_id", join(specAt, "as"))
        else as = spec.as
      }
      if (this.handles.has(as)) this.fail("handle_shadowed", join(specAt, "as"), as)
      if (Object.hasOwn(spec, "prefix")) {
        if (typeof spec.prefix !== "string" || spec.prefix === "")
          this.fail("bad_field", join(specAt, "prefix"))
        else if (charCount(spec.prefix) > MAX_REPEAT_PREFIX_CHARS)
          this.fail("too_long", join(specAt, "prefix"))
      }
      if (!Object.hasOwn(spec, "block")) {
        this.fail("missing_field", join(specAt, "block"))
        return
      }
      this.block(spec.block, join(specAt, "block"), as)
      return
    }

    const kind = raw.kind
    if (typeof kind !== "string" || !BLOCK_KIND_NAMES.includes(kind)) {
      this.fail(kind === undefined ? "missing_field" : "bad_field", join(at, "kind"))
      return
    }
    const allow = (fields: readonly string[]): void =>
      this.closed(raw, at, ["kind", "visible_when", ...fields])
    const need = (name: string): unknown => {
      if (!Object.hasOwn(raw, name)) this.fail("missing_field", join(at, name))
      return raw[name]
    }
    const textField = (name: string, required: boolean): void => {
      if (!Object.hasOwn(raw, name)) {
        if (required) need(name)
        return
      }
      this.text(raw[name], join(at, name), TEXT_CAPS.get(name) ?? MAX_LABEL_CHARS, inner)
    }
    const numberField = (name: string): unknown => {
      if (!Object.hasOwn(raw, name)) {
        need(name)
        return null
      }
      return this.scalar(raw[name], join(at, name), inner, ["number"])
    }
    switch (kind) {
      case "divider":
        allow([])
        break
      case "meter": {
        allow(["label", "value", "min", "max"])
        textField("label", true)
        numberField("value")
        const min = numberField("min")
        const max = numberField("max")
        if (typeof min === "number" && typeof max === "number" && max <= min)
          this.fail("bad_field", join(at, "max"))
        break
      }
      case "stat": {
        allow(["label", "value"])
        textField("label", true)
        if (!Object.hasOwn(raw, "value")) {
          need("value")
          break
        }
        const value = raw.value
        const bound = this.binding(value, join(at, "value"), inner)
        if (bound !== undefined) break
        if (typeof value === "string" || isRecord(value))
          this.text(value, join(at, "value"), MAX_LABEL_CHARS, inner)
        else this.scalar(value, join(at, "value"), inner, ["number", "boolean"])
        break
      }
      case "badge":
        allow(["label", "tone"])
        textField("label", true)
        if (Object.hasOwn(raw, "tone")) {
          const tone = this.scalar(raw.tone, join(at, "tone"), inner, ["string"])
          if (typeof tone === "string" && !["info", "warn", "danger"].includes(tone)) {
            this.fail("bad_field", join(at, "tone"))
          }
        }
        break
      case "text":
        allow(["text", "style"])
        textField("text", true)
        if (Object.hasOwn(raw, "style") && raw.style !== "quote" && raw.style !== "warning") {
          this.fail("bad_field", join(at, "style"))
        }
        break
      case "image":
        allow(["src", "caption", "alt"])
        this.image(raw.src, join(at, "src"))
        textField("caption", false)
        textField("alt", false)
        break
      case "choices": {
        allow(["prompt", "options"])
        textField("prompt", false)
        const options = need("options")
        const optionsAt = join(at, "options")
        if (!Array.isArray(options) || options.length === 0) {
          if (options !== undefined) this.fail("bad_field", optionsAt)
          break
        }
        if (options.length > MAX_OPTIONS) {
          this.fail("too_many", optionsAt)
          break
        }
        const ids = new Set<string>()
        options.forEach((option, index) => {
          const optionAt = join(optionsAt, index)
          if (!isRecord(option)) {
            this.fail("not_a_mapping", optionAt)
            return
          }
          if (Object.hasOwn(option, "input")) this.fail("replaced_2x", join(optionAt, "input"), "input")
          this.closed(option, optionAt, ["id", "label", "command", "args", "input"])
          const id = option.id
          if (typeof id !== "string" || id.trim() === "" || charCount(id) > MAX_OPTION_ID_CHARS) {
            this.fail(id === undefined ? "missing_field" : "bad_id", join(optionAt, "id"))
          } else if (ids.has(id)) this.fail("duplicate", join(optionAt, "id"))
          else ids.add(id)
          if (Object.hasOwn(option, "label"))
            this.text(option.label, join(optionAt, "label"), MAX_LABEL_CHARS, inner)
          else this.fail("missing_field", join(optionAt, "label"))
          const command = option.command
          if (
            typeof command !== "string" ||
            charCount(command) > MAX_COMMAND_CHARS ||
            !COMMAND_ID.test(command)
          ) {
            if (!Object.hasOwn(option, "input")) {
              this.fail(command === undefined ? "missing_field" : "bad_id", join(optionAt, "command"))
            }
            return
          }
          if (Object.hasOwn(option, "args")) this.args(option.args, join(optionAt, "args"))
        })
        break
      }
      default: {
        const fields = PERFORMANCE.get(kind) as { required: readonly string[]; optional: readonly string[] }
        allow([...fields.required, ...fields.optional])
        for (const name of fields.required) {
          if (name === "src") this.image(raw.src, join(at, "src"))
          else if (name === "x" || name === "y") numberField(name)
          else textField(name, true)
        }
        for (const name of fields.optional) textField(name, false)
      }
    }
    if (gate !== undefined) this.condition(gate, join(at, "visible_when"), inner)
  }
}

/** What one panel names, as its checks found it. */
export interface CheckedPanel {
  id: string
  kind: "template" | "page"
  /** A page's HTML file. */
  entry: string | null
  /** Every picture its blocks name, once each. */
  images: string[]
}

export interface PanelsCheck {
  problems: PanelProblem[]
  /** The panels that read cleanly (in file order). */
  panels: CheckedPanel[]
}

function readViews(problems: PanelProblem[], raw: unknown, at: string): { as: string; view: string }[] {
  const fail = (code: PanelCode, path: string, detail?: string): void => {
    problems.push(detail === undefined ? { code, path } : { code, path, detail })
  }
  if (raw === undefined || raw === null) return []
  if (!isRecord(raw)) {
    fail("not_a_mapping", at)
    return []
  }
  const keys = Object.keys(raw)
  if (keys.length > MAX_PANEL_VIEWS) {
    fail("too_many", at)
    return []
  }
  const out: { as: string; view: string }[] = []
  for (const handle of keys) {
    const value = raw[handle]
    if (!VIEW_HANDLE.test(handle)) fail("bad_id", join(at, handle))
    else if (typeof value !== "string" || !isPanelViewName(value)) {
      fail("bad_view_name", join(at, handle), typeof value === "string" ? value : undefined)
    } else out.push({ as: handle, view: value })
  }
  return out
}

function readPanel(raw: unknown, at: string, problems: PanelProblem[]): CheckedPanel | null {
  const fail = (code: PanelCode, path: string, detail?: string): void => {
    problems.push(detail === undefined ? { code, path } : { code, path, detail })
  }
  if (!isRecord(raw)) {
    fail("not_a_mapping", at)
    return null
  }
  const id = raw.id
  if (typeof id !== "string" || !PANEL_ID.test(id)) {
    fail(id === undefined ? "missing_field" : "bad_id", join(at, "id"))
    return null
  }
  const before = problems.length
  const views = readViews(problems, raw.views, join(at, "views"))
  const reader = new PanelReader(problems, new Set(views.map((ref) => ref.as)))
  reader.closed(raw, at, [
    "id",
    "title",
    "slot",
    "audience",
    "views",
    "blocks",
    "entry",
    "fallback",
    "assets",
  ])
  if (Object.hasOwn(raw, "assets")) reader.fail("replaced_2x", join(at, "assets"), "assets")
  if (Object.hasOwn(raw, "title")) {
    const title = reader.text(raw.title, join(at, "title"), MAX_PANEL_TITLE_CHARS, null)
    if (title === "binding") reader.fail("bad_field", join(at, "title"))
  } else reader.fail("missing_field", join(at, "title"))
  const slot = raw.slot
  if (typeof slot !== "string" || !(PANEL_SLOTS as readonly string[]).includes(slot)) {
    reader.fail(slot === undefined ? "missing_field" : "bad_field", join(at, "slot"))
  }
  let audience: PanelAudience = "all"
  if (Object.hasOwn(raw, "audience")) {
    if (raw.audience === "keeper") reader.fail("replaced_2x", join(at, "audience"), "keeper")
    else if (
      typeof raw.audience !== "string" ||
      !(PANEL_AUDIENCES as readonly string[]).includes(raw.audience)
    ) {
      reader.fail("bad_field", join(at, "audience"))
    } else audience = raw.audience as PanelAudience
  }
  if (audience === "player" && views.some((ref) => isAdminViewName(ref.view))) {
    reader.fail("audience_conflict", join(at, "audience"))
  }

  let kind: "template" | "page" = "template"
  let entry: string | null = null
  if (Object.hasOwn(raw, "entry")) {
    kind = "page"
    if (Object.hasOwn(raw, "blocks")) reader.fail("unknown_key", join(at, "blocks"), "page")
    const file = raw.entry
    const entryAt = join(at, "entry")
    if (typeof file !== "string" || file.trim() === "") reader.fail("bad_field", entryAt)
    else {
      const value = file.trim()
      const problem = checkPackPath(value)
      if (problem !== null) reader.fail("bad_path", entryAt, problem)
      else if (!PAGE_EXTENSIONS.some((extension) => value.toLowerCase().endsWith(extension))) {
        reader.fail("bad_path", entryAt, "extension")
      } else entry = value
    }
    if (!Object.hasOwn(raw, "fallback")) reader.fail("missing_field", join(at, "fallback"))
    else if (raw.fallback !== null) reader.blocks(raw.fallback, join(at, "fallback"))
  } else {
    if (Object.hasOwn(raw, "fallback")) reader.fail("unknown_key", join(at, "fallback"), "template")
    reader.blocks(raw.blocks, join(at, "blocks"))
    if (problems.length === before) {
      for (const ref of views) {
        if (!reader.reads.has(ref.as)) reader.fail("unused_view", join(join(at, "views"), ref.as))
      }
    }
  }
  if (problems.length > before) return null
  return { id, kind, entry, images: [...reader.images] }
}

/** Check a panels file's value, already read from YAML. */
export function checkPanelsValue(document: unknown): PanelsCheck {
  const problems: PanelProblem[] = []
  if (!isRecord(document)) return { problems: [{ code: "not_a_mapping", path: "" }], panels: [] }
  for (const key of Object.keys(document))
    if (key !== "panels") problems.push({ code: "unknown_key", path: key })
  const list = document.panels
  if (!Array.isArray(list) || list.length === 0) {
    problems.push({ code: list === undefined ? "missing_field" : "bad_field", path: "panels" })
    return { problems, panels: [] }
  }
  if (list.length > MAX_PANELS_PER_PACK) {
    problems.push({ code: "too_many", path: "panels" })
    return { problems, panels: [] }
  }
  const panels: CheckedPanel[] = []
  const ids = new Set<string>()
  list.forEach((item, index) => {
    const panel = readPanel(item, join("panels", index), problems)
    if (panel === null) return
    if (ids.has(panel.id)) {
      problems.push({ code: "duplicate", path: join(join("panels", index), "id"), detail: panel.id })
    }
    ids.add(panel.id)
    panels.push(panel)
  })
  return { problems, panels }
}

/** Check a panels file's text. */
export function checkPanelsText(text: string): PanelsCheck {
  if (new TextEncoder().encode(text).length > MAX_PANELS_FILE_BYTES) {
    return { problems: [{ code: "too_large", path: "" }], panels: [] }
  }
  let document: unknown
  try {
    // The engine's loader refuses anchors and aliases; `maxAliasCount: 0` does too.
    document = parseYaml(text, { maxAliasCount: 0 })
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return { problems: [{ code: "bad_yaml", path: "", detail }], panels: [] }
  }
  return checkPanelsValue(document)
}
