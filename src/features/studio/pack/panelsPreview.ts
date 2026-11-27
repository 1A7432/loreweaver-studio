// What a panel shows, before the pack is built: the editor's live preview.
//
// A panel becomes what a viewer's `panels` view would list for it — text in one language,
// each picture by its pack path standing in for the hash a server would give it — exactly
// the step the engine takes (`server/src/core/panels/wire.ts`), and then the protocol
// package's `panelBlocks` evaluates it against sample values of the views it reads. That is
// the SAME evaluation play mode runs on a live panel (`features/play/panels/Tier1Blocks`):
// Studio has no second resolver, so a preview and a table cannot disagree.
//
// The view names a panel may declare, the paths a built-in view's schema declares and the
// command ids a choice may run are offered from here too.

import {
  BUILT_IN_VIEW_SCHEMAS,
  panelBlocks,
  type Block,
  type PanelEntry,
  type TemplateBlock,
} from "loreweaver-protocol"
import FIXTURE from "../../play/fixtures/views.json"
import { PANEL_READABLE_BUILT_INS } from "./panelsCheck"
import { writeBlock, type BlockDraft, type PanelDraft } from "./panelsModel"

/** The media type of a pack picture by its extension (`docs/lwf/formats/pack.md` §6). */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
}

export function imageMime(path: string): string | undefined {
  const extension = /\.([^./]+)$/.exec(path.toLowerCase())?.[1] ?? ""
  return IMAGE_MIME_BY_EXTENSION[extension]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Text for `locale`: its language, then English, then whichever is present (`panelText`). */
function localText(value: Record<string, unknown>, locale: string): string {
  const short = locale.split(/[-_]/u, 1)[0] ?? ""
  if (short === "zh" && typeof value.zh === "string") return value.zh
  if (typeof value.en === "string") return value.en
  return typeof value.zh === "string" ? value.zh : ""
}

function wireValue(value: unknown, locale: string): unknown {
  if (
    isRecord(value) &&
    !Object.hasOwn(value, "$view") &&
    (Object.hasOwn(value, "en") || Object.hasOwn(value, "zh"))
  ) {
    return localText(value, locale)
  }
  return value
}

/** One authored block as the wire carries it: a picture's `src` becomes `{hash, mime, size}`
 * (here the hash IS the pack path, the size 0), localized text one string. */
export function wireBlock(block: unknown, locale: string): TemplateBlock | null {
  if (!isRecord(block)) return null
  if (isRecord(block.repeat)) {
    const spec = block.repeat
    const inner = wireBlock(spec.block, locale)
    if (inner === null) return null
    const repeat: Record<string, unknown> = { each: spec.each, as: spec.as ?? "item", block: inner }
    if (typeof spec.prefix === "string") repeat.prefix = spec.prefix
    return (
      typeof block.visible_when === "string" ? { repeat, visible_when: block.visible_when } : { repeat }
    ) as TemplateBlock
  }
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(block)) {
    if (name === "src") {
      if (typeof value !== "string") return null
      out.hash = value
      const mime = imageMime(value)
      if (mime !== undefined) out.mime = mime
      out.size = 0
    } else if (name === "options" && Array.isArray(value)) {
      out.options = value.map((option: unknown) =>
        isRecord(option) ? { ...option, label: wireValue(option.label, locale) } : option,
      )
    } else {
      out[name] = wireValue(value, locale)
    }
  }
  return out as unknown as TemplateBlock
}

function wireBlocks(blocks: readonly BlockDraft[], locale: string): TemplateBlock[] {
  return blocks
    .map((block) => wireBlock(writeBlock(block), locale))
    .filter((block): block is TemplateBlock => block !== null)
}

/** `panel` as one viewer's `panels` view would list it. */
export function previewEntry(panel: PanelDraft, locale: string, packId = "pack"): PanelEntry {
  const title = localText(
    { ...(panel.title.en ? { en: panel.title.en } : {}), ...(panel.title.zh ? { zh: panel.title.zh } : {}) },
    locale,
  )
  const entry: PanelEntry = {
    id: `${packId}/${panel.id}`,
    title: title || panel.id,
    slot: panel.slot as PanelEntry["slot"],
    kind: panel.kind,
    views: panel.views.map((decl) => ({ as: decl.handle, view: decl.view })),
    source: { kind: "pack", id: packId },
  }
  if (panel.kind === "template") entry.blocks = wireBlocks(panel.blocks, locale)
  else {
    entry.page = { hash: panel.entry, size: 0, mime: "text/html" }
    entry.fallback = panel.fallback === null ? null : wireBlocks(panel.fallback, locale)
  }
  return entry
}

/** What the preview draws: blocks, or null for a page without a fallback. */
export function previewBlocks(
  panel: PanelDraft,
  locale: string,
  values: ReadonlyMap<string, unknown>,
): Block[] | null {
  return panelBlocks(previewEntry(panel, locale), values)
}

// --- views, paths, commands ------------------------------------------------

type Role = "player" | "admin"
const SAMPLES = FIXTURE as unknown as Record<Role, Record<string, unknown>>

/** The built-in views a panel may read (`me`, `party`, … and the `admin/*` views). */
export const BUILT_IN_PANEL_VIEWS: readonly string[] = PANEL_READABLE_BUILT_INS

/** A sample value for a view: a built-in view's value from the engine's own fixture (the
 * admin's for an admin panel), `{}` for a module view or a view the fixture lacks. */
export function sampleViewValue(view: string, role: Role): unknown {
  const held = SAMPLES[role]?.[view] ?? SAMPLES.player?.[view]
  return held === undefined ? {} : held
}

type Schema = Record<string, unknown>

function schemaBranches(schema: Schema): Schema[] {
  const anyOf = schema.anyOf
  if (Array.isArray(anyOf)) return anyOf.filter(isRecord).flatMap(schemaBranches)
  return [schema]
}

function schemaTypes(schema: Schema): string[] {
  const type = schema.type
  return Array.isArray(type)
    ? type.filter((t): t is string => typeof t === "string")
    : typeof type === "string"
      ? [type]
      : []
}

/** The schema at `parts` below `schema` (an index part steps into a list's items). */
function schemaAt(schema: Schema, parts: readonly string[]): Schema | null {
  let current: Schema | null = schema
  for (const part of parts) {
    if (current === null) return null
    let next: Schema | null = null
    for (const branch of schemaBranches(current)) {
      const types = schemaTypes(branch)
      if (types.includes("array") && isRecord(branch.items)) {
        next = branch.items
        break
      }
      if (isRecord(branch.properties) && isRecord(branch.properties[part])) {
        next = branch.properties[part] as Schema
        break
      }
    }
    current = next
  }
  return current
}

export interface SchemaPath {
  path: string
  /** A list: what `repeat.each` takes. */
  list: boolean
}

/** Every path a schema declares below `prefix`: records by property, lists by their first
 * element (`.0`), at most `MAX_BINDING_PATH_DEPTH` parts in all. */
export function schemaPaths(schema: unknown, prefix: string, maxParts = 8): SchemaPath[] {
  const out: SchemaPath[] = []
  const walk = (node: Schema, path: string, depth: number) => {
    for (const branch of schemaBranches(node)) {
      const types = schemaTypes(branch)
      if (types.includes("array")) {
        if (!out.some((entry) => entry.path === path)) out.push({ path, list: true })
        if (depth < maxParts && isRecord(branch.items)) walk(branch.items, `${path}.0`, depth + 1)
        continue
      }
      if (isRecord(branch.properties)) {
        for (const [name, child] of Object.entries(branch.properties)) {
          if (!isRecord(child) || depth >= maxParts) continue
          const childPath = `${path}.${name}`
          // A list is pushed (as one) by the walk below; anything else is pushed here.
          const isList = schemaBranches(child).some((each) => schemaTypes(each).includes("array"))
          if (!isList && !out.some((entry) => entry.path === childPath))
            out.push({ path: childPath, list: false })
          walk(child, childPath, depth + 1)
        }
      }
    }
  }
  if (isRecord(schema)) walk(schema, prefix, 1)
  return out
}

/** The paths a panel's fields may read: every declared view's schema paths under its
 * handle, and inside a repeat the element's paths under its `as`. */
export function bindablePaths(
  views: readonly { handle: string; view: string }[],
  repeat?: { each: string; as: string } | null,
): SchemaPath[] {
  const schemas = BUILT_IN_VIEW_SCHEMAS as Record<string, unknown>
  const out: SchemaPath[] = []
  for (const decl of views) {
    if (!decl.handle) continue
    const schema = schemas[decl.view]
    if (decl.view === "panels" || !isRecord(schema)) {
      out.push({ path: decl.handle, list: false })
      continue
    }
    out.push(...schemaPaths(schema, decl.handle))
  }
  if (repeat && repeat.each && repeat.as) {
    const [handle, ...rest] = repeat.each.split(".")
    const decl = views.find((entry) => entry.handle === handle)
    const schema = decl ? schemas[decl.view] : undefined
    const list = isRecord(schema) ? schemaAt(schema, rest) : null
    const items = list === null ? null : schemaBranches(list).find((branch) => isRecord(branch.items))?.items
    if (isRecord(items)) out.push(...schemaPaths(items, repeat.as, 8 - rest.length))
    else out.push({ path: repeat.as, list: false })
  }
  return out
}

/** The engine's command ids a choice may run, from the engine's own `commands` view fixture
 * (`features/play/fixtures/views.json`), then the pack's modules' `<module>/` prefixes. */
export function commandIds(moduleIds: readonly string[]): string[] {
  const ids: string[] = []
  for (const role of ["player", "admin"] as const) {
    const view = SAMPLES[role]?.commands
    const list = isRecord(view) && Array.isArray(view.commands) ? view.commands : []
    for (const command of list) {
      if (isRecord(command) && typeof command.id === "string" && !ids.includes(command.id))
        ids.push(command.id)
    }
  }
  for (const id of moduleIds) if (id && !ids.includes(`${id}/`)) ids.push(`${id}/`)
  return ids
}

/** The view names a panel may declare: the built-ins, then each module's `<module>/` prefix. */
export function viewNames(moduleIds: readonly string[]): string[] {
  return [...BUILT_IN_PANEL_VIEWS, ...moduleIds.filter(Boolean).map((id) => `${id}/`)]
}
