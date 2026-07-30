// MVU tree → typed module variables (the "compat content becomes first-class"
// step). Every InitVar leaf becomes a DRAFT `ForgeVariable` — kind, bounds,
// bilingual labels and visibility are inferred by deterministic heuristics —
// and the author confirms or edits each row. Nothing here is authoritative:
// the drafts flow through the same `model.buildSpec` validation as hand-typed
// variables before they can be exported.

import { MAX_LABEL_LEN, MAX_TEXT_LEN, VAR_ID_RE, uid, type ForgeVariable } from "../model"
import type { MvuLeaf } from "./mvu"

/** Why a draft looks the way it does — i18n keys under `studio.split.note.*`. */
export type PromotionNote =
  "floatRounded" | "idGenerated" | "listKept" | "containerKept" | "nullKept" | "enumGuessed" | "boundsGuessed"

export interface PromotionDraft {
  uid: string
  /** Whether this leaf gets promoted to a typed variable (rows the heuristics
   * can't type default to false and stay in the MVU tree untouched). */
  include: boolean
  /** The original dotted MVU path (CJK-friendly), e.g. `理.情绪状态.pleasure`. */
  mvuPath: string
  /** The original leaf value, for the "original" column. */
  rawValue: unknown
  /** The original ValueWithDescription description, for the same column. */
  description: string
  /** The editable typed-variable draft (same shape the Variables tab edits). */
  variable: ForgeVariable
  notes: PromotionNote[]
}

// Kana + CJK ideographs (the key scripts seen in real MVU paths).
const CJK_RE = /[぀-ヿ㐀-鿿]/

function hasCjk(text: string): boolean {
  return CJK_RE.test(text)
}

/** ASCII-slug a dotted (often CJK) path into a legal variable id; "" when
 * nothing survives (the caller then assigns a placeholder). */
function asciiIdFromPath(path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[\s.-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
  return VAR_ID_RE.test(slug) ? slug : ""
}

/** Bound patterns seen in real MVU descriptions: `[-1,1]`, `0..100`,
 * `range 0-10`, `范围 0-100`. Bounds are advisory drafts — round to ints. */
function inferBounds(description: string): { minimum: number; maximum: number } | null {
  const patterns = [
    /\[\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*\]/,
    /(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)/,
    /range\s+(-?\d+(?:\.\d+)?)\s*(?:to|[-~])\s*(-?\d+(?:\.\d+)?)/i,
    /范围\s*(-?\d+(?:\.\d+)?)\s*[-~到至]\s*(-?\d+(?:\.\d+)?)/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(description)
    if (match === null) continue
    const lo = Math.round(Number(match[1]))
    const hi = Math.round(Number(match[2]))
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) return { minimum: lo, maximum: hi }
  }
  return null
}

/** Enum candidates from a description: an explicit `one of:` list, or a
 * `a | b | c` run. The value must be among them for the guess to hold. */
function inferEnumOptions(description: string, value: string): string[] | null {
  let candidateText: string | null = null
  const oneOf = /(?:one of|可选值?|选项)\s*[:：]\s*(.+)/i.exec(description)
  if (oneOf !== null) {
    candidateText = oneOf[1]
  } else if ((description.match(/\|/g) ?? []).length >= 2) {
    candidateText = description
  }
  if (candidateText === null) return null
  const options = candidateText
    .split(/[|/、，,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 50)
  if (options.length < 2 || options.length > 20) return null
  const fold = value.toLowerCase()
  return options.some((option) => option.toLowerCase() === fold) ? options : null
}

function guessVisibility(path: string, description: string): "player" | "keeper" {
  return /secret|hidden|隐藏|不可见|内部|internal|伏笔|flag/i.test(path + " " + description)
    ? "keeper"
    : "player"
}

function emptyVariable(id: string, visibility: "player" | "keeper"): ForgeVariable {
  return {
    uid: uid(),
    id,
    kind: "text",
    visibility,
    labelEn: "",
    labelZh: "",
    minimum: "",
    maximum: "",
    defaultValue: "",
    options: "",
  }
}

function draftFromLeaf(leaf: MvuLeaf, id: string, idGenerated: boolean): PromotionDraft {
  const notes: PromotionNote[] = idGenerated ? ["idGenerated"] : []
  const visibility = guessVisibility(leaf.path, leaf.description)
  const variable = emptyVariable(id, visibility)

  const lastSegment = leaf.path.split(".").at(-1) ?? leaf.path
  if (hasCjk(lastSegment)) variable.labelZh = lastSegment.slice(0, MAX_LABEL_LEN)
  else variable.labelEn = lastSegment.replace(/_/g, " ").slice(0, MAX_LABEL_LEN)

  let include = true
  const value = leaf.value

  if (typeof value === "boolean") {
    variable.kind = "bool"
    variable.defaultValue = value ? "true" : "false"
  } else if (typeof value === "number" && Number.isFinite(value)) {
    variable.kind = "number"
    const rounded = Math.round(value)
    if (!Number.isInteger(value)) notes.push("floatRounded")
    const bounds = inferBounds(leaf.description)
    if (bounds !== null) {
      notes.push("boundsGuessed")
      variable.minimum = String(bounds.minimum)
      variable.maximum = String(bounds.maximum)
      variable.defaultValue = String(Math.min(bounds.maximum, Math.max(bounds.minimum, rounded)))
    } else {
      variable.defaultValue = String(rounded)
    }
  } else if (typeof value === "string") {
    const options = inferEnumOptions(leaf.description, value)
    if (options !== null) {
      notes.push("enumGuessed")
      variable.kind = "enum"
      variable.options = options.join("\n")
      variable.defaultValue = value
    } else {
      variable.kind = "text"
      variable.defaultValue = value.slice(0, MAX_TEXT_LEN)
    }
  } else if (value === null || value === undefined) {
    include = false
    notes.push("nullKept")
  } else if (Array.isArray(value)) {
    include = false
    notes.push("listKept")
  } else {
    include = false
    notes.push("containerKept")
  }

  return {
    uid: variable.uid,
    include,
    mvuPath: leaf.path,
    rawValue: value,
    description: leaf.description,
    variable,
    notes,
  }
}

/** Promote flattened leaves into confirmable drafts. Ids are deduplicated
 * deterministically (`_2`, `_3`, …); untypeable leaves come back with
 * `include:false` and stay in the MVU tree. */
export function promoteLeaves(leaves: MvuLeaf[]): PromotionDraft[] {
  const seen = new Set<string>()
  return leaves.map((leaf, index) => {
    const ascii = asciiIdFromPath(leaf.path)
    let id = ascii || `var_${index + 1}`
    if (seen.has(id)) {
      let n = 2
      while (seen.has(`${id.slice(0, 60)}_${n}`)) n += 1
      id = `${id.slice(0, 60)}_${n}`
    }
    seen.add(id)
    return draftFromLeaf(leaf, id, ascii === "")
  })
}

/** Suggested `.var expose <prefix>` list: the top-level segments of every
 * player-guessed path, deduplicated in order. Keeper-guessed subtrees stay
 * hidden until the keeper deliberately exposes them (engine default). */
export function suggestExposePrefixes(drafts: PromotionDraft[]): string[] {
  const prefixes: string[] = []
  for (const draft of drafts) {
    if (draft.variable.visibility !== "player") continue
    const head = draft.mvuPath.split(".")[0]
    if (head && !prefixes.includes(head)) prefixes.push(head)
  }
  return prefixes
}
