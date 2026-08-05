// The deterministic gate on AI output (the engine's iron rule #1, applied to
// the forge): the model DRAFTS, code DECIDES. Every AI draft is parsed,
// coerced field-by-field, and pushed through the exact same `validateProject`
// the hand-authored editor uses — a draft that fails never reaches a project;
// the failure list goes back to the model for a retry instead.

import { asText, isRecord, listOfStrings } from "../coerce"
import {
  newLoreEntry,
  newProject,
  newVariable,
  validateProject,
  type ForgeLoreEntry,
  type ForgeProject,
  type ForgeVariable,
  type Issue,
  type SelectiveLogic,
  type VarKind,
  type VarVisibility,
} from "../model"
import { PACK_ID_RE, SEMVER_RE } from "../split/packSource"

const VAR_KINDS: VarKind[] = ["number", "bool", "text", "enum"]
const VISIBILITIES: VarVisibility[] = ["player", "keeper"]
const LOGICS: SelectiveLogic[] = ["and_any", "and_all", "not_any", "not_all"]

/** Pull the first JSON object out of a model reply: a ```json fence if
 * present, else the first balanced top-level {...} block. */
export function extractJsonBlock(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates: string[] = []
  if (fenced !== null) candidates.push(fenced[1])
  const start = text.indexOf("{")
  if (start !== -1) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (ch === "\\") i += 1
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth += 1
      else if (ch === "}") {
        depth -= 1
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // try the next shape
    }
  }
  return null
}

function numberish(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return asText(value)
}

function draftVariable(raw: unknown, index: number, problems: string[]): ForgeVariable {
  const variable = newVariable()
  if (!isRecord(raw)) {
    problems.push(`variables[${index}]: must be an object`)
    return variable
  }
  variable.id = asText(raw.id)
  const kind = asText(raw.kind)
  if ((VAR_KINDS as string[]).includes(kind)) variable.kind = kind as VarKind
  else problems.push(`variables[${index}].kind: "${kind}" is not one of ${VAR_KINDS.join("/")}`)
  const visibility = asText(raw.visibility) || "player"
  if ((VISIBILITIES as string[]).includes(visibility)) variable.visibility = visibility as VarVisibility
  else problems.push(`variables[${index}].visibility: "${visibility}" is not player/keeper`)

  const labels = isRecord(raw.labels) ? raw.labels : {}
  variable.labelEn = asText(raw.label_en) || asText(labels.en)
  variable.labelZh = asText(raw.label_zh) || asText(labels.zh)
  variable.minimum = numberish(raw.minimum)
  variable.maximum = numberish(raw.maximum)
  variable.defaultValue = numberish(raw.default)
  variable.options = listOfStrings(raw.options).join("\n")
  return variable
}

function draftLoreEntry(raw: unknown, index: number, problems: string[]): ForgeLoreEntry {
  const entry = newLoreEntry()
  if (!isRecord(raw)) {
    problems.push(`worldbook[${index}]: must be an object`)
    return entry
  }
  entry.title = asText(raw.title) || asText(raw.comment)
  entry.content = asText(raw.content)
  entry.keys = listOfStrings(raw.keys).join(", ")
  entry.secondaryKeys = listOfStrings(raw.secondary_keys).join(", ")
  const logic = asText(raw.selective_logic)
  if (logic) {
    if ((LOGICS as string[]).includes(logic)) entry.selectiveLogic = logic as SelectiveLogic
    else problems.push(`worldbook[${index}].selective_logic: "${logic}" is invalid`)
  }
  entry.condition = asText(raw.condition)
  entry.secret = raw.secret === true
  entry.constant = raw.constant === true
  if (typeof raw.priority === "number") entry.priority = Math.trunc(raw.priority)
  if (typeof raw.probability === "number") {
    entry.probability = Math.min(100, Math.max(0, Math.trunc(raw.probability)))
  }
  const position = asText(raw.position)
  if (position === "before" || position === "after") entry.position = position
  return entry
}

export interface DraftResult {
  project: ForgeProject | null
  /** Machine-readable validation issues (for the UI). */
  issues: Issue[]
  /** Plain-English problems (fed back to the model for a retry). */
  problems: string[]
}

/** English retry text for the model — NOT localized on purpose. */
function issueText(scope: string, issue: Issue): string {
  const params = issue.params ? ` ${JSON.stringify(issue.params)}` : ""
  return `${scope}: ${issue.key}${params}`
}

/** Coerce + validate one AI card draft into a ForgeProject. */
export function draftToProject(raw: unknown): DraftResult {
  if (!isRecord(raw)) {
    return { project: null, issues: [], problems: ["reply must be a single JSON object"] }
  }
  const problems: string[] = []
  const project = newProject(asText(raw.name))
  project.description = asText(raw.description)
  project.personality = asText(raw.personality)
  project.scenario = asText(raw.scenario)
  project.firstMes = asText(raw.first_mes)
  project.mesExample = asText(raw.mes_example)
  project.creatorNotes = asText(raw.creator_notes)
  project.tags = listOfStrings(raw.tags).join(", ")
  project.hooks = asText(raw.hooks)

  const variables = Array.isArray(raw.variables) ? raw.variables : []
  project.variables = variables.map((entry, index) => draftVariable(entry, index, problems))
  const worldbook = Array.isArray(raw.worldbook) ? raw.worldbook : []
  project.lorebook = worldbook.map((entry, index) => draftLoreEntry(entry, index, problems))

  const validation = validateProject(project)
  const issues: Issue[] = [...validation.project]
  for (const [uid, list] of validation.variables) {
    const position = project.variables.findIndex((variable) => variable.uid === uid)
    for (const issue of list) {
      issues.push(issue)
      problems.push(issueText(`variables[${position}]`, issue))
    }
  }
  for (const [uid, list] of validation.lorebook) {
    const position = project.lorebook.findIndex((entry) => entry.uid === uid)
    for (const issue of list) {
      issues.push(issue)
      problems.push(issueText(`worldbook[${position}]`, issue))
    }
  }
  for (const issue of validation.project) problems.push(issueText("card", issue))

  return problems.length > 0 ? { project: null, issues, problems } : { project, issues: [], problems: [] }
}

export interface PackMetadataDraft {
  id: string
  version: string
  nameEn: string
  nameZh: string
  descriptionEn: string
  descriptionZh: string
  authors: string[]
  license: string
  cardNotesEn: string
  cardNotesZh: string
}

export interface PackMetadataResult {
  metadata: PackMetadataDraft | null
  problems: string[]
}

/** Coerce + validate one AI pack-metadata draft. The card `kind` is NOT here
 * on purpose: it comes from structural detection, never from the model. */
export function draftToPackMetadata(raw: unknown): PackMetadataResult {
  if (!isRecord(raw)) {
    return { metadata: null, problems: ["reply must be a single JSON object"] }
  }
  const problems: string[] = []
  const name = isRecord(raw.name) ? raw.name : {}
  const description = isRecord(raw.description) ? raw.description : {}
  const cardNotes = isRecord(raw.card_notes) ? raw.card_notes : {}
  const metadata: PackMetadataDraft = {
    id: asText(raw.id),
    version: asText(raw.version) || "0.1.0",
    nameEn: asText(name.en),
    nameZh: asText(name.zh),
    descriptionEn: asText(description.en),
    descriptionZh: asText(description.zh),
    authors: listOfStrings(raw.authors),
    license: asText(raw.license),
    cardNotesEn: asText(cardNotes.en),
    cardNotesZh: asText(cardNotes.zh),
  }
  if (!PACK_ID_RE.test(metadata.id)) {
    problems.push(`id: "${metadata.id}" must match ${PACK_ID_RE.source}`)
  }
  if (!SEMVER_RE.test(metadata.version)) {
    problems.push(`version: "${metadata.version}" must be semver MAJOR.MINOR.PATCH`)
  }
  if (!metadata.nameEn && !metadata.nameZh) problems.push("name: needs en and zh entries")
  if (!metadata.descriptionEn && !metadata.descriptionZh) {
    problems.push("description: needs en and zh entries")
  }
  return problems.length > 0 ? { metadata: null, problems } : { metadata, problems: [] }
}
