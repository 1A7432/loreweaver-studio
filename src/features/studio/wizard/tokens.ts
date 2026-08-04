// Token economics for the wizard — the blue-light/green-light budget. Worldbook
// entries split into two layers: constant entries ride in EVERY prompt (the
// blue, always-on cost), keyword-triggered entries only pay when they fire (the
// green layer). The estimate is deliberately rough (≈1 token per CJK char, ≈4
// ASCII chars per token) — it exists to rank entries and warn about budget, not
// to bill anyone.

import type { ForgeLoreEntry } from "../model"
import type { StageDraft } from "./stages"

// CJK ideographs + kana + full-width forms and CJK punctuation.
const CJK_CHAR_RE = /[぀-ヿ㐀-鿿豈-﫿！-～。-〿]/

/** Rough token estimate: CJK chars count 1 each, everything else ~4 chars per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_CHAR_RE.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** Default always-on budget for constant lore (tokens). Advisory, never a hard cap. */
export const DEFAULT_CONSTANT_BUDGET = 1600

export interface LayerRow {
  uid: string
  title: string
  constant: boolean
  tokens: number
}

export interface LayerReport {
  constantTokens: number
  triggeredTokens: number
  rows: LayerRow[]
}

/** Split enabled entries into the always-on vs. triggered layer and cost each. */
export function layerReport(entries: ForgeLoreEntry[]): LayerReport {
  const rows: LayerRow[] = []
  let constantTokens = 0
  let triggeredTokens = 0
  for (const entry of entries) {
    if (!entry.enabled) continue
    const tokens = estimateTokens(entry.content)
    rows.push({ uid: entry.uid, title: entry.title, constant: entry.constant, tokens })
    if (entry.constant) constantTokens += tokens
    else triggeredTokens += tokens
  }
  return { constantTokens, triggeredTokens, rows }
}

/** The always-on tokens this stage draft would land (constant lore it emits). */
export function draftConstantTokens(draft: StageDraft): number {
  switch (draft.stage) {
    case "worldview":
    case "wardrobe":
      return draft.entries
        .filter((entry) => entry.layer === "constant")
        .reduce((sum, entry) => sum + estimateTokens(entry.content), 0)
    case "facets":
      return draft.facets.reduce(
        (sum, facet) =>
          sum +
          estimateTokens(
            [facet.trigger, facet.energy, facet.voice, facet.body, facet.role, facet.bleed].join("\n"),
          ),
        0,
      )
    case "exegesis":
      return estimateTokens(draft.text)
    case "nsfw":
      return (
        estimateTokens(draft.motivation) +
        draft.entries
          .filter((entry) => entry.layer === "constant")
          .reduce((sum, entry) => sum + estimateTokens(entry.content), 0)
      )
    case "overview":
      return estimateTokens(draft.content)
    default:
      return 0
  }
}

/** When the constant layer is over budget: the demotion candidates (largest
 * first) that would bring it back under, with the projected total after each. */
export function demoteAdvice(
  report: LayerReport,
  budget = DEFAULT_CONSTANT_BUDGET,
): { uid: string; title: string; tokens: number; afterTokens: number }[] {
  if (report.constantTokens <= budget) return []
  const candidates = report.rows
    .filter((row) => row.constant && row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  const advice: { uid: string; title: string; tokens: number; afterTokens: number }[] = []
  let running = report.constantTokens
  for (const row of candidates) {
    if (running <= budget) break
    running -= row.tokens
    advice.push({ uid: row.uid, title: row.title, tokens: row.tokens, afterTokens: running })
  }
  return advice
}
