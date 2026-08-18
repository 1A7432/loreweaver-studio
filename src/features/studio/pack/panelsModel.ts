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
// Tier 2 panels — the ones that ship their own HTML/JS (`entry`/`assets`/`fallback`)
// — are carried through UNTOUCHED as opaque entries. They are code, not a form, and
// an editor that silently dropped them on save would eat an author's work.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

export const PANEL_SLOTS = ["sidebar", "inline"] as const
export const PANEL_AUDIENCES = ["all", "player", "keeper"] as const
export const BADGE_TONES = ["info", "warn", "danger"] as const
export const TEXT_STYLES = ["quote", "warning"] as const

export type PanelSlot = (typeof PANEL_SLOTS)[number]
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

export function isLocalized(value: LocalizedField): value is Localized {
  return "en" in value
}

export const LEAF_PARTS = ["id", "label", "value"] as const
export type LeafPart = (typeof LEAF_PARTS)[number]

/** A scalar field: a literal the author typed, a live binding to a variable, or —
 * inside a `repeat` — one part of the variable the current instance stands for. */
export type Scalar =
  { mode: "literal"; text: string } | { mode: "var"; path: string } | { mode: "leaf"; leaf: LeafPart }

export type FieldType = "localized" | "scalar" | "path" | "enum"

export interface FieldSpec {
  name: string
  type: FieldType
  required: boolean
  /** enum fields only. */
  options?: readonly string[]
}

/** Every Tier-1 block kind and its fields, mirroring `core/panels.py`'s own table.
 * Order is render order in the form. */
export const BLOCK_FIELDS: Record<string, readonly FieldSpec[]> = {
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

export interface BlockDraft {
  /** Stable across edits so React keys and reorders do not fight the array index. */
  uid: string
  kind: string
  /** Field name → value. A localized field holds text OR a binding; the rest a `Scalar`. */
  fields: Record<string, LocalizedField>
  /** A `core.condexpr` condition the CLIENT evaluates; empty means always shown. */
  visibleWhen: string
  /** `{repeat: {prefix, block}}` — one instance per visible variable with this
   * prefix. Empty means the block renders once. Repeat does not nest. */
  repeatPrefix: string
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

export function isLocalizedField(kind: string, field: string): boolean {
  return BLOCK_FIELDS[kind]?.find((spec) => spec.name === field)?.type === "localized"
}

export function newBlock(kind: string): BlockDraft {
  const fields: Record<string, LocalizedField> = {}
  for (const spec of BLOCK_FIELDS[kind] ?? []) {
    fields[spec.name] = spec.type === "localized" ? emptyLocalized() : literal()
  }
  return { uid: nextUid(), kind, fields, visibleWhen: "", repeatPrefix: "" }
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

function readBlock(raw: unknown): BlockDraft | null {
  if (!raw || typeof raw !== "object") return null
  const map = raw as Record<string, unknown>
  // `{repeat: {prefix, block}}` unwraps into the block plus its prefix; the editor
  // shows it as one block with "repeat over" filled in, since repeat cannot nest.
  if (map.repeat && typeof map.repeat === "object") {
    const repeat = map.repeat as Record<string, unknown>
    const inner = readBlock(repeat.block)
    if (inner === null) return null
    return { ...inner, repeatPrefix: typeof repeat.prefix === "string" ? repeat.prefix : "" }
  }
  const kind = typeof map.kind === "string" ? map.kind : ""
  if (!(kind in BLOCK_FIELDS)) return null
  const block = newBlock(kind)
  for (const spec of BLOCK_FIELDS[kind]) {
    if (!(spec.name in map)) continue
    block.fields[spec.name] =
      spec.type === "localized" ? readLocalized(map[spec.name]) : readScalar(map[spec.name])
  }
  if (typeof map.visible_when === "string") block.visibleWhen = map.visible_when
  return block
}

export interface ParseResult {
  document: PanelsDocument
  /** A YAML or shape error the editor cannot recover from; the document is empty. */
  error: string | null
  /** Blocks that were dropped because this editor does not model them. */
  dropped: number
}

export function parsePanelsYaml(text: string): ParseResult {
  const empty: PanelsDocument = { panels: [], opaque: [] }
  if (!text.trim()) return { document: empty, error: null, dropped: 0 }
  try {
    return documentFromRaw(parseYaml(text))
  } catch (error) {
    return { document: empty, error: String(error), dropped: 0 }
  }
}

/** The same reader over an already-parsed value — YAML from a file, JSON from a
 * model. One reader, so a drafted panel and a hand-written one are read alike. */
export function documentFromRaw(raw: unknown): ParseResult {
  const empty: PanelsDocument = { panels: [], opaque: [] }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).panels)) {
    return { document: empty, error: "panels.yaml root must be a mapping with a `panels` list", dropped: 0 }
  }
  const panels: PanelDraft[] = []
  const opaque: OpaquePanel[] = []
  let dropped = 0
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
      if (block === null) dropped += 1
      else blocks.push(block)
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
  return { document: { panels, opaque }, error: null, dropped }
}

// --- writing ---------------------------------------------------------------

function writeLocalized(value: LocalizedField): unknown {
  if (!isLocalized(value)) return writeScalar(value)
  // An en-only label is written as the plain string the schema accepts; the pack
  // lint is what nags about a missing translation, not the serializer.
  return value.zh.trim() ? { en: value.en, zh: value.zh } : value.en
}

function writeScalar(value: Scalar): unknown {
  if (value.mode === "var") return { $var: value.path }
  if (value.mode === "leaf") return { $leaf: value.leaf }
  const text = value.text.trim()
  if (text === "") return ""
  const numeric = Number(text)
  return Number.isFinite(numeric) && String(numeric) === text ? numeric : text
}

function writeBlock(block: BlockDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: block.kind }
  for (const spec of BLOCK_FIELDS[block.kind] ?? []) {
    const value = block.fields[spec.name]
    if (value === undefined) continue
    if (spec.type === "localized") {
      if (!spec.required && isLocalized(value) && !value.en.trim() && !value.zh.trim()) continue
      out[spec.name] = writeLocalized(value)
    } else {
      const scalar = value as Scalar
      if (!spec.required && scalar.mode === "literal" && !scalar.text.trim()) continue
      out[spec.name] = writeScalar(scalar)
    }
  }
  if (block.visibleWhen.trim()) out.visible_when = block.visibleWhen.trim()
  if (block.repeatPrefix.trim()) {
    const { visible_when: condition, ...rest } = out
    const inner: Record<string, unknown> =
      condition === undefined ? rest : { ...rest, visible_when: condition }
    return { repeat: { prefix: block.repeatPrefix.trim(), block: inner } }
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
  for (const panel of document.panels) {
    const where = panel.id || "(unnamed)"
    if (!SLUG_RE.test(panel.id)) problems.push({ key: "badId", params: { panel: where } })
    else if (seen.has(panel.id)) problems.push({ key: "duplicateId", params: { panel: panel.id } })
    seen.add(panel.id)
    if (!panel.title.en.trim() && !panel.title.zh.trim())
      problems.push({ key: "noTitle", params: { panel: where } })
    if (panel.blocks.length === 0) problems.push({ key: "noBlocks", params: { panel: where } })

    for (const [index, block] of panel.blocks.entries()) {
      const at = `${where} #${index + 1}`
      for (const spec of BLOCK_FIELDS[block.kind] ?? []) {
        const value = block.fields[spec.name]
        const scalarBlank = (scalar: Scalar): boolean => {
          if (scalar.mode === "var") return !scalar.path.trim()
          if (scalar.mode === "leaf") return false
          return !scalar.text.trim()
        }
        const blank =
          value === undefined ||
          (isLocalized(value) ? !value.en.trim() && !value.zh.trim() : scalarBlank(value))
        if (spec.required && blank) {
          problems.push({ key: "missingField", params: { at, field: spec.name } })
          continue
        }
        if (value !== undefined && !isLocalized(value)) {
          const scalar = value
          // A binding that resolves to nothing DROPS the whole block at render time,
          // so an undeclared path is a silent blank panel, not a visible error.
          if (scalar.mode === "var" && scalar.path.trim() && declaredVars.size > 0) {
            const root = scalar.path.split(".")[0]
            if (!declaredVars.has(scalar.path) && !declaredVars.has(root))
              problems.push({ key: "unknownVar", params: { at, path: scalar.path } })
          }
        }
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
