// AI batch-fill for the promotion table: ids + bilingual labels. Same iron
// rule as everywhere else — the model proposes, deterministic checks accept
// per-entry (a bad entry is dropped, the draft keeps its previous values).

import { MAX_LABEL_LEN, VAR_ID_RE } from "../model"
import { asText, isRecord } from "../split/charcard"
import type { PromotionDraft } from "../split/promote"
import { draftWithRetries } from "./provider"
import { VARIABLE_LABELS_SYSTEM } from "./prompts"

interface LabelEntry {
  index: number
  id: string
  labelEn: string
  labelZh: string
}

function gateLabels(parsed: unknown, count: number): { value: LabelEntry[] | null; problems: string[] } {
  if (!isRecord(parsed) || !Array.isArray(parsed.labels)) {
    return { value: null, problems: ['reply must be {"labels": [...]}'] }
  }
  const problems: string[] = []
  const seen = new Set<string>()
  const entries: LabelEntry[] = []
  for (const raw of parsed.labels) {
    if (!isRecord(raw)) continue
    const index = typeof raw.index === "number" ? raw.index : -1
    if (index < 0 || index >= count) {
      problems.push(`labels: index ${String(raw.index)} is out of range`)
      continue
    }
    const id = asText(raw.id)
    if (!VAR_ID_RE.test(id)) {
      problems.push(`labels[${index}].id: "${id}" must match [a-z0-9_]{1,64}`)
      continue
    }
    if (seen.has(id)) {
      problems.push(`labels[${index}].id: "${id}" duplicates another entry`)
      continue
    }
    seen.add(id)
    entries.push({
      index,
      id,
      labelEn: asText(raw.label_en).slice(0, MAX_LABEL_LEN),
      labelZh: asText(raw.label_zh).slice(0, MAX_LABEL_LEN),
    })
  }
  if (entries.length === 0) return { value: null, problems }
  return { value: entries, problems }
}

/** Returns updated drafts (same array shape); throws only on transport errors. */
export async function aiFillLabels(drafts: PromotionDraft[]): Promise<PromotionDraft[]> {
  if (drafts.length === 0) return drafts
  const payload = drafts.map((draft, index) => ({
    index,
    path: draft.mvuPath,
    description: draft.description,
    current_id: draft.variable.id,
  }))
  const result = await draftWithRetries(
    VARIABLE_LABELS_SYSTEM,
    [{ role: "user", content: JSON.stringify(payload) }],
    (parsed) => gateLabels(parsed, drafts.length),
    2,
  )
  if (result.value === null) return drafts
  const next = drafts.map((draft) => ({ ...draft, variable: { ...draft.variable } }))
  for (const entry of result.value) {
    const target = next[entry.index]
    target.variable.id = entry.id
    if (entry.labelEn) target.variable.labelEn = entry.labelEn
    if (entry.labelZh) target.variable.labelZh = entry.labelZh
  }
  return next
}
