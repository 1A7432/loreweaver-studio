// Bridges between the splitter and the rest of the forge:
// - rebuild a CLEAN SillyTavern card from a character half (for direct save);
// - turn a character half + confirmed promotions into a ForgeProject (so the
//   split lands in the same editor as hand-made cards).

import { asText, isRecord, type StCharacterCard } from "./charcard"
import { splitDecorators, type SplitCardResult } from "./cardSplit"
import {
  newLoreEntry,
  newProject,
  splitKeys,
  type ForgeLoreEntry,
  type ForgeProject,
  type SelectiveLogic,
} from "../model"
import type { PromotionDraft } from "./promote"

/** Rebuild a full ST card JSON from the (already stripped) character half:
 * the raw card minus hooks, with cleaned prose + the filtered book written
 * back in place. Unknown sibling fields ride along untouched. */
export function characterHalfToStCard(character: StCharacterCard): Record<string, unknown> {
  const raw = character.raw
  const isEnvelope = raw.spec === "chara_card_v2" || raw.spec === "chara_card_v3"
  const body = isEnvelope && isRecord(raw.data) ? raw.data : raw

  const cleanBody: Record<string, unknown> = {
    ...body,
    name: character.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    first_mes: character.firstMes,
    mes_example: character.mesExample,
    creator_notes: character.creatorNotes,
    tags: character.tags,
  }
  const book = isRecord(body.character_book) ? body.character_book : undefined
  if (book !== undefined || character.characterBook.length > 0) {
    cleanBody.character_book = { ...(book ?? {}), entries: character.characterBook }
  }
  if (isEnvelope) return { ...raw, data: cleanBody }
  return cleanBody
}

const SELECTIVE_LOGIC_FROM_INT: Record<number, SelectiveLogic> = {
  0: "and_any",
  1: "not_all",
  2: "not_any",
  3: "and_all",
}

function textList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter((item) => item.length > 0)
  const text = asText(value)
  return text ? splitKeys(text) : []
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback
}

/** Map one imported book entry (V2 `character_book` names or ST-native
 * world-info names) onto the editor's ForgeLoreEntry. `@@if` decorators fold
 * back into the typed `condition` field, as the engine importer does. */
export function stEntryToForgeLore(raw: Record<string, unknown>): ForgeLoreEntry {
  const entry = newLoreEntry()
  const extensions = isRecord(raw.extensions) ? raw.extensions : {}

  entry.title = asText(raw.comment) || asText(raw.title) || asText(raw.name)
  const { decorators, body } = splitDecorators(asText(raw.content))
  entry.content = body
  const condition = decorators.if
  if (typeof condition === "string") entry.condition = condition

  entry.keys = textList(raw.keys ?? raw.key).join(", ")
  entry.secondaryKeys = textList(raw.secondary_keys ?? raw.keysecondary).join(", ")
  const logicRaw = extensions.selectiveLogic ?? raw.selectiveLogic
  if (typeof logicRaw === "number" && logicRaw in SELECTIVE_LOGIC_FROM_INT) {
    entry.selectiveLogic = SELECTIVE_LOGIC_FROM_INT[logicRaw]
  }
  entry.constant = raw.constant === true
  entry.enabled = raw.enabled !== undefined ? raw.enabled !== false : raw.disable !== true
  entry.priority = intOr(raw.insertion_order ?? raw.order, 0)
  entry.probability = intOr(extensions.probability ?? raw.probability, 100)
  entry.caseSensitive = (extensions.case_sensitive ?? raw.case_sensitive ?? raw.caseSensitive) === true
  entry.matchWholeWords =
    (extensions.match_whole_words ?? raw.match_whole_words ?? raw.matchWholeWords) === true
  entry.scanDepth = intOr(extensions.scan_depth ?? raw.scan_depth, 0)
  entry.sticky = intOr(extensions.sticky ?? raw.sticky, 0)
  entry.cooldown = intOr(extensions.cooldown ?? raw.cooldown, 0)
  entry.delay = intOr(extensions.delay ?? raw.delay, 0)
  const position = asText(raw.position)
  if (position === "before_char" || position === "before") entry.position = "before"
  else if (position === "after_char" || position === "after") entry.position = "after"
  return entry
}

/** Character half + confirmed promotions → a ForgeProject in the editor. */
export function splitToProject(
  character: StCharacterCard,
  split: SplitCardResult,
  drafts: PromotionDraft[],
): ForgeProject {
  const project = newProject(character.name || "Imported card")
  project.description = character.description
  project.personality = character.personality
  project.scenario = character.scenario
  project.firstMes = character.firstMes
  project.mesExample = character.mesExample
  project.creatorNotes = character.creatorNotes
  project.tags = character.tags.join(", ")
  project.lorebook = character.characterBook.map(stEntryToForgeLore)
  project.variables = drafts.filter((draft) => draft.include).map((draft) => draft.variable)
  project.hooks = split.hooks.join("\n\n")
  return project
}
