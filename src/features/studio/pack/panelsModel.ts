// The `ui/panels.yaml` document as an editable model: parse it, edit it, write it
// back, and say what is wrong with it before the build does.
//
// The schema authority is the ENGINE (`core/panels.py`); this is a mirror, and it
// mirrors the one thing an editor needs that a validator does not — the FIELD TABLE.
// `BLOCK_FIELDS` below is the whole vocabulary in one place, so the editor renders a
// form per block kind without a line of per-kind UI, and a rule system's new block
// type reaches the editor by adding a row.
//
// Deliberately NOT a second validator: `problemsFor` catches what an author can fix
// while typing (a missing required field, a binding to a variable the pack never
// declared, a max below a min). `--pack` remains the gate a release passes.
//
// Two things this model refuses to lose. Tier 2 panels — the ones that ship their own
// HTML/JS (`entry`/`assets`/`fallback`) — are carried through UNTOUCHED as opaque
// entries. And a BLOCK this table does not model (a kind the engine grew after this
// file, or one written in a shape the form cannot hold) is carried through as an
// opaque block, verbatim, in place — never dropped. An editor that silently ate an
// author's work on save would be the worst bug it can have.

import type { PanelSlot as WirePanelSlot, UiBlock } from "@loreweaver/protocol"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

/** `core/panels.py` `PANEL_SLOTS`, pinned to the protocol package's `PanelSlot` (the
 * engine's tests pin THAT to the engine). Not the hook `ui` FRAME's `inline|sidebar` —
 * that is a different vocabulary, for a different thing. */
export const PANEL_SLOTS = ["sidebar", "tray", "modal"] as const satisfies readonly WirePanelSlot[]
export const PANEL_AUDIENCES = ["all", "player", "keeper"] as const
export const BADGE_TONES = ["info", "warn", "danger"] as const
export const TEXT_STYLES = ["quote", "warning"] as const
/** `core/hooks.py` `MAX_UI_OPTIONS`: the engine refuses a `choices` block past this. */
export const MAX_CHOICE_OPTIONS = 12

export type PanelSlot = (typeof PANEL_SLOTS)[number]
/** Every block kind the wire knows — the key set `BLOCK_FIELDS` must cover exactly. */
export type WireBlockKind = UiBlock["kind"]
export type PanelAudience = (typeof PANEL_AUDIENCES)[number]

/** A localized string: `{en, zh}`, or a plain string in the YAML (read as `en`). */
export interface Localized {
  en: string
  zh: string
}

/** What a LOCALIZED field may hold. Inside a `repeat`, the schema lets a binding
 * stand where a label would — `{$leaf: label}` is how one instance names itself —
 * so a model that only understood the text pair would erase that on the next save. */
export type LocalizedField = Localized | Scalar

export function isLocalized(value: FieldValue): value is Localized {
  return "en" in value
}

export const LEAF_PARTS = ["id", "label", "value"] as const
export type LeafPart = (typeof LEAF_PARTS)[number]

/** A scalar field: a literal the author typed, a live binding to a variable, or —
 * inside a `repeat` — one part of the variable the current instance stands for. */
export type Scalar =
  { mode: "literal"; text: string } | { mode: "var"; path: string } | { mode: "leaf"; leaf: LeafPart }

/** One option of a `choices` block: what the client shows, and the input it sends
 * when picked. The label may bind, like any localized field. */
export interface ChoiceOptionDraft {
  uid: string
  id: string
  label: LocalizedField
  input: string
}

export interface OptionsField {
  mode: "options"
  options: ChoiceOptionDraft[]
}

export function isOptions(value: FieldValue): value is OptionsField {
  return "mode" in value && value.mode === "options"
}

/** Everything a block field may hold. */
export type FieldValue = LocalizedField | OptionsField

/** `localized`/`scalar` may hold a binding; `path` and `enum` are plain strings to the
 * engine (`_validated_asset_path`, `style not in UI_TEXT_STYLES`) — no binding there. */
export type FieldType = "localized" | "scalar" | "path" | "enum" | "options"

export interface FieldSpec {
  name: string
  type: FieldType
  required: boolean
  /** enum fields only. */
  options?: readonly string[]
}

/** Every Tier-1 block kind and its fields, mirroring `core/panels.py`'s own table
 * (`_validate_block`). Order is render order in the form. Typed over the protocol
 * package's block union, so a kind the engine grows (or drops) fails to COMPILE here
 * rather than silently becoming an opaque block. */
export const BLOCK_FIELDS: Record<WireBlockKind, readonly FieldSpec[]> = {
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
    { name: "tone", type: "enum", required: false, options: BADGE_TONES },
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

/** The same table, indexable by an arbitrary string (a kind read from a file). */
const FIELD_TABLE: Record<string, readonly FieldSpec[] | undefined> = BLOCK_FIELDS

/** The field specs of `kind`, or undefined for a kind this table does not model. */
export function fieldsFor(kind: string): readonly FieldSpec[] | undefined {
  return FIELD_TABLE[kind]
}

/** Whether a field of this type may hold a `$var` / `$leaf` binding at all. */
export function fieldMayBind(type: FieldType): boolean {
  return type === "localized" || type === "scalar"
}

export interface BlockDraft {
  /** Stable across edits so React keys and reorders do not fight the array index. */
  uid: string
  kind: string
  /** Field name → value. A localized field holds text OR a binding; the rest a `Scalar`,
   * or an option list for a `choices` block. Empty for an opaque block. */
  fields: Record<string, FieldValue>
  /** A `core.condexpr` condition the CLIENT evaluates; empty means always shown.
   * Inside a repeat this is the per-INSTANCE condition. */
  visibleWhen: string
  /** `{repeat: {prefix, block}}` — one instance per visible variable with this
   * prefix. Empty means the block renders once. Repeat does not nest. */
  repeatPrefix: string
  /** A condition on the repeat WRAPPER — gates the whole repeat, not one instance.
   * Only meaningful with `repeatPrefix`; the engine accepts `visible_when` on both. */
  repeatVisibleWhen: string
  /** Set when this table does not model the block: the entry exactly as written.
   * Written back verbatim; the form shows it as opaque instead of eating it. */
  raw?: unknown
}

export function isOpaqueBlock(block: BlockDraft): boolean {
  return block.raw !== undefined
}

export interface PanelDraft {
  uid: string
  id: string
  title: Localized
  slot: PanelSlot
  audience: PanelAudience
  blocks: BlockDraft[]
}

/** A tier-2 panel (or anything else this editor does not model), kept verbatim. */
export interface OpaquePanel {
  uid: string
  id: string
  raw: Record<string, unknown>
}

export interface PanelsDocument {
  panels: PanelDraft[]
  opaque: OpaquePanel[]
}

let uidCounter = 0
export function nextUid(): string {
  uidCounter += 1
  return `p${uidCounter}`
}

export function emptyLocalized(): Localized {
  return { en: "", zh: "" }
}

export function literal(text = ""): Scalar {
  return { mode: "literal", text }
}

export function newOption(): ChoiceOptionDraft {
  return { uid: nextUid(), id: "", label: emptyLocalized(), input: "" }
}

export function emptyFieldValue(type: FieldType): FieldValue {
  if (type === "localized") return emptyLocalized()
  if (type === "options") return { mode: "options", options: [] }
  return literal()
}

export function isLocalizedField(kind: string, field: string): boolean {
  return fieldsFor(kind)?.find((spec) => spec.name === field)?.type === "localized"
}

export function newBlock(kind: string): BlockDraft {
  const fields: Record<string, FieldValue> = {}
  for (const spec of fieldsFor(kind) ?? []) {
    fields[spec.name] = emptyFieldValue(spec.type)
  }
  return { uid: nextUid(), kind, fields, visibleWhen: "", repeatPrefix: "", repeatVisibleWhen: "" }
}

export function newPanel(): PanelDraft {
  return {
    uid: nextUid(),
    id: "",
    title: emptyLocalized(),
    slot: "sidebar",
    audience: "all",
    blocks: [],
  }
}

// --- reading ---------------------------------------------------------------

function readPlainLocalized(raw: unknown): Localized {
  const value = readLocalized(raw)
  return isLocalized(value) ? value : emptyLocalized()
}

function readLocalized(raw: unknown): LocalizedField {
  if (typeof raw === "string") return { en: raw, zh: "" }
  if (raw && typeof raw === "object") {
    const map = raw as Record<string, unknown>
    if ("$var" in map || "$leaf" in map) return readScalar(raw)
    return {
      en: typeof map.en === "string" ? map.en : "",
      zh: typeof map.zh === "string" ? map.zh : "",
    }
  }
  return emptyLocalized()
}

function readScalar(raw: unknown): Scalar {
  if (raw && typeof raw === "object") {
    const map = raw as Record<string, unknown>
    if ("$var" in map) {
      return { mode: "var", path: typeof map.$var === "string" ? map.$var : "" }
    }
    // `{$leaf: id|label|value}` is the repeat instance's own variable. Reading it as
    // anything else stringifies it to "[object Object]" and destroys the block on the
    // next save — an editor eating a working panel is the worst bug it can have.
    if ("$leaf" in map) {
      const leaf = map.$leaf
      return {
        mode: "leaf",
        leaf: LEAF_PARTS.includes(leaf as LeafPart) ? (leaf as LeafPart) : "value",
      }
    }
  }
  if (raw === null || raw === undefined) return literal()
  return literal(String(raw))
}

function readOptions(raw: unknown): OptionsField {
  const options: ChoiceOptionDraft[] = []
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== "object") continue
    const map = entry as Record<string, unknown>
    options.push({
      uid: nextUid(),
      id: typeof map.id === "string" ? map.id : "",
      label: readLocalized(map.label),
      input: typeof map.input === "string" ? map.input : "",
    })
  }
  return { mode: "options", options }
}

function readField(spec: FieldSpec, raw: unknown): FieldValue {
  if (spec.type === "localized") return readLocalized(raw)
  if (spec.type === "options") return readOptions(raw)
  return readScalar(raw)
}

/** A block this table cannot hold, kept exactly as written. `kind` is only a name
 * for the form to show. */
function opaqueBlock(raw: unknown): BlockDraft {
  const map = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null
  let kind = map && typeof map.kind === "string" ? map.kind : ""
  if (!kind && map && map.repeat && typeof map.repeat === "object") {
    const inner = (map.repeat as Record<string, unknown>).block
    const innerKind = inner && typeof inner === "object" ? (inner as Record<string, unknown>).kind : ""
    kind = typeof innerKind === "string" ? innerKind : ""
  }
  return {
    uid: nextUid(),
    kind: kind || "?",
    fields: {},
    visibleWhen: "",
    repeatPrefix: "",
    repeatVisibleWhen: "",
    raw,
  }
}

function readModeledBlock(raw: unknown): BlockDraft | null {
  if (!raw || typeof raw !== "object") return null
  const map = raw as Record<string, unknown>
  const kind = typeof map.kind === "string" ? map.kind : ""
  const specs = fieldsFor(kind)
  if (specs === undefined) return null
  const block = newBlock(kind)
  for (const spec of specs) {
    if (!(spec.name in map)) continue
    block.fields[spec.name] = readField(spec, map[spec.name])
  }
  if (typeof map.visible_when === "string") block.visibleWhen = map.visible_when
  return block
}

function readBlock(raw: unknown): BlockDraft {
  if (raw && typeof raw === "object") {
    const map = raw as Record<string, unknown>
    // `{repeat: {prefix, block}}` unwraps into the block plus its prefix; the editor
    // shows it as one block with "repeat over" filled in, since repeat cannot nest.
    // A `visible_when` on the WRAPPER gates the whole repeat and is kept apart from
    // the inner block's per-instance one — the engine accepts both.
    if (map.repeat && typeof map.repeat === "object") {
      const repeat = map.repeat as Record<string, unknown>
      const inner = readModeledBlock(repeat.block)
      if (inner !== null && typeof repeat.prefix === "string") {
        return {
          ...inner,
          repeatPrefix: repeat.prefix,
          repeatVisibleWhen: typeof map.visible_when === "string" ? map.visible_when : "",
        }
      }
      return opaqueBlock(raw)
    }
    const block = readModeledBlock(raw)
    if (block !== null) return block
  }
  return opaqueBlock(raw)
}

export interface ParseResult {
  document: PanelsDocument
  /** A YAML or shape error the editor cannot recover from; the document is empty. */
  error: string | null
  /** Blocks carried through as opaque because this table does not model them. */
  opaqueBlocks: number
}

export function parsePanelsYaml(text: string): ParseResult {
  const empty: PanelsDocument = { panels: [], opaque: [] }
  if (!text.trim()) return { document: empty, error: null, opaqueBlocks: 0 }
  try {
    return documentFromRaw(parseYaml(text))
  } catch (error) {
    return { document: empty, error: String(error), opaqueBlocks: 0 }
  }
}

/** The same reader over an already-parsed value — YAML from a file, JSON from a
 * model. One reader, so a drafted panel and a hand-written one are read alike. */
export function documentFromRaw(raw: unknown): ParseResult {
  const empty: PanelsDocument = { panels: [], opaque: [] }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).panels)) {
    return {
      document: empty,
      error: "panels.yaml root must be a mapping with a `panels` list",
      opaqueBlocks: 0,
    }
  }
  const panels: PanelDraft[] = []
  const opaque: OpaquePanel[] = []
  let opaqueBlocks = 0
  for (const entry of (raw as { panels: unknown[] }).panels) {
    if (!entry || typeof entry !== "object") continue
    const map = entry as Record<string, unknown>
    const id = typeof map.id === "string" ? map.id : ""
    if ("entry" in map) {
      opaque.push({ uid: nextUid(), id, raw: map })
      continue
    }
    const blocks: BlockDraft[] = []
    for (const rawBlock of Array.isArray(map.blocks) ? map.blocks : []) {
      const block = readBlock(rawBlock)
      if (isOpaqueBlock(block)) opaqueBlocks += 1
      blocks.push(block)
    }
    panels.push({
      uid: nextUid(),
      id,
      // A panel TITLE is strictly text — the schema forbids a binding there
      // ("must be a plain string or en/zh mapping (no bindings)").
      title: readPlainLocalized(map.title),
      slot: PANEL_SLOTS.includes(map.slot as PanelSlot) ? (map.slot as PanelSlot) : "sidebar",
      audience: PANEL_AUDIENCES.includes(map.audience as PanelAudience)
        ? (map.audience as PanelAudience)
        : "all",
      blocks,
    })
  }
  return { document: { panels, opaque }, error: null, opaqueBlocks }
}

// --- writing ---------------------------------------------------------------

/** Mirrors the engine's `_localized`: a plain string is `en`; a mapping carries any
 * NON-EMPTY subset of `en`/`zh`. An empty locale must be OMITTED, not written blank —
 * `{en: "", zh: 水}` is refused by the build ("title.en: must be a non-empty string"). */
function writeLocalized(value: LocalizedField): unknown {
  if (!isLocalized(value)) return writeScalar(value)
  const hasEn = value.en.trim() !== ""
  const hasZh = value.zh.trim() !== ""
  if (hasEn && hasZh) return { en: value.en, zh: value.zh }
  if (hasZh) return { zh: value.zh }
  // en-only (or blank — a required blank is a problem `problemsFor` names, not
  // something the serializer papers over).
  return value.en
}

function writeScalar(value: Scalar): unknown {
  if (value.mode === "var") return { $var: value.path }
  if (value.mode === "leaf") return { $leaf: value.leaf }
  const text = value.text.trim()
  if (text === "") return ""
  // What YAML itself would read from the same characters: a number stays a number, a
  // boolean stays a boolean (a hand-written `value: true` must not come back `"true"`).
  if (text === "true") return true
  if (text === "false") return false
  const numeric = Number(text)
  return Number.isFinite(numeric) && String(numeric) === text ? numeric : text
}

function writeOptions(value: OptionsField): unknown {
  return value.options.map((option) => ({
    id: option.id,
    label: writeLocalized(option.label),
    input: option.input,
  }))
}

function fieldBlank(value: FieldValue): boolean {
  if (isOptions(value)) return value.options.length === 0
  if (isLocalized(value)) return !value.en.trim() && !value.zh.trim()
  if (value.mode === "var") return !value.path.trim()
  if (value.mode === "leaf") return false
  return !value.text.trim()
}

function writeBlock(block: BlockDraft): unknown {
  if (block.raw !== undefined) return block.raw
  const out: Record<string, unknown> = { kind: block.kind }
  for (const spec of fieldsFor(block.kind) ?? []) {
    const value = block.fields[spec.name]
    if (value === undefined) continue
    if (!spec.required && fieldBlank(value)) continue
    if (isOptions(value)) out[spec.name] = writeOptions(value)
    else if (spec.type === "localized") out[spec.name] = writeLocalized(value)
    else out[spec.name] = writeScalar(value as Scalar)
  }
  if (block.visibleWhen.trim()) out.visible_when = block.visibleWhen.trim()
  if (block.repeatPrefix.trim()) {
    const wrapper: Record<string, unknown> = {
      repeat: { prefix: block.repeatPrefix.trim(), block: out },
    }
    if (block.repeatVisibleWhen.trim()) wrapper.visible_when = block.repeatVisibleWhen.trim()
    return wrapper
  }
  return out
}

function writePanel(panel: PanelDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: panel.id,
    title: writeLocalized(panel.title),
    slot: panel.slot,
  }
  if (panel.audience !== "all") out.audience = panel.audience
  out.blocks = panel.blocks.map(writeBlock)
  return out
}

export function serializePanelsYaml(document: PanelsDocument): string {
  const panels = [...document.panels.map(writePanel), ...document.opaque.map((entry) => entry.raw)]
  if (panels.length === 0) return ""
  return stringifyYaml({ panels }, { lineWidth: 0 })
}

// --- checking --------------------------------------------------------------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** What an author can fix while typing. Message strings are i18n keys with params,
 * so the panel renders them in the studio's language. */
export interface PanelProblem {
  key: string
  params?: Record<string, string | number>
}

export function problemsFor(document: PanelsDocument, declaredVars: Set<string>): PanelProblem[] {
  const problems: PanelProblem[] = []
  const seen = new Set<string>()
  const knownVar = (path: string): boolean => {
    if (declaredVars.size === 0) return true
    const root = path.split(".")[0]
    return declaredVars.has(path) || declaredVars.has(root)
  }
  const checkBinding = (at: string, field: string, value: FieldValue, type: FieldType, inRepeat: boolean) => {
    if (isOptions(value) || isLocalized(value) || value.mode === "literal") return
    if (!fieldMayBind(type)) {
      problems.push({ key: "bindingNotAllowed", params: { at, field } })
      return
    }
    // A `$leaf` names the repeat instance's own variable — outside a repeat there is
    // no instance, and the engine refuses it at build time.
    if (value.mode === "leaf") {
      if (!inRepeat) problems.push({ key: "leafOutsideRepeat", params: { at, field } })
      return
    }
    // A binding that resolves to nothing DROPS the whole block at render time,
    // so an undeclared path is a silent blank panel, not a visible error.
    if (value.path.trim() && !knownVar(value.path))
      problems.push({ key: "unknownVar", params: { at, path: value.path } })
  }

  for (const panel of document.panels) {
    const where = panel.id || "(unnamed)"
    if (!SLUG_RE.test(panel.id)) problems.push({ key: "badId", params: { panel: where } })
    else if (seen.has(panel.id)) problems.push({ key: "duplicateId", params: { panel: panel.id } })
    seen.add(panel.id)
    if (!panel.title.en.trim() && !panel.title.zh.trim())
      problems.push({ key: "noTitle", params: { panel: where } })
    if (panel.blocks.length === 0) problems.push({ key: "noBlocks", params: { panel: where } })

    for (const [index, block] of panel.blocks.entries()) {
      if (isOpaqueBlock(block)) continue // kept verbatim; the build is its judge
      const at = `${where} #${index + 1}`
      const inRepeat = block.repeatPrefix.trim() !== ""
      for (const spec of fieldsFor(block.kind) ?? []) {
        const value = block.fields[spec.name]
        const blank = value === undefined || fieldBlank(value)
        if (spec.required && blank) {
          problems.push({ key: "missingField", params: { at, field: spec.name } })
          continue
        }
        if (value === undefined) continue
        if (isOptions(value)) {
          if (value.options.length > MAX_CHOICE_OPTIONS)
            problems.push({ key: "tooManyOptions", params: { at, max: MAX_CHOICE_OPTIONS } })
          for (const [optionIndex, option] of value.options.entries()) {
            const optionAt = `${at} option ${optionIndex + 1}`
            if (!option.id.trim() || !option.input.trim() || fieldBlank(option.label))
              problems.push({ key: "optionIncomplete", params: { at: optionAt } })
            checkBinding(optionAt, "label", option.label, "localized", inRepeat)
          }
          continue
        }
        checkBinding(at, spec.name, value, spec.type, inRepeat)
      }
      if (block.kind === "meter") {
        const min = block.fields.min as Scalar | undefined
        const max = block.fields.max as Scalar | undefined
        if (min?.mode === "literal" && max?.mode === "literal") {
          const low = Number(min.text)
          const high = Number(max.text)
          if (Number.isFinite(low) && Number.isFinite(high) && high <= low)
            problems.push({ key: "meterRange", params: { at } })
        }
      }
    }
  }
  return problems
}
