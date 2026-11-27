// The `ui/panels.yaml` document (panels 3.0) as an editable model: parse it, edit it,
// write it back.
//
// The format is the engine's (`docs/lwf/formats/panels.md` in the engine repository):
// a panel declares the VIEWS it reads under short handles (`views: {me: me, tide:
// harbor/tide}`), a field reads a path inside one (`{$view: me.character.name}`), a
// `repeat` walks a list inside a view, `visible_when` tests paths, a `choices` option runs a
// command, and a page is one self-contained HTML file with a template `fallback`. The checks
// are `panelsCheck.ts`, a mirror of the engine's reader; what a panel SHOWS is the protocol
// package's `panelBlocks`, the one evaluation every client uses (see `panelsPreview.ts`).
//
// `BLOCK_FIELDS` is the whole block vocabulary in one table, so the editor renders a form
// per block kind without per-kind UI code.
//
// Two things this model refuses to lose. A BLOCK it cannot hold (a kind the engine grew
// after this file, a 1.x binding the migration could not translate) is carried through
// verbatim, in place — never dropped — and the checks say what is wrong with it. And keys it
// does not model are written back as they were. An editor that silently ate an author's
// work on save would be the worst bug it can have.

import { PANEL_SLOTS as PROTOCOL_PANEL_SLOTS, type PanelSlot as ProtocolPanelSlot } from "loreweaver-protocol"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { MAX_OPTIONS, PANEL_AUDIENCES as CHECK_AUDIENCES } from "./panelsCheck"

export const PANEL_SLOTS: readonly ProtocolPanelSlot[] = PROTOCOL_PANEL_SLOTS
export const PANEL_AUDIENCES = CHECK_AUDIENCES
export const BADGE_TONES = ["info", "warn", "danger"] as const
export const TEXT_STYLES = ["quote", "warning"] as const
export const MAX_CHOICE_OPTIONS = MAX_OPTIONS
/** The repeat element's handle when the author names none (`DEFAULT_REPEAT_AS`). */
export const DEFAULT_REPEAT_AS = "item"

export type PanelSlot = ProtocolPanelSlot
export type PanelAudience = (typeof PANEL_AUDIENCES)[number]

export function isPanelSlot(value: string): value is PanelSlot {
  return (PANEL_SLOTS as readonly string[]).includes(value)
}

export function isPanelAudience(value: string): value is PanelAudience {
  return (PANEL_AUDIENCES as readonly string[]).includes(value)
}

/** A localized string: `{en, zh}`, or a plain string in the YAML (read as `en`). */
export interface Localized {
  en: string
  zh: string
}

/** A field read from a view: `{$view: <path>}`. */
export interface ViewBinding {
  mode: "view"
  path: string
}

/** A scalar field: a literal as the file wrote it (string / number / boolean), or a binding. */
export type Scalar = { mode: "literal"; value: string | number | boolean } | ViewBinding

/** What a localized field may hold: text, or a binding. */
export type LocalizedField = Localized | ViewBinding

export function isLocalized(value: FieldValue): value is Localized {
  return "en" in value
}

/** One option of a `choices` block: what the client shows, and the command it runs. */
export interface ChoiceOptionDraft {
  uid: string
  id: string
  label: LocalizedField
  /** A command id: `help`, `rules.sanity_check`, `<module>/<command>`. */
  command: string
  /** The command's arguments as JSON text (an object), "" for none. */
  argsText: string
}

export interface OptionsField {
  mode: "options"
  options: ChoiceOptionDraft[]
}

export function isOptions(value: FieldValue): value is OptionsField {
  return "mode" in value && value.mode === "options"
}

export type FieldValue = LocalizedField | Scalar | OptionsField

/** `localized`/`scalar` may bind; `path` (`src`) and `enum` style are plain values. */
export type FieldType = "localized" | "scalar" | "path" | "enum" | "options"

export interface FieldSpec {
  name: string
  type: FieldType
  required: boolean
  /** enum fields only. */
  options?: readonly string[]
  /** A bindable enum (`badge.tone`). */
  bindable?: boolean
}

export type BlockKind =
  | "divider"
  | "meter"
  | "stat"
  | "badge"
  | "text"
  | "choices"
  | "image"
  | "letter"
  | "clipping"
  | "title_card"
  | "map_pin"

/** Every block kind and its fields (`panels.md` §5). Order is render order in the form. */
export const BLOCK_FIELDS: Record<BlockKind, readonly FieldSpec[]> = {
  divider: [],
  meter: [
    { name: "label", type: "localized", required: true },
    { name: "value", type: "scalar", required: true },
    { name: "min", type: "scalar", required: true },
    { name: "max", type: "scalar", required: true },
  ],
  stat: [
    { name: "label", type: "localized", required: true },
    { name: "value", type: "scalar", required: true },
  ],
  badge: [
    { name: "label", type: "localized", required: true },
    { name: "tone", type: "enum", required: false, options: BADGE_TONES, bindable: true },
  ],
  text: [
    { name: "text", type: "localized", required: true },
    { name: "style", type: "enum", required: false, options: TEXT_STYLES },
  ],
  choices: [
    { name: "prompt", type: "localized", required: false },
    { name: "options", type: "options", required: true },
  ],
  image: [
    { name: "src", type: "path", required: true },
    { name: "caption", type: "localized", required: false },
    { name: "alt", type: "localized", required: false },
  ],
  letter: [
    { name: "body", type: "localized", required: true },
    { name: "from", type: "localized", required: false },
    { name: "to", type: "localized", required: false },
    { name: "date", type: "localized", required: false },
  ],
  clipping: [
    { name: "headline", type: "localized", required: true },
    { name: "body", type: "localized", required: true },
    { name: "source", type: "localized", required: false },
    { name: "date", type: "localized", required: false },
  ],
  title_card: [
    { name: "title", type: "localized", required: true },
    { name: "subtitle", type: "localized", required: false },
    { name: "act", type: "localized", required: false },
  ],
  map_pin: [
    { name: "src", type: "path", required: true },
    { name: "label", type: "localized", required: true },
    { name: "x", type: "scalar", required: true },
    { name: "y", type: "scalar", required: true },
    { name: "note", type: "localized", required: false },
  ],
}

export const BLOCK_KINDS = Object.keys(BLOCK_FIELDS)

const FIELD_TABLE: Record<string, readonly FieldSpec[] | undefined> = BLOCK_FIELDS

/** The field specs of `kind`, or undefined for a kind this table does not model. */
export function fieldsFor(kind: string): readonly FieldSpec[] | undefined {
  return FIELD_TABLE[kind]
}

/** Whether a field may hold a `{$view}` binding. */
export function fieldMayBind(spec: Pick<FieldSpec, "type" | "bindable">): boolean {
  return spec.type === "localized" || spec.type === "scalar" || spec.bindable === true
}

/** `repeat: {each, as, prefix?, block}` around a block, with the repeat's own gate. */
export interface RepeatDraft {
  /** A path to a list inside a view (`me.character.resources`). */
  each: string
  /** The element's handle inside the block (default `item`). */
  as: string
  /** Keep only the elements whose key starts with this ("" for all). */
  prefix: string
  /** A condition on the whole list, read outside the element. */
  visibleWhen: string
}

export interface BlockDraft {
  /** Stable across edits so React keys and reorders do not fight the array index. */
  uid: string
  kind: string
  fields: Record<string, FieldValue>
  /** A condition over paths; empty means always shown. Inside a repeat it decides each instance. */
  visibleWhen: string
  repeat: RepeatDraft | null
  /** Set when this table does not model the block: the entry exactly as written. */
  raw?: unknown
  /** Keys this table does not model, written back as-is. */
  rest?: Record<string, unknown>
}

export function isOpaqueBlock(block: BlockDraft): boolean {
  return block.raw !== undefined
}

/** One `views` entry: a handle and the view it names. */
export interface ViewDecl {
  uid: string
  handle: string
  view: string
}

export interface PanelDraft {
  uid: string
  id: string
  title: Localized
  /** Written back as-is: unknown values stay unknown. */
  slot: string
  audience: string
  views: ViewDecl[]
  kind: "template" | "page"
  /** A template's blocks. */
  blocks: BlockDraft[]
  /** A page's HTML file (pack path). */
  entry: string
  /** A page's fallback: blocks, or `null` for "needs a rich client". */
  fallback: BlockDraft[] | null
  /** Keys this editor does not model, written back as-is (the checks flag them). */
  rest?: Record<string, unknown>
}

export interface PanelsDocument {
  panels: PanelDraft[]
}

let uidCounter = 0
export function nextUid(): string {
  uidCounter += 1
  return `p${uidCounter}`
}

export function emptyLocalized(): Localized {
  return { en: "", zh: "" }
}

export function literal(value: string | number | boolean = ""): Scalar {
  return { mode: "literal", value }
}

export function binding(path = ""): ViewBinding {
  return { mode: "view", path }
}

/** The editor's box is text. Coerce here — not in the serializer — so an untouched
 * `true` / `12` round-trips as whatever the file had. */
export function parseLiteralInput(text: string): Scalar {
  const trimmed = text.trim()
  if (trimmed === "true") return literal(true)
  if (trimmed === "false") return literal(false)
  if (trimmed === "") return literal("")
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric) && String(numeric) === trimmed) return literal(numeric)
  return literal(text)
}

export function newOption(): ChoiceOptionDraft {
  return { uid: nextUid(), id: "", label: emptyLocalized(), command: "", argsText: "" }
}

export function emptyFieldValue(type: FieldType): FieldValue {
  if (type === "localized") return emptyLocalized()
  if (type === "options") return { mode: "options", options: [] }
  return literal()
}

export function newBlock(kind: string): BlockDraft {
  const fields: Record<string, FieldValue> = {}
  for (const spec of fieldsFor(kind) ?? []) fields[spec.name] = emptyFieldValue(spec.type)
  return { uid: nextUid(), kind, fields, visibleWhen: "", repeat: null }
}

export function newRepeat(): RepeatDraft {
  return { each: "", as: DEFAULT_REPEAT_AS, prefix: "", visibleWhen: "" }
}

export function newViewDecl(handle = "", view = ""): ViewDecl {
  return { uid: nextUid(), handle, view }
}

export function newPanel(): PanelDraft {
  return {
    uid: nextUid(),
    id: "",
    title: emptyLocalized(),
    slot: "sidebar",
    audience: "all",
    views: [],
    kind: "template",
    blocks: [],
    entry: "",
    fallback: null,
  }
}

// --- reading ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isViewBindingShape(raw: unknown): raw is { $view: string } {
  return isRecord(raw) && Object.keys(raw).length === 1 && typeof raw.$view === "string"
}

/** A localized field; null when the value is neither text nor a well-formed binding. */
function readLocalized(raw: unknown): LocalizedField | null {
  if (typeof raw === "string") return { en: raw, zh: "" }
  if (isViewBindingShape(raw)) return binding(raw.$view)
  if (isRecord(raw) && Object.keys(raw).every((key) => key === "en" || key === "zh")) {
    return { en: typeof raw.en === "string" ? raw.en : "", zh: typeof raw.zh === "string" ? raw.zh : "" }
  }
  return null
}

function readScalar(raw: unknown): Scalar | null {
  if (isViewBindingShape(raw)) return binding(raw.$view)
  if (raw === null || raw === undefined) return literal()
  if (typeof raw === "boolean" || typeof raw === "string") return literal(raw)
  if (typeof raw === "number" && Number.isFinite(raw)) return literal(raw)
  return null
}

function readOptions(raw: unknown): OptionsField | null {
  if (!Array.isArray(raw)) return null
  const options: ChoiceOptionDraft[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return null
    // A 1.x `input`, or a key this table does not know: the block stays verbatim.
    if (Object.keys(entry).some((key) => !["id", "label", "command", "args"].includes(key))) return null
    const label = readLocalized(entry.label)
    if (label === null) return null
    if (entry.args !== undefined && !isRecord(entry.args)) return null
    options.push({
      uid: nextUid(),
      id: typeof entry.id === "string" ? entry.id : "",
      label,
      command: typeof entry.command === "string" ? entry.command : "",
      argsText: entry.args === undefined ? "" : JSON.stringify(entry.args),
    })
  }
  return { mode: "options", options }
}

function leftovers(
  map: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> | undefined {
  const rest: Record<string, unknown> = {}
  let any = false
  for (const [key, value] of Object.entries(map)) {
    if (known.includes(key)) continue
    rest[key] = value
    any = true
  }
  return any ? rest : undefined
}

function opaqueBlock(raw: unknown): BlockDraft {
  const map = isRecord(raw) ? raw : null
  let kind = map && typeof map.kind === "string" ? map.kind : ""
  if (!kind && map && isRecord(map.repeat) && isRecord(map.repeat.block)) {
    const innerKind = map.repeat.block.kind
    kind = typeof innerKind === "string" ? innerKind : ""
  }
  return { uid: nextUid(), kind: kind || "?", fields: {}, visibleWhen: "", repeat: null, raw }
}

function readModeledBlock(raw: unknown): BlockDraft | null {
  if (!isRecord(raw)) return null
  const kind = typeof raw.kind === "string" ? raw.kind : ""
  const specs = fieldsFor(kind)
  if (specs === undefined) return null
  const block = newBlock(kind)
  for (const spec of specs) {
    if (!(spec.name in raw)) continue
    const value = raw[spec.name]
    const read =
      spec.type === "localized"
        ? readLocalized(value)
        : spec.type === "options"
          ? readOptions(value)
          : readScalar(value)
    if (read === null) return null
    block.fields[spec.name] = read
  }
  if (raw.visible_when !== undefined) {
    if (typeof raw.visible_when !== "string") return null
    block.visibleWhen = raw.visible_when
  }
  const rest = leftovers(raw, ["kind", "visible_when", ...specs.map((spec) => spec.name)])
  if (rest) block.rest = rest
  return block
}

function readBlock(raw: unknown): BlockDraft {
  if (isRecord(raw) && isRecord(raw.repeat)) {
    const repeat = raw.repeat
    const inner = readModeledBlock(repeat.block)
    // Extra keys on the wrapper or the `repeat` itself cannot sit on the inner block
    // without colliding, so such a wrapper stays verbatim.
    const extra =
      leftovers(raw, ["repeat", "visible_when"]) || leftovers(repeat, ["each", "as", "prefix", "block"])
    const stringOrAbsent = (value: unknown) => value === undefined || typeof value === "string"
    if (
      inner !== null &&
      extra === undefined &&
      typeof repeat.each === "string" &&
      stringOrAbsent(repeat.as) &&
      stringOrAbsent(repeat.prefix) &&
      stringOrAbsent(raw.visible_when)
    ) {
      return {
        ...inner,
        repeat: {
          each: repeat.each,
          as: typeof repeat.as === "string" ? repeat.as : DEFAULT_REPEAT_AS,
          prefix: typeof repeat.prefix === "string" ? repeat.prefix : "",
          visibleWhen: typeof raw.visible_when === "string" ? raw.visible_when : "",
        },
      }
    }
    return opaqueBlock(raw)
  }
  return readModeledBlock(raw) ?? opaqueBlock(raw)
}

function readBlocks(raw: unknown): BlockDraft[] {
  return Array.isArray(raw) ? raw.map(readBlock) : []
}

function readTitle(raw: unknown): Localized {
  const value = readLocalized(raw)
  return value !== null && isLocalized(value) ? value : emptyLocalized()
}

function readViews(raw: unknown): ViewDecl[] {
  if (!isRecord(raw)) return []
  return Object.entries(raw).map(([handle, view]) =>
    newViewDecl(handle, typeof view === "string" ? view : ""),
  )
}

export interface ParseResult {
  document: PanelsDocument
  /** A YAML or shape error the editor cannot recover from; the document is empty. */
  error: string | null
}

export function parsePanelsYaml(text: string): ParseResult {
  if (!text.trim()) return { document: { panels: [] }, error: null }
  try {
    return documentFromRaw(parseYaml(text))
  } catch (error) {
    return { document: { panels: [] }, error: String(error) }
  }
}

/** The same reader over an already-parsed value — YAML from a file, JSON from a model. */
export function documentFromRaw(raw: unknown): ParseResult {
  if (!isRecord(raw) || !Array.isArray(raw.panels)) {
    return { document: { panels: [] }, error: "panels.yaml root must be a mapping with a `panels` list" }
  }
  const panels: PanelDraft[] = []
  for (const entry of raw.panels) {
    if (!isRecord(entry)) continue
    const page = "entry" in entry
    const rest = leftovers(entry, ["id", "title", "slot", "audience", "views", "blocks", "entry", "fallback"])
    // Keys a page does not take (`blocks`) or a template does not take (`fallback`) are kept as written.
    const extra: Record<string, unknown> = { ...(rest ?? {}) }
    if (page && "blocks" in entry) extra.blocks = entry.blocks
    if (!page && "fallback" in entry) extra.fallback = entry.fallback
    panels.push({
      uid: nextUid(),
      id: typeof entry.id === "string" ? entry.id : "",
      title: readTitle(entry.title),
      slot: typeof entry.slot === "string" ? entry.slot : "sidebar",
      audience: typeof entry.audience === "string" ? entry.audience : "all",
      views: readViews(entry.views),
      kind: page ? "page" : "template",
      blocks: page ? [] : readBlocks(entry.blocks),
      entry: page && typeof entry.entry === "string" ? entry.entry : "",
      fallback: page
        ? entry.fallback === null || entry.fallback === undefined
          ? null
          : readBlocks(entry.fallback)
        : null,
      ...(Object.keys(extra).length > 0 ? { rest: extra } : {}),
    })
  }
  return { document: { panels }, error: null }
}

// --- writing ---------------------------------------------------------------

/** A plain string is `en`; a mapping carries the NON-EMPTY locales only — a blank locale is
 * refused by the engine (`title.en: bad_field`), so it is omitted, never written blank. */
function writeLocalized(value: LocalizedField): unknown {
  if (!isLocalized(value)) return { $view: value.path }
  const hasEn = value.en.trim() !== ""
  const hasZh = value.zh.trim() !== ""
  if (hasEn && hasZh) return { en: value.en, zh: value.zh }
  if (hasZh) return { zh: value.zh }
  return value.en
}

function writeScalar(value: Scalar): unknown {
  return value.mode === "view" ? { $view: value.path } : value.value
}

/** The args text as an object; undefined when blank or not a JSON object (the checks flag it). */
export function parseArgsText(text: string): Record<string, unknown> | null | undefined {
  if (!text.trim()) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeOptions(value: OptionsField): unknown {
  return value.options.map((option) => {
    const out: Record<string, unknown> = {
      id: option.id,
      label: writeLocalized(option.label),
      command: option.command,
    }
    const args = parseArgsText(option.argsText)
    // Unparseable args are written as the text they are, so the checks (and the build) say so
    // instead of the editor silently dropping what the author typed.
    if (args !== undefined) out.args = args === null ? option.argsText : args
    return out
  })
}

function fieldBlank(value: FieldValue): boolean {
  if (isOptions(value)) return value.options.length === 0
  if (isLocalized(value)) return !value.en.trim() && !value.zh.trim()
  if (value.mode === "view") return !value.path.trim()
  return typeof value.value === "string" && !value.value.trim()
}

export function writeBlock(block: BlockDraft): unknown {
  if (block.raw !== undefined) return block.raw
  const out: Record<string, unknown> = { kind: block.kind }
  for (const spec of fieldsFor(block.kind) ?? []) {
    const value = block.fields[spec.name]
    if (value === undefined) continue
    if (!spec.required && fieldBlank(value)) continue
    if (isOptions(value)) out[spec.name] = writeOptions(value)
    else if (spec.type === "localized") out[spec.name] = writeLocalized(value as LocalizedField)
    else out[spec.name] = writeScalar(value as Scalar)
  }
  if (block.visibleWhen.trim()) out.visible_when = block.visibleWhen.trim()
  if (block.rest) Object.assign(out, block.rest)
  if (block.repeat !== null) {
    const repeat: Record<string, unknown> = { each: block.repeat.each.trim() }
    const as = block.repeat.as.trim()
    if (as && as !== DEFAULT_REPEAT_AS) repeat.as = as
    if (block.repeat.prefix !== "") repeat.prefix = block.repeat.prefix
    repeat.block = out
    const wrapper: Record<string, unknown> = { repeat }
    if (block.repeat.visibleWhen.trim()) wrapper.visible_when = block.repeat.visibleWhen.trim()
    return wrapper
  }
  return out
}

export function writePanel(panel: PanelDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { id: panel.id, title: writeLocalized(panel.title), slot: panel.slot }
  if (panel.audience !== "all") out.audience = panel.audience
  if (panel.views.length > 0) {
    const views: Record<string, string> = {}
    for (const decl of panel.views) views[decl.handle] = decl.view
    out.views = views
  }
  if (panel.kind === "page") {
    out.entry = panel.entry
    out.fallback = panel.fallback === null ? null : panel.fallback.map(writeBlock)
  } else {
    out.blocks = panel.blocks.map(writeBlock)
  }
  if (panel.rest) Object.assign(out, panel.rest)
  return out
}

export function serializePanelsYaml(document: PanelsDocument): string {
  if (document.panels.length === 0) return ""
  return stringifyYaml({ panels: document.panels.map(writePanel) }, { lineWidth: 0 })
}

/** Every opaque block, across templates and fallbacks. */
export function opaqueBlockCount(document: PanelsDocument): number {
  let count = 0
  for (const panel of document.panels) {
    for (const block of [...panel.blocks, ...(panel.fallback ?? [])]) if (isOpaqueBlock(block)) count += 1
  }
  return count
}
