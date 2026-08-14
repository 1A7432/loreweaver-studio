// The auto-import pipeline (③): drop files → deterministic classify + split →
// promotion drafts → (AI-drafted, human-confirmed) metadata → source tree →
// the ENGINE builds/installs. Every step is inspectable and editable — the
// pipeline is a wizard, not a black box. Nothing here persists: it is a
// working session over files the user just dropped.

import { create } from "zustand"
import { parseCardBytes, type StCharacterCard } from "../features/studio/split/charcard"
import {
  payloadsAny,
  splitCard,
  splitDecorators,
  type WorldPayloads,
} from "../features/studio/split/cardSplit"
import { asText, isRecord } from "../features/studio/split/charcard"
import { flattenLeaves, parseInitvar, type MvuLeaf } from "../features/studio/split/mvu"
import { promoteLeaves, suggestExposePrefixes, type PromotionDraft } from "../features/studio/split/promote"
import {
  safeFileName,
  validatePackDraft,
  type PackPanelFileDraft,
  type PackPanelsDraft,
  type PackPresentationAudioDraft,
  type PackPresentationDraft,
  type PackPresentationSubjectDraft,
  type PackSkillDraft,
  type WorldPackDraft,
} from "../features/studio/split/packSource"
import { countVariableSpecs, looksLikeLorecard, lorecardToCard } from "../features/studio/split/lorecard"
import type { PackBuildSuccess } from "../features/studio/pack/buildResult"
import type { Issue } from "../features/studio/model"
import { bytesToBase64, type EngineCandidate, type EngineRunResult, type PickedFile } from "../lib/native"

export type PackStep = "input" | "review" | "promote" | "metadata" | "presentation" | "build"
export const PACK_STEPS: PackStep[] = ["input", "review", "promote", "metadata", "presentation", "build"]

export type PackItemKind = "card" | "lorebook" | "asset"

export interface PackItem {
  uid: string
  /** Sanitized name the file will carry inside the pack. */
  fileName: string
  sourceName: string
  kind: PackItemKind
  base64: string
  /** UTF-8 text when the file is JSON (cards ride as text for readable diffs). */
  jsonText: string | null

  // --- card-only fields ---
  card: StCharacterCard | null
  payloads: WorldPayloads | null
  cardKind: "character" | "world"
  hooks: string[]
  leaves: MvuLeaf[]
  leavesTruncated: boolean
  drafts: PromotionDraft[]
  /** Extract hooks into a `skills/<slug>/` directory (JSON cards only). */
  extractSkill: boolean
  notesEn: string
  notesZh: string

  // --- lorebook-only ---
  entryCount: number
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
  /** Rulepack file stem = the system id players type in `.set`. Blank falls
   * back to `<packId>-rules` (the historical default). */
  rulepackId: string
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
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}

const decoder = new TextDecoder("utf-8")

/** Deterministic JSON classification: card shapes beat lorebook shapes; a
 * JSON that is neither stays an asset the author can reclassify. */
export function classifyJson(parsed: unknown): PackItemKind {
  if (!isRecord(parsed)) return "asset"
  if (looksLikeLorecard(parsed)) return "card"
  if (parsed.spec === "chara_card_v2" || parsed.spec === "chara_card_v3") return "card"
  if (isRecord(parsed.data) && (asText(parsed.data.name) || parsed.data.character_book)) return "card"
  // A ROOT-level `entries` collection is the lorebook signature and beats the
  // loose card heuristic below: a stock SillyTavern world-info export carries
  // `{name, description, entries}`, and a card never holds entries at the root
  // (its lore lives under `character_book`).
  if (Array.isArray(parsed.entries) || isRecord(parsed.entries)) return "lorebook"
  if (asText(parsed.name) && (parsed.description !== undefined || parsed.first_mes !== undefined)) {
    return "card"
  }
  if (parsed.entries !== undefined || parsed.character_book !== undefined) return "lorebook"
  return "asset"
}

function countLorebookEntries(parsed: unknown): number {
  if (!isRecord(parsed)) return 0
  let root: unknown = parsed
  if (isRecord(root) && root.entries === undefined) {
    const book = root.character_book ?? (isRecord(root.data) ? root.data.character_book : undefined)
    if (isRecord(book)) root = book
  }
  const entries = isRecord(root) ? root.entries : undefined
  if (Array.isArray(entries)) return entries.length
  if (isRecord(entries)) return Object.keys(entries).length
  return 0
}

/** Parse InitVar entries the engine way (decorators off, JSON5-lite parse,
 * later entries fill only missing keys) and flatten for promotion. */
export function initvarLeaves(entries: Record<string, unknown>[]): {
  leaves: MvuLeaf[]
  truncated: boolean
} {
  const merged: Record<string, unknown> = {}
  const mergeMissing = (target: Record<string, unknown>, incoming: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(incoming)) {
      if (!(key in target)) target[key] = value
      else if (isRecord(target[key]) && isRecord(value)) {
        mergeMissing(target[key] as Record<string, unknown>, value)
      }
    }
  }
  for (const entry of entries) {
    const body = splitDecorators(asText(entry.content)).body
    const tree = parseInitvar(body)
    if (tree !== null) mergeMissing(merged, tree)
  }
  return flattenLeaves(merged)
}

async function itemFromFile(file: PickedFile): Promise<PackItem> {
  const base = {
    uid: uid(),
    sourceName: file.name,
    base64: bytesToBase64(file.bytes),
    jsonText: null as string | null,
    card: null as StCharacterCard | null,
    payloads: null as WorldPayloads | null,
    cardKind: "character" as const,
    hooks: [] as string[],
    leaves: [] as MvuLeaf[],
    leavesTruncated: false,
    drafts: [] as PromotionDraft[],
    extractSkill: false,
    notesEn: "",
    notesZh: "",
    entryCount: 0,
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
    if (kind === "card" && isRecord(parsed) && looksLikeLorecard(parsed)) {
      // Native bundle: the M14 parser, not the ST one — and keep the
      // `.lorecard.json` double suffix the ecosystem recognizes.
      const bareStem = stem.toLowerCase().endsWith(".lorecard") ? stem.slice(0, -".lorecard".length) : stem
      return lorecardItem(base, parsed, jsonText, `${safeFileName(bareStem, "card")}.lorecard.json`)
    }
    if (kind === "card") {
      return await cardItem(base, file, jsonText, `${safeFileName(stem, "card")}.json`)
    }
    if (kind === "lorebook") {
      return {
        ...base,
        kind: "lorebook",
        jsonText,
        fileName: `${safeFileName(stem, "lorebook")}.json`,
        entryCount: countLorebookEntries(parsed),
      }
    }
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

/** Native bundle → pack item: same split/promotion machinery, native parser. */
function lorecardItem(
  base: Omit<PackItem, "kind" | "fileName">,
  parsed: Record<string, unknown>,
  jsonText: string,
  fileName: string,
): PackItem {
  const item = splitIntoItem(base, lorecardToCard(parsed).card, jsonText, fileName)
  // `core/pack.py:644-652`: typed `variables` specs are the native flavor of
  // variable declarations — the engine folds them into the world-payload
  // count, so a specs-only lorecard detects as `world`. They live on the
  // bundle (not the embedded card), which is why the fold happens here rather
  // than in `cardSplit.detectWorldPayloads`.
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
  const { leaves, truncated } = initvarLeaves(split.initvarEntries)
  const isWorld = payloadsAny(split.payloads)
  return {
    ...base,
    kind: "card",
    fileName,
    jsonText,
    card,
    payloads: split.payloads,
    cardKind: isWorld ? "world" : "character",
    hooks: split.hooks,
    leaves,
    leavesTruncated: truncated,
    drafts: promoteLeaves(leaves),
  }
}

interface PackState {
  step: PackStep
  items: PackItem[]
  metadata: PackMetadataForm
  loadError: string | null

  /** M15 module-UI panels: `ui/panels.yaml` + the panel files it references. */
  panels: PackPanelsDraft | null
  /** M19 presentation kit (演出资料包): the Stage Director's creative brief.
   * Null = the pack ships no kit and the Director never stages its rooms. */
  presentation: PackPresentationDraft | null
  /** Hand-authored skills (full SKILL.md + optional hooks.js), alongside the
   * ones extracted from cards. */
  manualSkills: PackSkillDraft[]

  outputDir: string | null
  writtenDir: string | null
  candidates: EngineCandidate[]
  selectedCandidate: number
  installAfterBuild: boolean
  running: boolean
  runResult: EngineRunResult | null
  /** Parsed `--pack --json` success object (drives the native trust card). */
  packResult: PackBuildSuccess | null
  builtPackPath: string | null

  setStep: (step: PackStep) => void
  addFiles: (files: PickedFile[]) => Promise<void>
  removeItem: (uid: string) => void
  updateItem: (uid: string, patch: Partial<PackItem>) => void
  updateDraft: (itemUid: string, draftUid: string, patch: Partial<PromotionDraft>) => void
  setMetadata: (patch: Partial<PackMetadataForm>) => void
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
  addManualSkill: () => void
  updateManualSkill: (index: number, patch: Partial<PackSkillDraft>) => void
  removeManualSkill: (index: number) => void
  seedFromSplit: (item: PackItem, notesZh: string, notesEn: string) => void
  setOutputDir: (dir: string | null) => void
  setWritten: (dir: string | null) => void
  setCandidates: (candidates: EngineCandidate[]) => void
  setSelectedCandidate: (index: number) => void
  setInstallAfterBuild: (value: boolean) => void
  setRunning: (running: boolean) => void
  setRunResult: (result: EngineRunResult | null) => void
  setPackResult: (result: PackBuildSuccess | null) => void
  setBuiltPackPath: (path: string | null) => void
  reset: () => void
}

/** Panel files that ride as UTF-8 text (readable diffs); the rest go base64. */
const PANEL_TEXT_EXTENSIONS = new Set(["html", "htm", "js", "css", "svg", "json", "yaml", "yml", "txt", "md"])

function panelFileFromPicked(file: PickedFile, subdir: string): PackPanelFileDraft {
  const dir = subdir
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((part) => safeFileName(part, ""))
    .filter((part) => part.length > 0)
    .join("/")
  const path = `ui/${dir ? `${dir}/` : ""}${file.name}`
  const extension = /\.([^.]+)$/.exec(file.name.toLowerCase())?.[1] ?? ""
  if (PANEL_TEXT_EXTENSIONS.has(extension)) {
    return { path, contents: decoder.decode(file.bytes) }
  }
  return { path, base64: bytesToBase64(file.bytes) }
}

/** Pack file name for an uploaded kit media file: sanitized stem + original
 * (lowercased) extension — the same convention as dropped asset items. */
function kitMediaFileName(name: string, fallback: string): string {
  const stem = name.replace(/\.[^.]*$/, "")
  const extension = /\.([^.]+)$/.exec(name.toLowerCase())?.[1] ?? ""
  return `${safeFileName(stem, fallback)}${extension ? `.${extension}` : ""}`
}

function newPresentationDraft(): PackPresentationDraft {
  return {
    generation: "allow",
    // Empty = every performance shape allowed (`core/presentation.py`:
    // `allows_template`). Pre-ticking the boxes would emit an allowlist the
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

export const usePackStore = create<PackState>()((set) => ({
  step: "input",
  items: [],
  metadata: EMPTY_METADATA,
  loadError: null,
  panels: null,
  presentation: null,
  manualSkills: [],
  outputDir: null,
  writtenDir: null,
  candidates: [],
  selectedCandidate: 0,
  installAfterBuild: false,
  running: false,
  runResult: null,
  packResult: null,
  builtPackPath: null,

  setStep: (step) => set({ step }),

  addFiles: async (files) => {
    const items: PackItem[] = []
    let loadError: string | null = null
    for (const file of files) {
      try {
        items.push(await itemFromFile(file))
      } catch (error) {
        loadError = `${file.name}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    set((state) => ({ items: [...state.items, ...items], loadError }))
  },

  removeItem: (uid) => set((state) => ({ items: state.items.filter((item) => item.uid !== uid) })),

  updateItem: (uid, patch) =>
    set((state) => ({
      items: state.items.map((item) => {
        if (item.uid !== uid) return item
        const next = { ...item, ...patch }
        // Manifest v2: `kind` is DETECTED, never declared — pin the stored
        // kind to the detection result on every edit, in both directions.
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

  setPanelsYaml: (yamlText) => set((state) => ({ panels: { yamlText, files: state.panels?.files ?? [] } })),

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
    set((state) =>
      state.panels === null
        ? {}
        : { panels: { ...state.panels, files: state.panels.files.filter((file) => file.path !== path) } },
    ),

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
    set((state) =>
      state.presentation === null
        ? {}
        : {
            presentation: {
              ...state.presentation,
              subjects: state.presentation.subjects.filter((subject) => subject.uid !== subjectUid),
            },
          },
    ),

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
              audio: state.presentation.audio.map((cue) => (cue.uid === cueUid ? { ...cue, ...patch } : cue)),
            },
          },
    ),

  removePresentationCue: (cueUid) =>
    set((state) =>
      state.presentation === null
        ? {}
        : {
            presentation: {
              ...state.presentation,
              audio: state.presentation.audio.filter((cue) => cue.uid !== cueUid),
            },
          },
    ),

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
        { slug: "", nameEn: "", descriptionEn: "", descriptionZh: "", hooks: [], skillMd: "" },
      ],
    })),

  updateManualSkill: (index, patch) =>
    set((state) => ({
      manualSkills: state.manualSkills.map((skill, i) => (i === index ? { ...skill, ...patch } : skill)),
    })),

  removeManualSkill: (index) =>
    set((state) => ({ manualSkills: state.manualSkills.filter((_, i) => i !== index) })),

  seedFromSplit: (item, notesZh, notesEn) =>
    set({
      step: "metadata",
      items: [{ ...item, notesZh, notesEn }],
      metadata: { ...EMPTY_METADATA },
      panels: null,
      presentation: null,
      manualSkills: [],
      writtenDir: null,
      runResult: null,
      packResult: null,
      builtPackPath: null,
    }),

  setOutputDir: (outputDir) => set({ outputDir }),
  setWritten: (writtenDir) => set({ writtenDir }),
  setCandidates: (candidates) => set({ candidates, selectedCandidate: 0 }),
  setSelectedCandidate: (selectedCandidate) => set({ selectedCandidate }),
  setInstallAfterBuild: (installAfterBuild) => set({ installAfterBuild }),
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
      panels: null,
      presentation: null,
      manualSkills: [],
      outputDir: null,
      writtenDir: null,
      runResult: null,
      packResult: null,
      builtPackPath: null,
      running: false,
      installAfterBuild: false,
    }),
}))

/** Suggested `.var expose` lines across every world card in the pack. */
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

/** Assemble the WorldPackDraft for validation + source-tree planning. */
export function buildDraftFromState(
  items: PackItem[],
  metadata: PackMetadataForm,
  panels: PackPanelsDraft | null = null,
  manualSkills: PackSkillDraft[] = [],
  presentation: PackPresentationDraft | null = null,
): WorldPackDraft {
  const cards = items
    .filter((item) => item.kind === "card")
    .map((item) => ({
      fileName: item.fileName,
      jsonText:
        item.extractSkill && item.jsonText !== null ? withoutHooksJson(item) : (item.jsonText ?? undefined),
      base64: item.jsonText === null ? item.base64 : undefined,
      notesEn: item.notesEn,
      notesZh: item.notesZh,
    }))
  const skills = items
    .filter((item) => item.kind === "card" && item.extractSkill && item.hooks.length > 0)
    .map((item) => ({
      slug: skillSlug(item),
      nameEn: `${item.card?.name ?? item.fileName} hooks`,
      descriptionEn: `Room hooks extracted from ${item.card?.name ?? item.fileName}.`,
      descriptionZh: `从「${item.card?.name ?? item.fileName}」抽取的房间 hooks。`,
      hooks: item.hooks,
    }))
  const rulepacks = metadata.rulepackPatch.trim()
    ? [
        {
          // The file stem IS the system id (`.set <id>`), so the author owns it.
          id: metadata.rulepackId.trim() || `${metadata.id}-rules`,
          yamlText: metadata.rulepackPatch,
        },
      ]
    : []
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
    lorebooks: items
      .filter((item) => item.kind === "lorebook" && item.jsonText !== null)
      .map((item) => ({ fileName: item.fileName, jsonText: item.jsonText ?? "" })),
    skills: [...skills, ...manualSkills],
    rulepacks,
    assets: items
      .filter((item) => item.kind === "asset")
      .map((item) => ({ fileName: item.fileName, base64: item.base64 })),
    panels: panels !== null && panels.yamlText.trim() ? panels : null,
    presentation,
  }
}

function skillSlug(item: PackItem): string {
  const base = safeFileName(item.card?.name ?? item.fileName, "hooks")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return base ? `${base}-hooks` : "card-hooks"
}

/** For "extract hooks to a skill": re-emit the JSON card with the hooks
 * extension removed so the same scripts don't install twice. The character
 * half's `raw` is exactly the original card minus the hooks extension (prose
 * and InitVar payloads untouched), so serializing it is the whole job. */
function withoutHooksJson(item: PackItem): string {
  if (item.jsonText === null || item.card === null) return item.jsonText ?? ""
  return JSON.stringify(splitCard(item.card).character.raw, null, 2)
}

export function packValidationIssues(
  items: PackItem[],
  metadata: PackMetadataForm,
  panels: PackPanelsDraft | null = null,
  manualSkills: PackSkillDraft[] = [],
  presentation: PackPresentationDraft | null = null,
): Issue[] {
  return validatePackDraft(buildDraftFromState(items, metadata, panels, manualSkills, presentation))
}
