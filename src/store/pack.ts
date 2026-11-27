// The pack bench: drop files → deterministic classify + split → promotion drafts →
// (AI-drafted, human-confirmed) metadata → modules, panels, kit → a 3.0 pack source tree →
// the ENGINE builds it and verifies it. Every step is inspectable and editable — the
// pipeline is a wizard, not a black box.
//
// The session PERSISTS: a tab switch must not throw away every classification, promotion
// decision, metadata field, module and panel the author typed. What cannot survive is raw
// BYTES — a dropped PNG or MP3 would be megabytes of localStorage — so binary payloads are
// dropped on write and the item comes back flagged `needsBytes`; the build is blocked until
// the file is handed over again (`packItemNeedsBytes`) rather than shipping an empty file.
//
// Version 3 is the 3.0 pack. A session written before it is MIGRATED, not discarded: what
// 3.0 refuses (lorebooks as a pack kind, prompt presets, prep scripts, a rule pack's script,
// a skill's `hooks.js`) is dropped, 1.x panels are converted where the mapping is
// mechanical, and the author is told once what happened (`migrationNotes`).

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { guardedLocalStorage } from "../lib/persistStorage"
import { parseCardBytes, type StCharacterCard } from "../features/studio/split/charcard"
import {
  payloadsAny,
  splitCard,
  splitDecorators,
  type WorldPayloads,
} from "../features/studio/split/cardSplit"
import { asText, isRecord } from "../features/studio/split/charcard"
import { describeImportFailure, describeInitvarFailure } from "../features/studio/importErrors"
import { flattenLeaves, parseInitvar, type MvuLeaf } from "../features/studio/split/mvu"
import { promoteLeaves, suggestExposePrefixes, type PromotionDraft } from "../features/studio/split/promote"
import {
  safeFileName,
  validatePackDraft,
  type PackModuleDraft,
  type PackPanelFileDraft,
  type PackPanelsDraft,
  type PackPresentationAudioDraft,
  type PackPresentationDraft,
  type PackPresentationSubjectDraft,
  type PackSkillDraft,
  type WorldPackDraft,
} from "../features/studio/split/packSource"
import { migratePanelsYaml } from "../features/studio/pack/panelsMigrate"
import { countVariableSpecs, looksLikeLorecard, lorecardToCard } from "../features/studio/split/lorecard"
import type { PackEpisode } from "../features/studio/split/episodes"
import type { PackBuildSuccess } from "../features/studio/pack/buildResult"
import type { Issue } from "../features/studio/model"
import { bytesToBase64, type EngineCandidate, type EngineRunResult, type PickedFile } from "../lib/native"
import { useUndoStore } from "./undo"

export type PackStep = "input" | "review" | "promote" | "metadata" | "modules" | "presentation" | "build"
export const PACK_STEPS: PackStep[] = [
  "input",
  "review",
  "promote",
  "metadata",
  "modules",
  "presentation",
  "build",
]

export type PackItemKind = "card" | "asset"

export interface PackItem {
  uid: string
  /** Sanitized name the file will carry inside the pack. */
  fileName: string
  sourceName: string
  kind: PackItemKind
  base64: string
  /** UTF-8 text when the file is JSON (cards ride as text for readable diffs). */
  jsonText: string | null
  /** Byte size of the dropped file, kept so a restored item can be recognized. */
  size: number
  /** True when a persisted session came back without this item's bytes. */
  needsBytes: boolean

  // --- card-only fields ---
  card: StCharacterCard | null
  payloads: WorldPayloads | null
  cardKind: "character" | "world"
  /** Hook scripts the card carries: 3.0 counts them (they make it a world card) and never runs them. */
  hooks: string[]
  leaves: MvuLeaf[]
  leavesTruncated: boolean
  /** `[InitVar]` blocks that did not parse — the card still imported. */
  initvarProblems: Issue[]
  /** Serialized-module tag: the episode this file belongs to ("" = evergreen / episode 1). */
  episode: string
  drafts: PromotionDraft[]
  notesEn: string
  notesZh: string
}

export interface PackMetadataForm {
  id: string
  version: string
  nameEn: string
  nameZh: string
  descriptionEn: string
  descriptionZh: string
  authors: string
  license: string
  rulepackPatch: string
  /** Rule-pack file stem = the rule system's id (`rule system <id>`). Blank falls back to
   * `<packId>-rules`. */
  rulepackId: string
  /** `patch` = an `extends:` over a built-in system; `full` = a whole rule system. Both emit
   * the same `rulepacks/<id>.yaml`; the mode changes the editor and the advice only. */
  rulepackMode: "patch" | "full"
}

const EMPTY_METADATA: PackMetadataForm = {
  id: "",
  version: "0.1.0",
  nameEn: "",
  nameZh: "",
  descriptionEn: "",
  descriptionZh: "",
  authors: "",
  license: "",
  rulepackPatch: "",
  rulepackId: "",
  rulepackMode: "patch",
}

/** The starter a new module opens with: small, real, and against the SDK's documented
 * surface (`sdk/README.md` in the engine repository). */
// i18n-exempt: emitted TypeScript, read by the author's editor and the engine's builder.
export function moduleTemplate(id: string): string {
  const name = id || "my_module"
  return `import { defineModule } from "loreweaver/module";

// A module's id MUST equal the id the pack declares: its commands and views are
// named "${name}/<name>". Studio does not type-check or run this file; the
// engine's builder bundles it, and a room that enables the pack runs it.
let alarm = 0;

export default defineModule({
  id: "${name}",
  create() { alarm = 0; },
  load(snapshot) { alarm = (snapshot as { alarm: number }).alarm; },
  save() { return { alarm }; },

  on: {
    turnStart(event, fx) {
      if (/shout|fire|run/i.test(event.text)) alarm += 1;
      fx.inject(\`The alarm level is \${alarm} of 5.\`);
    },
  },

  views: {
    alarm: { title: "Alarm", schema: { type: "integer" }, for: () => alarm },
  },
});
`
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}

const decoder = new TextDecoder("utf-8")

/** What a dropped JSON file is: a card, a SillyTavern lorebook (which 3.0 packs do not carry:
 * lore rides inside a world card), or anything else (an asset the author can reclassify). */
export function classifyJson(parsed: unknown): PackItemKind | "lorebook" {
  if (!isRecord(parsed)) return "asset"
  if (looksLikeLorecard(parsed)) return "card"
  if (parsed.spec === "chara_card_v2" || parsed.spec === "chara_card_v3") return "card"
  if (isRecord(parsed.data) && (asText(parsed.data.name) || parsed.data.character_book)) return "card"
  // A ROOT-level `entries` collection is the lorebook signature and beats the loose card
  // heuristic below: a stock world-info export carries `{name, description, entries}`.
  if (Array.isArray(parsed.entries) || isRecord(parsed.entries)) return "lorebook"
  if (asText(parsed.name) && (parsed.description !== undefined || parsed.first_mes !== undefined))
    return "card"
  if (parsed.entries !== undefined || parsed.character_book !== undefined) return "lorebook"
  return "asset"
}

/** Parse InitVar entries the engine way (decorators off, JSON5-lite parse, later entries
 * fill only missing keys) and flatten for promotion. `problems` reports the blocks that did
 * NOT parse — the card still imports without them. */
export function initvarLeaves(entries: Record<string, unknown>[]): {
  leaves: MvuLeaf[]
  truncated: boolean
  problems: Issue[]
} {
  const problems: Issue[] = []
  const merged: Record<string, unknown> = {}
  const mergeMissing = (target: Record<string, unknown>, incoming: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(incoming)) {
      if (!(key in target)) target[key] = value
      else if (isRecord(target[key]) && isRecord(value))
        mergeMissing(target[key] as Record<string, unknown>, value)
    }
  }
  for (const [index, entry] of entries.entries()) {
    const body = splitDecorators(asText(entry.content)).body
    const tree = parseInitvar(body)
    if (tree !== null) {
      mergeMissing(merged, tree)
      continue
    }
    const where = asText(entry.comment) || `[InitVar] #${index + 1}`
    const problem = describeInitvarFailure(body, where)
    if (problem !== null) problems.push(problem)
  }
  return { ...flattenLeaves(merged), problems }
}

class LorebookRefused extends Error {}

async function itemFromFile(file: PickedFile): Promise<PackItem> {
  const base = {
    uid: uid(),
    sourceName: file.name,
    base64: bytesToBase64(file.bytes),
    jsonText: null as string | null,
    size: file.bytes.length,
    needsBytes: false,
    episode: "",
    card: null as StCharacterCard | null,
    payloads: null as WorldPayloads | null,
    cardKind: "character" as const,
    hooks: [] as string[],
    leaves: [] as MvuLeaf[],
    leavesTruncated: false,
    initvarProblems: [] as Issue[],
    drafts: [] as PromotionDraft[],
    notesEn: "",
    notesZh: "",
  }
  const lower = file.name.toLowerCase()
  const stem = file.name.replace(/\.[^.]*$/, "")

  if (lower.endsWith(".json")) {
    const jsonText = decoder.decode(file.bytes)
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      return { ...base, kind: "asset", fileName: safeFileName(stem, "file") + ".json", jsonText }
    }
    const kind = classifyJson(parsed)
    if (kind === "lorebook") throw new LorebookRefused(file.name)
    if (kind === "card" && isRecord(parsed) && looksLikeLorecard(parsed)) {
      // Native bundle: keep the `.lorecard.json` double suffix the ecosystem recognizes.
      const bareStem = stem.toLowerCase().endsWith(".lorecard") ? stem.slice(0, -".lorecard".length) : stem
      return lorecardItem(base, parsed, jsonText, `${safeFileName(bareStem, "card")}.lorecard.json`)
    }
    if (kind === "card") return await cardItem(base, file, jsonText, `${safeFileName(stem, "card")}.json`)
    return { ...base, kind: "asset", fileName: safeFileName(stem, "file") + ".json", jsonText }
  }

  if (lower.endsWith(".png")) {
    try {
      return await cardItem(base, file, null, `${safeFileName(stem, "card")}.png`)
    } catch {
      return { ...base, kind: "asset", fileName: `${safeFileName(stem, "image")}.png` }
    }
  }

  const extension = /\.[^.]+$/.exec(lower)?.[0] ?? ""
  return { ...base, kind: "asset", fileName: safeFileName(stem, "asset") + extension }
}

async function cardItem(
  base: Omit<PackItem, "kind" | "fileName">,
  file: PickedFile,
  jsonText: string | null,
  fileName: string,
): Promise<PackItem> {
  const card = await parseCardBytes(file.bytes, file.name)
  return splitIntoItem(base, card, jsonText, fileName)
}

/** Native bundle → pack item: same split/promotion machinery, native parser. Typed
 * `variables` specs are world machinery (the engine counts them as module variables), so a
 * specs-only lorecard is a world card. */
function lorecardItem(
  base: Omit<PackItem, "kind" | "fileName">,
  parsed: Record<string, unknown>,
  jsonText: string,
  fileName: string,
): PackItem {
  const item = splitIntoItem(base, lorecardToCard(parsed).card, jsonText, fileName)
  const specs = countVariableSpecs(parsed)
  if (specs === 0 || item.payloads === null) return item
  const payloads = { ...item.payloads, initvarEntries: item.payloads.initvarEntries + specs }
  return { ...item, payloads, cardKind: "world" }
}

function splitIntoItem(
  base: Omit<PackItem, "kind" | "fileName">,
  card: StCharacterCard,
  jsonText: string | null,
  fileName: string,
): PackItem {
  const split = splitCard(card)
  const { leaves, truncated, problems } = initvarLeaves(split.initvarEntries)
  return {
    ...base,
    kind: "card",
    fileName,
    jsonText,
    card,
    payloads: split.payloads,
    cardKind: payloadsAny(split.payloads) ? "world" : "character",
    hooks: split.hooks,
    leaves,
    leavesTruncated: truncated,
    initvarProblems: problems,
    drafts: promoteLeaves(leaves),
  }
}

interface PackState {
  step: PackStep
  items: PackItem[]
  metadata: PackMetadataForm
  /** Why the last drop failed, as an i18n key + params (never a raw message). */
  loadError: Issue | null
  /** What a migration of an older session dropped or converted; shown once, then dismissed. */
  migrationNotes: Issue[]

  panels: PackPanelsDraft | null
  /** The presentation kit; null = the pack ships none. */
  presentation: PackPresentationDraft | null
  episodes: PackEpisode[]
  /** Build up to this ordinal; 0 = the latest episode there is. */
  buildUpTo: number
  /** Hand-authored skills (a full SKILL.md each). */
  manualSkills: PackSkillDraft[]
  /** The pack's modules: entry sources under `src/`. */
  modules: PackModuleDraft[]

  outputDir: string | null
  writtenDir: string | null
  candidates: EngineCandidate[]
  selectedCandidate: number
  running: boolean
  runResult: EngineRunResult | null
  /** The builder's success object (drives the trust card). */
  packResult: PackBuildSuccess | null
  builtPackPath: string | null

  setStep: (step: PackStep) => void
  addFiles: (files: PickedFile[]) => Promise<void>
  reattachItem: (uid: string, file: PickedFile) => void
  reattachPanelFile: (path: string, file: PickedFile) => void
  removeItem: (uid: string) => void
  updateItem: (uid: string, patch: Partial<PackItem>) => void
  updateDraft: (itemUid: string, draftUid: string, patch: Partial<PromotionDraft>) => void
  setMetadata: (patch: Partial<PackMetadataForm>) => void
  dismissMigrationNotes: () => void
  setPanelsYaml: (yamlText: string) => void
  addPanelFiles: (files: PickedFile[], subdir: string) => void
  updatePanelFilePath: (path: string, nextPath: string) => void
  removePanelFile: (path: string) => void
  clearPanels: () => void
  addPresentation: () => void
  clearPresentation: () => void
  updatePresentation: (
    patch: Partial<
      Pick<
        PackPresentationDraft,
        "generation" | "templates" | "keywordsEn" | "keywordsZh" | "bannedText" | "paletteText"
      >
    >,
  ) => void
  addPresentationSubject: () => void
  updatePresentationSubject: (uid: string, patch: Partial<PackPresentationSubjectDraft>) => void
  removePresentationSubject: (uid: string) => void
  setPresentationSubjectRef: (uid: string, file: PickedFile) => void
  clearPresentationSubjectRef: (uid: string) => void
  addPresentationCue: () => void
  updatePresentationCue: (uid: string, patch: Partial<PackPresentationAudioDraft>) => void
  removePresentationCue: (uid: string) => void
  setPresentationCueAsset: (uid: string, file: PickedFile) => void
  clearPresentationCueAsset: (uid: string) => void
  addEpisode: () => void
  updateEpisode: (id: string, patch: Partial<PackEpisode>) => void
  removeEpisode: (id: string) => void
  setBuildUpTo: (upTo: number) => void
  addManualSkill: () => void
  updateManualSkill: (index: number, patch: Partial<PackSkillDraft>) => void
  removeManualSkill: (index: number) => void
  addModule: () => void
  updateModule: (uid: string, patch: Partial<Omit<PackModuleDraft, "uid">>) => void
  removeModule: (uid: string) => void
  seedFromSplit: (item: PackItem, notesZh: string, notesEn: string) => void
  setOutputDir: (dir: string | null) => void
  setWritten: (dir: string | null) => void
  setCandidates: (candidates: EngineCandidate[]) => void
  setSelectedCandidate: (index: number) => void
  setRunning: (running: boolean) => void
  setRunResult: (result: EngineRunResult | null) => void
  setPackResult: (result: PackBuildSuccess | null) => void
  setBuiltPackPath: (path: string | null) => void
  reset: () => void
}

/** Panel files that ride as UTF-8 text (a page's HTML, an SVG); the rest go base64. */
const PANEL_TEXT_EXTENSIONS = new Set(["html", "htm", "svg"])

function panelFileFromPicked(file: PickedFile, subdir: string): PackPanelFileDraft {
  const dir = subdir
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((part) => safeFileName(part, ""))
    .filter((part) => part.length > 0)
    .join("/")
  const path = `ui/${dir ? `${dir}/` : ""}${file.name}`
  const extension = /\.([^.]+)$/.exec(file.name.toLowerCase())?.[1] ?? ""
  if (PANEL_TEXT_EXTENSIONS.has(extension)) return { path, contents: decoder.decode(file.bytes) }
  return { path, base64: bytesToBase64(file.bytes) }
}

/** Pack file name for an uploaded kit media file: sanitized stem + original extension. */
function kitMediaFileName(name: string, fallback: string): string {
  const stem = name.replace(/\.[^.]*$/, "")
  const extension = /\.([^.]+)$/.exec(name.toLowerCase())?.[1] ?? ""
  return `${safeFileName(stem, fallback)}${extension ? `.${extension}` : ""}`
}

function newPresentationDraft(): PackPresentationDraft {
  return {
    generation: "allow",
    // Empty = every performance shape allowed; pre-ticking would emit an allowlist the
    // author never chose.
    templates: [],
    keywordsEn: "",
    keywordsZh: "",
    bannedText: "",
    paletteText: "",
    subjects: [],
    audio: [],
  }
}

function newPresentationSubject(): PackPresentationSubjectDraft {
  return {
    uid: uid(),
    id: "",
    kind: "npc",
    nameEn: "",
    nameZh: "",
    refFileName: "",
    refBase64: "",
    prompt: "",
  }
}

function newPresentationCue(): PackPresentationAudioDraft {
  return { uid: uid(), id: "", layer: "bgm", assetFileName: "", assetBase64: "", title: "" }
}

/** A fresh module, with an id not yet taken. */
function newModule(existing: PackModuleDraft[]): PackModuleDraft {
  let index = existing.length + 1
  let id = existing.length === 0 ? "main" : `module_${index}`
  while (existing.some((module) => module.id === id)) id = `module_${++index}`
  return { uid: uid(), id, fileName: `${id}.ts`, source: moduleTemplate(id) }
}

/** The session version this build writes. Bump WHENEVER the persisted shape changes, and
 * teach `migratePackSession` the step. 2: the rule-pack script fields joined `metadata`.
 * 3: the 3.0 pack (modules; lorebooks, presets, prep scripts, rule-pack scripts and skill
 * hooks gone; panels 3.0). */
export const PACK_SESSION_VERSION = 3

/** The parts of a session that persist. */
export interface PersistedPackSession {
  step: PackStep
  items: PackItem[]
  metadata: PackMetadataForm
  migrationNotes: Issue[]
  panels: PackPanelsDraft | null
  presentation: PackPresentationDraft | null
  manualSkills: PackSkillDraft[]
  modules: PackModuleDraft[]
  episodes: PackEpisode[]
  buildUpTo: number
  outputDir: string | null
  writtenDir: string | null
  packResult: PackBuildSuccess | null
  builtPackPath: string | null
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * A stored session of an older version, as this version's. Pure, so a test can hand it a
 * stored 2.x-shaped draft. What 3.0 refuses is dropped and counted in `migrationNotes`; the
 * rest is carried over field by field, so a partial or odd blob never reaches a render
 * missing a field the form reads.
 */
export function migratePackSession(stored: unknown, version: number): PersistedPackSession {
  const raw = isRecord(stored) ? stored : {}
  const notes: Issue[] = []
  const count = (key: string, n: number) => {
    if (n > 0) notes.push({ key, params: { count: n } })
  }

  const rawItems = listOf(raw.items).filter(isRecord)
  const lorebooks = rawItems.filter((item) => item.kind === "lorebook")
  count("pack.migration.lorebooks", lorebooks.length)
  const extracted = rawItems.filter(
    (item) => item.kind === "card" && item.extractSkill === true && listOf(item.hooks).length > 0,
  )
  count("pack.migration.cardHookSkills", extracted.length)
  const items = rawItems
    .filter((item) => item.kind === "card" || item.kind === "asset")
    .map((item) => {
      const kept: Record<string, unknown> = { ...item }
      delete kept.extractSkill
      delete kept.entryCount
      return {
        ...kept,
        hooks: listOf(item.hooks).filter((hook): hook is string => typeof hook === "string"),
      } as unknown as PackItem
    })

  const storedMetadata = isRecord(raw.metadata) ? raw.metadata : {}
  if (stringOr(storedMetadata.rulepackScriptSource, "").trim())
    notes.push({ key: "pack.migration.rulepackScript" })
  const metadata: PackMetadataForm = {
    id: stringOr(storedMetadata.id, EMPTY_METADATA.id),
    version: stringOr(storedMetadata.version, EMPTY_METADATA.version),
    nameEn: stringOr(storedMetadata.nameEn, ""),
    nameZh: stringOr(storedMetadata.nameZh, ""),
    descriptionEn: stringOr(storedMetadata.descriptionEn, ""),
    descriptionZh: stringOr(storedMetadata.descriptionZh, ""),
    authors: stringOr(storedMetadata.authors, ""),
    license: stringOr(storedMetadata.license, ""),
    rulepackPatch: stringOr(storedMetadata.rulepackPatch, ""),
    rulepackId: stringOr(storedMetadata.rulepackId, ""),
    rulepackMode: storedMetadata.rulepackMode === "full" ? "full" : "patch",
  }

  const rawSkills = listOf(raw.manualSkills).filter(isRecord)
  count(
    "pack.migration.skillHooks",
    rawSkills.filter((skill) =>
      listOf(skill.hooks).some((hook) => typeof hook === "string" && hook.trim() !== ""),
    ).length,
  )
  const manualSkills: PackSkillDraft[] = rawSkills.map((skill) => ({
    slug: stringOr(skill.slug, ""),
    nameEn: stringOr(skill.nameEn, ""),
    descriptionEn: stringOr(skill.descriptionEn, ""),
    descriptionZh: stringOr(skill.descriptionZh, ""),
    skillMd: stringOr(skill.skillMd, ""),
  }))
  count("pack.migration.prepScripts", listOf(raw.prepScripts).length)
  count("pack.migration.presets", listOf(raw.packPresets).length)

  let panels: PackPanelsDraft | null = null
  if (isRecord(raw.panels)) {
    const yamlText = stringOr(raw.panels.yamlText, "")
    const migrated = version < 3 ? migratePanelsYaml(yamlText) : { yamlText, legacy: false, leftover: false }
    if (migrated.legacy)
      notes.push({
        key: migrated.leftover ? "pack.migration.panelsLeftover" : "pack.migration.panelsConverted",
      })
    panels = {
      yamlText: migrated.yamlText,
      files: listOf(raw.panels.files)
        .filter(isRecord)
        .filter((file) => typeof file.path === "string")
        .map((file) => ({
          path: file.path as string,
          ...(typeof file.contents === "string" ? { contents: file.contents } : {}),
          ...(typeof file.base64 === "string" ? { base64: file.base64 } : {}),
        })),
    }
  }

  const step = stringOr(raw.step, "input") as PackStep
  return {
    step: PACK_STEPS.includes(step) ? step : "input",
    items,
    metadata,
    migrationNotes: [...(version >= 3 ? (listOf(raw.migrationNotes) as Issue[]) : []), ...notes],
    panels,
    presentation: isRecord(raw.presentation) ? (raw.presentation as unknown as PackPresentationDraft) : null,
    manualSkills,
    modules: version >= 3 ? (listOf(raw.modules) as PackModuleDraft[]) : [],
    episodes: listOf(raw.episodes) as PackEpisode[],
    buildUpTo: typeof raw.buildUpTo === "number" ? raw.buildUpTo : 0,
    outputDir: typeof raw.outputDir === "string" ? raw.outputDir : null,
    // A 2.x build's source tree and result describe a pack 3.0 refuses: built again, not kept.
    writtenDir: version >= 3 && typeof raw.writtenDir === "string" ? raw.writtenDir : null,
    packResult: version >= 3 ? ((raw.packResult as PackBuildSuccess | null) ?? null) : null,
    builtPackPath: version >= 3 && typeof raw.builtPackPath === "string" ? raw.builtPackPath : null,
  }
}

export const usePackStore = create<PackState>()(
  persist(
    (set) => ({
      step: "input",
      items: [],
      metadata: EMPTY_METADATA,
      loadError: null,
      migrationNotes: [],
      panels: null,
      presentation: null,
      manualSkills: [],
      modules: [],
      episodes: [],
      buildUpTo: 0,
      outputDir: null,
      writtenDir: null,
      candidates: [],
      selectedCandidate: 0,
      running: false,
      runResult: null,
      packResult: null,
      builtPackPath: null,

      setStep: (step) => set({ step }),

      addFiles: async (files) => {
        const items: PackItem[] = []
        let loadError: Issue | null = null
        for (const file of files) {
          try {
            items.push(await itemFromFile(file))
          } catch (error) {
            loadError =
              error instanceof LorebookRefused
                ? { key: "pack.lorebookRefused", params: { file: file.name } }
                : describeImportFailure(error, file.name)
          }
        }
        set((state) => ({ items: [...state.items, ...items], loadError }))
      },

      reattachItem: (uid, file) =>
        set((state) => ({
          items: state.items.map((item) =>
            item.uid === uid
              ? { ...item, base64: bytesToBase64(file.bytes), size: file.bytes.length, needsBytes: false }
              : item,
          ),
        })),

      reattachPanelFile: (path, file) =>
        set((state) =>
          state.panels === null
            ? {}
            : {
                panels: {
                  ...state.panels,
                  files: state.panels.files.map((entry) =>
                    // Only a binary file loses its bytes on reload; text files persist whole.
                    entry.path === path ? { path: entry.path, base64: bytesToBase64(file.bytes) } : entry,
                  ),
                },
              },
        ),

      removeItem: (uid) =>
        set((state) => {
          const index = state.items.findIndex((item) => item.uid === uid)
          const removed = state.items[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("packItem", removed.sourceName, () => {
              set((s) => ({ items: [...s.items.slice(0, index), removed, ...s.items.slice(index)] }))
            })
          }
          return { items: state.items.filter((item) => item.uid !== uid) }
        }),

      updateItem: (uid, patch) =>
        set((state) => ({
          items: state.items.map((item) => {
            if (item.uid !== uid) return item
            const next = { ...item, ...patch }
            // The kind is what the card IS: pinned to the detection on every edit.
            if (next.payloads !== null) next.cardKind = payloadsAny(next.payloads) ? "world" : "character"
            return next
          }),
        })),

      updateDraft: (itemUid, draftUid, patch) =>
        set((state) => ({
          items: state.items.map((item) =>
            item.uid === itemUid
              ? {
                  ...item,
                  drafts: item.drafts.map((draft) =>
                    draft.uid === draftUid
                      ? { ...draft, ...patch, variable: patch.variable ?? draft.variable }
                      : draft,
                  ),
                }
              : item,
          ),
        })),

      setMetadata: (patch) => set((state) => ({ metadata: { ...state.metadata, ...patch } })),

      dismissMigrationNotes: () => set({ migrationNotes: [] }),

      setPanelsYaml: (yamlText) =>
        set((state) => ({ panels: { yamlText, files: state.panels?.files ?? [] } })),

      addPanelFiles: (files, subdir) =>
        set((state) => {
          const existing = state.panels ?? { yamlText: "", files: [] }
          const additions = files.map((file) => panelFileFromPicked(file, subdir))
          const kept = existing.files.filter((file) => !additions.some((next) => next.path === file.path))
          return { panels: { ...existing, files: [...kept, ...additions] } }
        }),

      updatePanelFilePath: (path, nextPath) =>
        set((state) =>
          state.panels === null
            ? {}
            : {
                panels: {
                  ...state.panels,
                  files: state.panels.files.map((file) =>
                    file.path === path ? { ...file, path: nextPath } : file,
                  ),
                },
              },
        ),

      removePanelFile: (path) =>
        set((state) => {
          if (state.panels === null) return {}
          const index = state.panels.files.findIndex((file) => file.path === path)
          const removed = state.panels.files[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("panelFile", removed.path, () => {
              set((s) =>
                s.panels === null
                  ? {}
                  : {
                      panels: {
                        ...s.panels,
                        files: [...s.panels.files.slice(0, index), removed, ...s.panels.files.slice(index)],
                      },
                    },
              )
            })
          }
          return { panels: { ...state.panels, files: state.panels.files.filter((f) => f.path !== path) } }
        }),

      clearPanels: () => set({ panels: null }),

      addPresentation: () =>
        set((state) => (state.presentation !== null ? {} : { presentation: newPresentationDraft() })),

      clearPresentation: () => set({ presentation: null }),

      updatePresentation: (patch) =>
        set((state) =>
          state.presentation === null ? {} : { presentation: { ...state.presentation, ...patch } },
        ),

      addPresentationSubject: () =>
        set((state) =>
          state.presentation === null
            ? {}
            : {
                presentation: {
                  ...state.presentation,
                  subjects: [...state.presentation.subjects, newPresentationSubject()],
                },
              },
        ),

      updatePresentationSubject: (subjectUid, patch) =>
        set((state) =>
          state.presentation === null
            ? {}
            : {
                presentation: {
                  ...state.presentation,
                  subjects: state.presentation.subjects.map((subject) =>
                    subject.uid === subjectUid ? { ...subject, ...patch } : subject,
                  ),
                },
              },
        ),

      removePresentationSubject: (subjectUid) =>
        set((state) => {
          if (state.presentation === null) return {}
          const index = state.presentation.subjects.findIndex((s) => s.uid === subjectUid)
          const removed = state.presentation.subjects[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("subject", removed.id, () => {
              set((s) =>
                s.presentation === null
                  ? {}
                  : {
                      presentation: {
                        ...s.presentation,
                        subjects: [
                          ...s.presentation.subjects.slice(0, index),
                          removed,
                          ...s.presentation.subjects.slice(index),
                        ],
                      },
                    },
              )
            })
          }
          return {
            presentation: {
              ...state.presentation,
              subjects: state.presentation.subjects.filter((subject) => subject.uid !== subjectUid),
            },
          }
        }),

      setPresentationSubjectRef: (subjectUid, file) =>
        set((state) =>
          state.presentation === null
            ? {}
            : {
                presentation: {
                  ...state.presentation,
                  subjects: state.presentation.subjects.map((subject) =>
                    subject.uid === subjectUid
                      ? {
                          ...subject,
                          refFileName: kitMediaFileName(file.name, "reference"),
                          refBase64: bytesToBase64(file.bytes),
                        }
                      : subject,
                  ),
                },
              },
        ),

      clearPresentationSubjectRef: (subjectUid) =>
        set((state) =>
          state.presentation === null
            ? {}
            : {
                presentation: {
                  ...state.presentation,
                  subjects: state.presentation.subjects.map((subject) =>
                    subject.uid === subjectUid ? { ...subject, refFileName: "", refBase64: "" } : subject,
                  ),
                },
              },
        ),

      addPresentationCue: () =>
        set((state) =>
          state.presentation === null
            ? {}
            : {
                presentation: {
                  ...state.presentation,
                  audio: [...state.presentation.audio, newPresentationCue()],
                },
              },
        ),

      updatePresentationCue: (cueUid, patch) =>
        set((state) =>
          state.presentation === null
            ? {}
            : {
                presentation: {
                  ...state.presentation,
                  audio: state.presentation.audio.map((cue) =>
                    cue.uid === cueUid ? { ...cue, ...patch } : cue,
                  ),
                },
              },
        ),

      removePresentationCue: (cueUid) =>
        set((state) => {
          if (state.presentation === null) return {}
          const index = state.presentation.audio.findIndex((cue) => cue.uid === cueUid)
          const removed = state.presentation.audio[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("cue", removed.id, () => {
              set((s) =>
                s.presentation === null
                  ? {}
                  : {
                      presentation: {
                        ...s.presentation,
                        audio: [
                          ...s.presentation.audio.slice(0, index),
                          removed,
                          ...s.presentation.audio.slice(index),
                        ],
                      },
                    },
              )
            })
          }
          return {
            presentation: {
              ...state.presentation,
              audio: state.presentation.audio.filter((cue) => cue.uid !== cueUid),
            },
          }
        }),

      setPresentationCueAsset: (cueUid, file) =>
        set((state) =>
          state.presentation === null
            ? {}
            : {
                presentation: {
                  ...state.presentation,
                  audio: state.presentation.audio.map((cue) =>
                    cue.uid === cueUid
                      ? {
                          ...cue,
                          assetFileName: kitMediaFileName(file.name, "audio"),
                          assetBase64: bytesToBase64(file.bytes),
                        }
                      : cue,
                  ),
                },
              },
        ),

      clearPresentationCueAsset: (cueUid) =>
        set((state) =>
          state.presentation === null
            ? {}
            : {
                presentation: {
                  ...state.presentation,
                  audio: state.presentation.audio.map((cue) =>
                    cue.uid === cueUid ? { ...cue, assetFileName: "", assetBase64: "" } : cue,
                  ),
                },
              },
        ),

      addManualSkill: () =>
        set((state) => ({
          manualSkills: [
            ...state.manualSkills,
            { slug: "", nameEn: "", descriptionEn: "", descriptionZh: "", skillMd: "" },
          ],
        })),

      updateManualSkill: (index, patch) =>
        set((state) => ({
          manualSkills: state.manualSkills.map((skill, i) => (i === index ? { ...skill, ...patch } : skill)),
        })),

      removeManualSkill: (index) =>
        set((state) => {
          const removed = state.manualSkills[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("skill", removed.slug, () => {
              set((s) => ({
                manualSkills: [...s.manualSkills.slice(0, index), removed, ...s.manualSkills.slice(index)],
              }))
            })
          }
          return { manualSkills: state.manualSkills.filter((_, i) => i !== index) }
        }),

      addModule: () => set((state) => ({ modules: [...state.modules, newModule(state.modules)] })),

      updateModule: (moduleUid, patch) =>
        set((state) => ({
          modules: state.modules.map((module) =>
            module.uid === moduleUid ? { ...module, ...patch } : module,
          ),
        })),

      removeModule: (moduleUid) =>
        set((state) => {
          const index = state.modules.findIndex((module) => module.uid === moduleUid)
          const removed = state.modules[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("module", removed.id, () => {
              set((s) => ({ modules: [...s.modules.slice(0, index), removed, ...s.modules.slice(index)] }))
            })
          }
          return { modules: state.modules.filter((module) => module.uid !== moduleUid) }
        }),

      addEpisode: () =>
        set((state) => {
          const ordinal = state.episodes.length + 1
          return {
            episodes: [
              ...state.episodes,
              { id: `ep${ordinal}`, ordinal, title: "", summary: "", releaseNotes: "" },
            ],
          }
        }),

      updateEpisode: (id, patch) =>
        set((state) => ({
          episodes: state.episodes.map((episode) => (episode.id === id ? { ...episode, ...patch } : episode)),
        })),

      removeEpisode: (id) =>
        set((state) => {
          const index = state.episodes.findIndex((episode) => episode.id === id)
          const removed = state.episodes[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("episode", removed.title || removed.id, () => {
              set((s) => ({ episodes: [...s.episodes.slice(0, index), removed, ...s.episodes.slice(index)] }))
            })
          }
          // Content tagged to it stays tagged: the lint says so, and the build INCLUDES it —
          // deleting an episode must never silently delete an author's work.
          return { episodes: state.episodes.filter((episode) => episode.id !== id) }
        }),

      setBuildUpTo: (buildUpTo) => set({ buildUpTo: Math.max(0, Math.trunc(buildUpTo)) }),

      seedFromSplit: (item, notesZh, notesEn) =>
        set({
          step: "metadata",
          items: [{ ...item, notesZh, notesEn }],
          metadata: { ...EMPTY_METADATA },
          panels: null,
          presentation: null,
          manualSkills: [],
          modules: [],
          episodes: [],
          buildUpTo: 0,
          writtenDir: null,
          runResult: null,
          packResult: null,
          builtPackPath: null,
        }),

      setOutputDir: (outputDir) => set({ outputDir }),
      setWritten: (writtenDir) => set({ writtenDir }),
      setCandidates: (candidates) => set({ candidates, selectedCandidate: 0 }),
      setSelectedCandidate: (selectedCandidate) => set({ selectedCandidate }),
      setRunning: (running) => set({ running }),
      setRunResult: (runResult) => set({ runResult }),
      setPackResult: (packResult) => set({ packResult }),
      setBuiltPackPath: (builtPackPath) => set({ builtPackPath }),

      reset: () =>
        set({
          step: "input",
          items: [],
          metadata: EMPTY_METADATA,
          loadError: null,
          migrationNotes: [],
          panels: null,
          presentation: null,
          manualSkills: [],
          modules: [],
          episodes: [],
          buildUpTo: 0,
          outputDir: null,
          writtenDir: null,
          runResult: null,
          packResult: null,
          builtPackPath: null,
          running: false,
        }),
    }),
    {
      name: "loreweaver-studio-pack",
      // Guarded: `persist` writes synchronously inside `set`, on every keystroke, so a quota
      // error here would abort the edit that caused it. See `lib/persistStorage.ts`.
      storage: guardedLocalStorage,
      version: PACK_SESSION_VERSION,
      // An older session is carried over, not discarded (see `migratePackSession`).
      migrate: (stored, version) => migratePackSession(stored, version) as unknown as PackState,
      // What survives: every classification, promotion decision, metadata field, module,
      // panel, kit entry and the paths the build already used. What does not: raw bytes
      // (dropped, flagged for re-attach), the engine probe and the last run's output.
      partialize: (state): PersistedPackSession => ({
        step: state.step,
        items: state.items.map((item) => ({
          ...item,
          base64: item.jsonText === null && item.base64 !== "" ? "" : item.base64,
          needsBytes: item.jsonText === null && item.base64 !== "",
        })),
        metadata: state.metadata,
        migrationNotes: state.migrationNotes,
        panels:
          state.panels === null
            ? null
            : {
                ...state.panels,
                files: state.panels.files.map((file) =>
                  file.contents === undefined ? { path: file.path } : file,
                ),
              },
        presentation:
          state.presentation === null
            ? null
            : {
                ...state.presentation,
                subjects: state.presentation.subjects.map((subject) => ({ ...subject, refBase64: "" })),
                audio: state.presentation.audio.map((cue) => ({ ...cue, assetBase64: "" })),
              },
        manualSkills: state.manualSkills,
        modules: state.modules,
        episodes: state.episodes,
        buildUpTo: state.buildUpTo,
        outputDir: state.outputDir,
        writtenDir: state.writtenDir,
        packResult: state.packResult,
        builtPackPath: state.builtPackPath,
      }),
    },
  ),
)

/** Suggested `var expose` lines across every world card in the pack. */
export function packExposeLines(items: PackItem[]): string[] {
  const lines: string[] = []
  for (const item of items) {
    if (item.kind !== "card" || item.cardKind !== "world") continue
    for (const prefix of suggestExposePrefixes(item.drafts)) {
      const line = `.var expose ${prefix}`
      if (!lines.includes(line)) lines.push(line)
    }
  }
  return lines
}

/** What a draft is assembled from: the bench's session. */
export interface PackDraftInput {
  items: PackItem[]
  metadata: PackMetadataForm
  panels?: PackPanelsDraft | null
  manualSkills?: PackSkillDraft[]
  modules?: PackModuleDraft[]
  presentation?: PackPresentationDraft | null
  episodes?: PackEpisode[]
  buildUpTo?: number
}

/** Assemble the WorldPackDraft for validation + source-tree planning. */
export function buildDraftFromState(input: PackDraftInput): WorldPackDraft {
  const { items, metadata } = input
  const cards = items
    .filter((item) => item.kind === "card")
    .map((item) => ({
      fileName: item.fileName,
      jsonText: item.jsonText ?? undefined,
      base64: item.jsonText === null ? item.base64 : undefined,
      kind: item.cardKind,
      notesEn: item.notesEn,
      notesZh: item.notesZh,
      episode: item.episode,
    }))
  const rulepacks = metadata.rulepackPatch.trim()
    ? [{ id: metadata.rulepackId.trim() || `${metadata.id}-rules`, yamlText: metadata.rulepackPatch }]
    : []
  const panels = input.panels ?? null
  return {
    id: metadata.id,
    version: metadata.version,
    nameEn: metadata.nameEn,
    nameZh: metadata.nameZh,
    descriptionEn: metadata.descriptionEn,
    descriptionZh: metadata.descriptionZh,
    authors: metadata.authors
      .split(/[\n,]/)
      .map((author) => author.trim())
      .filter(Boolean),
    license: metadata.license,
    cards,
    skills: input.manualSkills ?? [],
    rulepacks,
    modules: input.modules ?? [],
    assets: items
      .filter((item) => item.kind === "asset")
      .map((item) => ({ fileName: item.fileName, base64: item.base64, episode: item.episode })),
    panels: panels !== null && panels.yamlText.trim() ? panels : null,
    presentation: input.presentation ?? null,
    episodes: input.episodes ?? [],
    buildUpTo: input.buildUpTo ?? 0,
  }
}

export function packValidationIssues(input: PackDraftInput): Issue[] {
  // A restored session knows an item's name, kind and every decision made about it, but not
  // its bytes. Building anyway would write an empty file under a name that promises content.
  const missing = input.items
    .filter((item) => item.needsBytes)
    .map((item) => ({ key: "packItemNeedsBytes", params: { file: item.fileName } }))
  return [...missing, ...validatePackDraft(buildDraftFromState(input))]
}
