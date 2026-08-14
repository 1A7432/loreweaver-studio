// Adapters: the two authoring surfaces → the one shape the lint reads.
//
// The forge edits a single card (`ForgeProject`); the pack bench edits a whole
// pack (dropped items + metadata + panels + kit). Both are the same content
// underneath, and the lint should not know which one it is looking at — so the
// mapping lives here and `packLint.ts` stays a pure rule set.

import { normalizeVarId, type ForgeProject } from "../model"
import type { PackMetadataForm, PackItem } from "../../../store/pack"
import type { PackPanelsDraft, PackPresentationDraft, PackSkillDraft } from "../split/packSource"
import { latestOrdinal, type PackEpisode } from "../split/episodes"
import { isRecord, asText } from "../split/charcard"
import type { LintLoreEntry, LintVariable, PackLintSource } from "./model"

function variableFrom(
  id: string,
  labelEn: string,
  labelZh: string,
  visibility: "player" | "keeper",
): LintVariable {
  return { id, labelEn, labelZh, visibility }
}

/** The forge's own project: one card's variables, lorebook and hooks. There is
 * no pack around it yet, so the pack-level rules stay quiet (`meta: null`). */
export function lintSourceFromProject(project: ForgeProject): PackLintSource {
  return {
    meta: null,
    variables: project.variables.map((variable) =>
      variableFrom(normalizeVarId(variable.id), variable.labelEn, variable.labelZh, variable.visibility),
    ),
    lore: project.lorebook.map((entry, index) => ({
      id: entry.uid || `#${index + 1}`,
      title: entry.title,
      content: entry.content,
      episode: entry.episode,
      keys: entry.keys,
      condition: entry.condition,
      constant: entry.constant,
      enabled: entry.enabled,
    })),
    panelsYaml: null,
    code: project.hooks.trim() ? [{ origin: "hooks", source: project.hooks }] : [],
    // The forge edits one card; installments belong to a pack, so the episode
    // rules have nothing to say here.
    episodes: [],
    buildUpTo: 0,
    shippedFiles: [],
    assetRefs: [],
  }
}

/** Lore entries out of a dropped lorebook JSON. Tolerant on purpose: the
 * shapes in the wild are a ST world-info export (`{entries: {…}}` or
 * `{entries: […]}`) and a card's embedded `character_book`. Anything it cannot
 * read contributes no entries rather than a finding — the engine's importer is
 * the authority on what parses. */
export function loreFromJson(jsonText: string, fileName: string): LintLoreEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  let root: unknown = parsed
  if (isRecord(root) && root.entries === undefined) {
    const book = root.character_book ?? (isRecord(root.data) ? root.data.character_book : undefined)
    if (isRecord(book)) root = book
  }
  const raw = isRecord(root) ? root.entries : undefined
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : []
  const entries: LintLoreEntry[] = []
  for (const [index, item] of list.entries()) {
    if (!isRecord(item)) continue
    const keys = item.keys ?? item.key
    entries.push({
      id: `${fileName}#${index + 1}`,
      episode: typeof item.episode === "string" ? item.episode : undefined,
      title: asText(item.comment) || asText(item.name) || "",
      content: asText(item.content),
      keys: Array.isArray(keys) ? keys.map(asText).join(", ") : asText(keys),
      // ST calls the native `condition` field `useProbability`-adjacent names
      // in some exports; only the native one is a real gate.
      condition: asText(item.condition),
      constant: item.constant === true,
      // ST marks a disabled entry with `enabled: false` or `disable: true`.
      enabled: item.enabled !== false && item.disable !== true,
    })
  }
  return entries
}

export interface PackBenchLintInput {
  items: PackItem[]
  metadata: PackMetadataForm
  panels: PackPanelsDraft | null
  manualSkills: PackSkillDraft[]
  presentation: PackPresentationDraft | null
  episodes?: PackEpisode[]
  buildUpTo?: number
}

/** The pack bench's whole session. */
export function lintSourceFromPackBench(input: PackBenchLintInput): PackLintSource {
  const variables: LintVariable[] = []
  const lore: LintLoreEntry[] = []
  const code: PackLintSource["code"] = []
  const shippedFiles: string[] = []
  const assetRefs: PackLintSource["assetRefs"] = []

  for (const item of input.items) {
    if (item.kind === "asset") shippedFiles.push(`assets/${item.fileName}`)
    if (item.kind === "lorebook" && item.jsonText !== null) {
      // A file tagged to an installment tags everything it carries, unless an
      // entry says otherwise.
      lore.push(
        ...loreFromJson(item.jsonText, item.fileName).map((entry) => ({
          ...entry,
          episode: entry.episode || item.episode || undefined,
        })),
      )
    }
    if (item.kind !== "card") continue
    // A card's own embedded lorebook is content too — and the place a secret
    // entry with no trigger most often hides.
    if (item.jsonText !== null) {
      lore.push(
        ...loreFromJson(item.jsonText, item.fileName).map((entry) => ({
          ...entry,
          episode: entry.episode || item.episode || undefined,
        })),
      )
    }
    for (const draft of item.drafts) {
      if (!draft.include) continue
      const id = normalizeVarId(draft.variable.id)
      if (!id || variables.some((existing) => existing.id === id)) continue
      variables.push(
        variableFrom(id, draft.variable.labelEn, draft.variable.labelZh, draft.variable.visibility),
      )
    }
    for (const [index, hook] of item.hooks.entries()) {
      code.push({ origin: `${item.fileName}#${index + 1}`, source: hook })
    }
  }

  for (const skill of input.manualSkills) {
    for (const [index, hook] of skill.hooks.entries()) {
      if (hook.trim()) code.push({ origin: `${skill.slug || "skill"}#${index + 1}`, source: hook })
    }
  }

  // Panel files ship under `ui/`, and a panel's `src` may name one of those as
  // readily as an `assets/…` drop (`ui/handouts/page.png` in the round-trip
  // fixture), so both go into the same shipped-file list.
  for (const file of input.panels?.files ?? []) shippedFiles.push(file.path)

  const kit = input.presentation
  if (kit !== null) {
    for (const subject of kit.subjects) {
      if (subject.refFileName) {
        shippedFiles.push(`assets/${subject.refFileName}`)
        assetRefs.push({ path: `assets/${subject.refFileName}`, from: subject.id || "subject" })
      }
    }
    for (const cue of kit.audio) {
      if (cue.assetFileName) {
        shippedFiles.push(`assets/${cue.assetFileName}`)
        assetRefs.push({ path: `assets/${cue.assetFileName}`, from: cue.id || "cue" })
      }
    }
  }

  return {
    meta: {
      id: input.metadata.id,
      nameEn: input.metadata.nameEn,
      nameZh: input.metadata.nameZh,
      descriptionEn: input.metadata.descriptionEn,
      descriptionZh: input.metadata.descriptionZh,
      license: input.metadata.license,
    },
    variables,
    lore,
    panelsYaml: input.panels?.yamlText.trim() ? input.panels.yamlText : null,
    code,
    episodes: (input.episodes ?? []).map((episode) => ({
      id: episode.id,
      ordinal: episode.ordinal,
      title: episode.title,
      releaseNotes: episode.releaseNotes,
    })),
    buildUpTo: input.buildUpTo ?? latestOrdinal(input.episodes ?? []),
    shippedFiles,
    assetRefs,
  }
}
