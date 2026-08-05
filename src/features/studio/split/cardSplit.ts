// Card splitting (拆卡) — a TypeScript mirror of the engine's
// `core/card_split.py`: the same detection (hooks extension, variable-
// declaration entries, EJS spans) and the same character-half stripping, so
// the studio's preview agrees with what `.import` will do server-side. One
// deliberate superset: the engine returns world payloads as COUNTS (the keeper
// re-imports the original card); the studio also carries the payload bodies
// out, because its job is to *show* the world half, not just count it.

import { asText, isRecord, type StCharacterCard } from "./charcard"
import { isInitvarEntry } from "./mvu"

export const HOOKS_EXTENSION_KEY = "loreweaver_hooks"

const EJS_SPAN_RE = /<%[\s\S]*?%>/g
const EJS_DANGLING_RE = /<%[\s\S]*$/
const AT_DECORATOR_RE = /^@@([A-Za-z_]+)(?:\s+(.*))?$/

export interface WorldPayloads {
  hooks: number
  initvarEntries: number
  ejsBlocks: number
  /** Keeper-only (`secret: true`) entries — a native bundle (M14) can carry
   * them; stock ST cards never do. Keeper-only lore IS world machinery
   * (mirrors the engine's `WorldPayloads.secret_entries`). */
  secretEntries: number
}

export function payloadsAny(payloads: WorldPayloads): boolean {
  return (
    payloads.hooks > 0 || payloads.initvarEntries > 0 || payloads.ejsBlocks > 0 || payloads.secretEntries > 0
  )
}

/** Split leading ST-Prompt-Template `@@decorator` lines off `text`. Flags map
 * to true; `@@if` maps its expression string. Mirrors `ejs_lite.split_decorators`. */
export function splitDecorators(text: string): { decorators: Record<string, string | true>; body: string } {
  const decorators: Record<string, string | true> = {}
  const lines = text.split("\n")
  let index = 0
  while (index < lines.length) {
    const line = lines[index].trim()
    if (!line && Object.keys(decorators).length > 0) {
      index += 1
      continue
    }
    const match = AT_DECORATOR_RE.exec(line)
    if (match === null) break
    const name = match[1].toLowerCase()
    const arg = (match[2] ?? "").trim()
    decorators[name] = name === "if" && arg ? arg : true
    index += 1
  }
  if (Object.keys(decorators).length === 0) return { decorators: {}, body: text }
  return { decorators, body: lines.slice(index).join("\n") }
}

/** Remove every EJS span; a dangling unclosed `<%` strips to end-of-text
 * (counted once) — no template fragment may survive into rendered prose. */
export function stripEjs(text: string): { clean: string; removed: number } {
  if (!text.includes("<%")) return { clean: text, removed: 0 }
  let removed = 0
  let clean = text.replace(EJS_SPAN_RE, () => {
    removed += 1
    return ""
  })
  if (clean.includes("<%")) {
    clean = clean.replace(EJS_DANGLING_RE, "")
    removed += 1
  }
  return { clean, removed }
}

/** Whether one worldbook entry declares variables rather than telling lore:
 * an MVU `[InitVar]` title, an ST `[InitialVariables]` title, or an
 * `@@initial_variables` decorator. The single definition shared with the engine. */
export function isVariableDeclarationEntry(raw: Record<string, unknown>): boolean {
  const title = asText(raw.title) || asText(raw.comment) || asText(raw.name)
  const { decorators } = splitDecorators(asText(raw.content))
  return (
    isInitvarEntry(title) ||
    title.replace(/ /g, "").toLowerCase().includes("[initialvariables]") ||
    "initial_variables" in decorators
  )
}

/** The card's `extensions.loreweaver_hooks` scripts — v2/v3 `data.extensions`
 * first, then a root-level `extensions`; string entries or `{code}` dicts. */
export function cardHookCodes(raw: Record<string, unknown>): string[] {
  const data = raw.data
  let extensions = isRecord(data) ? data.extensions : undefined
  if (!isRecord(extensions)) {
    extensions = isRecord(raw.extensions) ? raw.extensions : {}
  }
  const entries = (extensions as Record<string, unknown>)[HOOKS_EXTENSION_KEY]
  if (!Array.isArray(entries)) return []
  const codes: string[] = []
  for (const entry of entries) {
    const code = typeof entry === "string" ? entry : isRecord(entry) ? entry.code : undefined
    if (typeof code === "string" && code.trim()) codes.push(code)
  }
  return codes
}

/** A per-level shallow copy of `raw` with `extensions.loreweaver_hooks`
 * dropped from both the v2/v3 `data.extensions` and root `extensions` spots. */
function rawWithoutHooks(raw: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = { ...raw }
  for (const holderKey of ["data", null] as const) {
    const holder = holderKey === null ? clean : clean[holderKey]
    if (!isRecord(holder)) continue
    const extensions = holder.extensions
    if (isRecord(extensions) && HOOKS_EXTENSION_KEY in extensions) {
      const cleanedExtensions = Object.fromEntries(
        Object.entries(extensions).filter(([key]) => key !== HOOKS_EXTENSION_KEY),
      )
      const cleanedHolder = { ...holder, extensions: cleanedExtensions }
      if (holderKey === null) {
        Object.assign(clean, cleanedHolder)
      } else {
        clean[holderKey] = cleanedHolder
      }
    }
  }
  return clean
}

export interface SplitCardResult {
  /** The character half: prose EJS-stripped, variable-declaration entries
   * removed, hooks extension dropped. Safe for any player to self-import. */
  character: StCharacterCard
  payloads: WorldPayloads
  /** World-half bodies (the studio superset): hook sources and the raw
   * variable-declaration entries, for display and promotion. */
  hooks: string[]
  initvarEntries: Record<string, unknown>[]
}

/** Split a parsed card into its character half + world payloads. The input is
 * never mutated. Detection and stripping are pure code, no model involvement. */
export function splitCard(card: StCharacterCard): SplitCardResult {
  let ejsBlocks = 0
  const clean = (text: string): string => {
    const { clean: cleaned, removed } = stripEjs(text)
    ejsBlocks += removed
    return cleaned
  }

  const entries: Record<string, unknown>[] = []
  const initvarEntries: Record<string, unknown>[] = []
  let secretEntries = 0
  for (const rawEntry of card.characterBook) {
    if (isVariableDeclarationEntry(rawEntry)) {
      initvarEntries.push(rawEntry)
      continue
    }
    // Keeper-only lore never rides the character half (a native bundle can
    // flag it; the engine's worldbook import chokepoint additionally drops it
    // fail-closed on any non-keeper path — two layers, same rule).
    if (rawEntry.secret === true) {
      secretEntries += 1
      continue
    }
    const entry: Record<string, unknown> = { ...rawEntry }
    if (typeof entry.content === "string") entry.content = clean(entry.content)
    entries.push(entry)
  }

  const hooks = cardHookCodes(card.raw)
  const character: StCharacterCard = {
    ...card,
    description: clean(card.description),
    personality: clean(card.personality),
    scenario: clean(card.scenario),
    firstMes: clean(card.firstMes),
    mesExample: clean(card.mesExample),
    creatorNotes: clean(card.creatorNotes),
    characterBook: entries,
    raw: hooks.length > 0 ? rawWithoutHooks(card.raw) : card.raw,
  }
  return {
    character,
    payloads: { hooks: hooks.length, initvarEntries: initvarEntries.length, ejsBlocks, secretEntries },
    hooks,
    initvarEntries,
  }
}
