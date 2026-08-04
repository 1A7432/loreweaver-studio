// MVU (MagVarUpdate) InitVar compatibility — a TypeScript mirror of the
// detection + tolerant parsing in the engine's `core/mvu_compat.py` (the original
// JSON5-lite object shape first, then the 2026-era YAML block-mapping shape),
// plus a description-preserving leaf flattener (the engine's `flatten_leaves`
// drops descriptions; the promotion table needs them for label inference).

import { parseDocument, visit } from "yaml"

export const MAX_FLAT_LEAVES = 200

/** Case-insensitive substring test, exactly as upstream MVU cards are named. */
export function isInitvarEntry(name: unknown): boolean {
  return typeof name === "string" && name.toLowerCase().includes("initvar")
}

/** ValueWithDescription form: `[value, "description"]`. Mirrors upstream's
 * (deliberately ambiguous) heuristic. */
export function isValueWithDesc(node: unknown): node is [unknown, string] {
  return Array.isArray(node) && node.length === 2 && typeof node[1] === "string"
}

export function leafValue(node: unknown): unknown {
  return isValueWithDesc(node) ? node[0] : node
}

/** One string-aware pass: strip line and block comments outside strings and
 * re-emit single-quoted strings as double-quoted JSON strings. Null on an
 * unterminated construct (fail closed, like the engine). */
function stripCommentsNormalizeQuotes(text: string): string | null {
  const out: string[] = []
  let i = 0
  const length = text.length
  while (i < length) {
    const ch = text[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      i += 1
      const buf: string[] = []
      let closed = false
      while (i < length) {
        const current = text[i]
        if (current === "\\") {
          if (i + 1 >= length) return null
          const escaped = text[i + 1]
          if (quote === "'" && escaped === "'") {
            buf.push("'") // \' is not a legal JSON escape — unwrap it
          } else {
            buf.push("\\" + escaped)
          }
          i += 2
          continue
        }
        if (current === quote) {
          closed = true
          i += 1
          break
        }
        if (current === '"' && quote === "'") {
          buf.push('\\"')
        } else {
          buf.push(current)
        }
        i += 1
      }
      if (!closed) return null
      out.push('"' + buf.join("") + '"')
      continue
    }
    if (ch === "/" && i + 1 < length && text[i + 1] === "/") {
      while (i < length && text[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && i + 1 < length && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      if (end === -1) return null
      i = end + 2
      continue
    }
    out.push(ch)
    i += 1
  }
  return out.join("")
}

/** Remove commas directly preceding a closing `}`/`]` (string-aware). */
function dropTrailingCommas(text: string): string {
  const out: string[] = []
  let i = 0
  const length = text.length
  let inString = false
  while (i < length) {
    const ch = text[i]
    if (inString) {
      out.push(ch)
      if (ch === "\\" && i + 1 < length) {
        out.push(text[i + 1])
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out.push(ch)
      i += 1
      continue
    }
    if (ch === ",") {
      let probe = i + 1
      while (probe < length && " \t\r\n".includes(text[probe])) probe += 1
      if (probe < length && "}]".includes(text[probe])) {
        i += 1
        continue
      }
    }
    out.push(ch)
    i += 1
  }
  return out.join("")
}

const BARE_KEY_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y

/** Quote unquoted ASCII identifier keys (identifier followed by `:`). */
function quoteBareKeys(text: string): string {
  const out: string[] = []
  let i = 0
  const length = text.length
  let inString = false
  while (i < length) {
    const ch = text[i]
    if (inString) {
      out.push(ch)
      if (ch === "\\" && i + 1 < length) {
        out.push(text[i + 1])
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out.push(ch)
      i += 1
      continue
    }
    BARE_KEY_RE.lastIndex = i
    const match = BARE_KEY_RE.exec(text)
    if (match !== null) {
      let probe = i + match[0].length
      while (probe < length && " \t\r\n".includes(text[probe])) probe += 1
      if (probe < length && text[probe] === ":") {
        out.push(`"${match[0]}"`)
      } else {
        out.push(match[0])
      }
      i += match[0].length
      continue
    }
    out.push(ch)
    i += 1
  }
  return out.join("")
}

/** Parse an InitVar entry's content into an object; null when unrecoverable or the
 * top level isn't an object. Real cards ship two wire shapes, tried in order: the
 * original JSON5-lite object, then the 2026-era YAML block mapping of the same tree.
 * CJK passes through. */
export function parseInitvar(text: string): Record<string, unknown> | null {
  if (typeof text !== "string" || !text.trim()) return null
  const stripped = stripCommentsNormalizeQuotes(text)
  if (stripped !== null) {
    const normalized = quoteBareKeys(dropTrailingCommas(stripped))
    try {
      const data: unknown = JSON.parse(normalized)
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        return data as Record<string, unknown>
      }
    } catch {
      // fall through to the YAML route
    }
  }
  return parseInitvarYaml(text)
}

/** The YAML route of `parseInitvar`. The `yaml-1.1` schema pins engine parity with
 * PyYAML: `yes`/`no` load as booleans, duplicate keys last-win (`uniqueKeys: false`).
 * Imported cards are untrusted input, so anchor/alias documents are rejected outright
 * (never expanded), mirroring the engine's no-alias loader; auto-typed timestamps are
 * re-coerced to ISO strings (date-only stays `YYYY-MM-DD`, matching PyYAML's date). */
function parseInitvarYaml(text: string): Record<string, unknown> | null {
  let data: unknown
  try {
    const doc = parseDocument(text, { schema: "yaml-1.1", uniqueKeys: false })
    if (doc.errors.length > 0) return null
    let hasAlias = false
    visit(doc, {
      Alias: () => {
        hasAlias = true
        return visit.BREAK
      },
    })
    if (hasAlias) return null
    data = doc.toJS()
  } catch {
    return null
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  return stringifyYamlDates(data) as Record<string, unknown>
}

/** Recursively replace auto-typed `Date` leaves with ISO strings; every other node
 * passes through untouched. A date-only stamp (UTC midnight) shortens to `YYYY-MM-DD`. */
function stringifyYamlDates(node: unknown): unknown {
  if (node instanceof Date) {
    const iso = node.toISOString()
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso
  }
  if (Array.isArray(node)) return node.map(stringifyYamlDates)
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, stringifyYamlDates(value)]))
  }
  return node
}

/** One flattened leaf; `description` is "" unless the leaf used the
 * ValueWithDescription form. */
export interface MvuLeaf {
  path: string
  value: unknown
  description: string
}

export interface FlattenResult {
  leaves: MvuLeaf[]
  /** Whether the `limit` cut traversal short (surfaced in the UI — no silent caps). */
  truncated: boolean
}

function isScalar(node: unknown): boolean {
  return node === null || typeof node === "string" || typeof node === "number" || typeof node === "boolean"
}

function flattenInto(node: unknown, prefix: string, leaves: MvuLeaf[], limit: number): void {
  if (leaves.length >= limit) return
  if (isValueWithDesc(node)) {
    leaves.push({ path: prefix, value: node[0], description: node[1] })
    return
  }
  if (Array.isArray(node)) {
    if (node.every(isScalar)) {
      leaves.push({ path: prefix, value: [...node], description: "" })
      return
    }
    for (let index = 0; index < node.length; index++) {
      if (leaves.length >= limit) return
      flattenInto(node[index], prefix ? `${prefix}.${index}` : String(index), leaves, limit)
    }
    return
  }
  if (typeof node === "object" && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      if (leaves.length >= limit) return
      flattenInto(child, prefix ? `${prefix}.${key}` : key, leaves, limit)
    }
    return
  }
  leaves.push({ path: prefix, value: node, description: "" })
}

/** Depth-first, insertion-ordered flatten — the engine's traversal, keeping
 * ValueWithDescription descriptions alongside their values. */
export function flattenLeaves(tree: Record<string, unknown>, limit = MAX_FLAT_LEAVES): FlattenResult {
  const leaves: MvuLeaf[] = []
  if (limit > 0) flattenInto(tree, "", leaves, limit)
  // Detect truncation by probing whether a second pass with a higher cap finds more.
  if (leaves.length >= limit) {
    const probe: MvuLeaf[] = []
    flattenInto(tree, "", probe, limit + 1)
    return { leaves, truncated: probe.length > limit }
  }
  return { leaves, truncated: false }
}
