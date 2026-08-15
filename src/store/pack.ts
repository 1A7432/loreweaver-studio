// The auto-import pipeline (③): drop files → deterministic classify + split →
// promotion drafts → (AI-drafted, human-confirmed) metadata → source tree →
// the ENGINE builds/installs. Every step is inspectable and editable — the
// pipeline is a wizard, not a black box.
//
// The session PERSISTS. It used to say "nothing here persists: it is a working
// session over files the user just dropped" — which was true, and which meant a
// tab switch threw away every classification, promotion decision, metadata field
// and panel the author had typed. What cannot survive is raw BYTES: a dropped
// PNG or MP3 would be megabytes of localStorage, so binary payloads are dropped
// on write and the item comes back flagged `needsBytes`. Everything the author
// typed or decided survives; the file itself is asked for again, and the build
// is blocked until it is (`packItemNeedsBytes`) rather than shipping an empty
// file under the right name.

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
  type PackPanelFileDraft,
  type PackPanelsDraft,
  type PackPresentationAudioDraft,
  type PackPresentationDraft,
  type PackPrepScriptDraft,
  type PackPresetDraft,
  type PackPresentationSubjectDraft,
  type PackSkillDraft,
  type WorldPackDraft,
} from "../features/studio/split/packSource"
import { countVariableSpecs, looksLikeLorecard, lorecardToCard } from "../features/studio/split/lorecard"
import { readRulepack } from "../features/studio/split/rulepack"
import type { PackEpisode } from "../features/studio/split/episodes"
import type { PackBuildSuccess } from "../features/studio/pack/buildResult"
import type { Issue } from "../features/studio/model"
import { bytesToBase64, type EngineCandidate, type EngineRunResult, type PickedFile } from "../lib/native"
import { useUndoStore } from "./undo"

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
  /** Byte size of the dropped file, kept so a restored item can be recognized
   * (and a re-attach compared) after `base64` is gone. */
  size: number
  /** True when a persisted session came back without this item's bytes. Every
   * edit survived; the file itself has to be handed over again. */
  needsBytes: boolean

  // --- card-only fields ---
  card: StCharacterCard | null
  payloads: WorldPayloads | null
  cardKind: "character" | "world"
  hooks: string[]
  leaves: MvuLeaf[]
  leavesTruncated: boolean
  /** `[InitVar]` blocks that did not parse — the card still imported. */
  initvarProblems: Issue[]
  /** Serialized-module tag: the episode this file belongs to ("" = evergreen /
   * episode 1). A build "up to episode N" leaves later ones out entirely. */
  episode: string
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
  /** `patch` = an `extends:` over a built-in system (what the bench has always
   * offered); `full` = a whole rule system authored here. Both emit the same
   * `rulepacks/<id>.yaml`; the mode changes the editor and the advice, not the
   * artifact — `core/rulepacks.py` does not distinguish them either. */
  rulepackMode: "patch" | "full"
  /** The rules script (stage E) shipped beside the YAML, when it declares one.
   * `core/pack.py::_rulepack_script_files` reads the name off `resolution.script`
   * / `subsystems.*.script` and reads the file from NEXT TO the YAML, so the
   * name here is a bare file name and the source is its whole contents. Without
   * this pair, a YAML naming a script builds into a pack that cannot load. */
  rulepackScriptName: string
  rulepackScriptSource: string
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
  rulepackScriptName: "",
  rulepackScriptSource: "",
}

/** The starter a new prep script opens with. Real, runnable, and small enough
 * to read in one glance — the shape `docs/plugins.md` §C.3 documents, with the
 * one rule that matters stated in it: `plan()` is the only callable. */
// i18n-exempt: emitted JavaScript, read by the author's editor and the engine.
const PREP_SCRIPT_TEMPLATE = `// Prep-phase plan script. \`plan(tool, args)\` is the ONLY callable: this file
// PLANS work, the engine applies it, and a keeper previews the whole plan first.
// Prep phase only; keeper commands (.import … world, .var expose) are commands,
// not tools, so a plan can never name one.

const guards = ["门房老周", "巡夜的李七"]
for (const name of guards) {
  plan("add_npc", { name: name, concept: "夜里见过五层的人" })
}

plan("define_variable", { var_id: "floor_seen", kind: "number", minimum: 0, maximum: 3 })
`

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
 * later entries fill only missing keys) and flatten for promotion.
 *
 * `problems` reports the blocks that did NOT parse. The pipeline deliberately
 * carries on without them — one broken block should not cost the author the
 * whole card — but silently dropping a variable tree is how an author ends up
 * wondering where their meters went. */
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
      else if (isRecord(target[key]) && isRecord(value)) {
        mergeMissing(target[key] as Record<string, unknown>, value)
      }
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
  const { leaves, truncated, problems } = initvarLeaves(split.initvarEntries)
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

  /** M15 module-UI panels: `ui/panels.yaml` + the panel files it references. */
  panels: PackPanelsDraft | null
  /** M19 presentation kit (演出资料包): the Stage Director's creative brief.
   * Null = the pack ships no kit and the Director never stages its rooms. */
  presentation: PackPresentationDraft | null
  /** Serialized installments (连载模组). Empty = an ordinary one-shot pack. */
  episodes: PackEpisode[]
  /** Build up to this ordinal; 0 = the latest episode there is. */
  buildUpTo: number
  /** Hand-authored skills (full SKILL.md + optional hooks.js), alongside the
   * ones extracted from cards. */
  manualSkills: PackSkillDraft[]
  /** M20 F prep-phase plan scripts (`contents.prep`). They never run at
   * install; a keeper invokes one by reference and previews the plan first. */
  prepScripts: PackPrepScriptDraft[]
  /** Keeper-style prompt presets (`contents.presets`). Install lands them in
   * the SHARED store; a room folds one in only on `.preset enable <id>`. */
  packPresets: PackPresetDraft[]

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
  /** Where the last install landed. Not the cwd, and worth saying so — every
   * install path targets the LOCAL SERVER's data dir (`lib/packInstall.ts`). */
  installedTo: string | null

  setStep: (step: PackStep) => void
  addFiles: (files: PickedFile[]) => Promise<void>
  /** Hand back the bytes of an item a reload restored without them. */
  reattachItem: (uid: string, file: PickedFile) => void
  /** Same, for a tier-2 panel's binary file. */
  reattachPanelFile: (path: string, file: PickedFile) => void
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
  addEpisode: () => void
  updateEpisode: (id: string, patch: Partial<PackEpisode>) => void
  removeEpisode: (id: string) => void
  setBuildUpTo: (upTo: number) => void
  addManualSkill: () => void
  updateManualSkill: (index: number, patch: Partial<PackSkillDraft>) => void
  removeManualSkill: (index: number) => void
  /** Ship one of the studio's imported presets with the pack. */
  addPackPreset: (preset: PackPresetDraft) => void
  updatePackPreset: (index: number, patch: Partial<PackPresetDraft>) => void
  removePackPreset: (index: number) => void
  addPrepScript: () => void
  updatePrepScript: (index: number, patch: Partial<PackPrepScriptDraft>) => void
  removePrepScript: (index: number) => void
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
  setInstalledTo: (dir: string | null) => void
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

export const usePackStore = create<PackState>()(
  persist(
    (set) => ({
      step: "input",
      items: [],
      metadata: EMPTY_METADATA,
      loadError: null,
      panels: null,
      presentation: null,
      manualSkills: [],
      prepScripts: [],
      packPresets: [],
      episodes: [],
      buildUpTo: 0,
      outputDir: null,
      writtenDir: null,
      candidates: [],
      selectedCandidate: 0,
      installAfterBuild: false,
      running: false,
      runResult: null,
      packResult: null,
      builtPackPath: null,
      installedTo: null,

      setStep: (step) => set({ step }),

      addFiles: async (files) => {
        const items: PackItem[] = []
        let loadError: Issue | null = null
        for (const file of files) {
          try {
            items.push(await itemFromFile(file))
          } catch (error) {
            loadError = describeImportFailure(error, file.name)
          }
        }
        set((state) => ({ items: [...state.items, ...items], loadError }))
      },

      reattachItem: (uid, file) =>
        set((state) => ({
          items: state.items.map((item) =>
            item.uid === uid
              ? {
                  ...item,
                  base64: bytesToBase64(file.bytes),
                  size: file.bytes.length,
                  needsBytes: false,
                }
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
            // Restored at its original index: the item order is the order the
            // author dropped and then reasoned about.
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
            { slug: "", nameEn: "", descriptionEn: "", descriptionZh: "", hooks: [], skillMd: "" },
          ],
        })),

      updateManualSkill: (index, patch) =>
        set((state) => ({
          manualSkills: state.manualSkills.map((skill, i) => (i === index ? { ...skill, ...patch } : skill)),
        })),

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
              set((s) => ({
                episodes: [...s.episodes.slice(0, index), removed, ...s.episodes.slice(index)],
              }))
            })
          }
          // Content tagged to it is deliberately left tagged: the tag now
          // resolves to nothing, the lint says so, and the build INCLUDES it —
          // deleting an episode must never silently delete an author's work.
          return { episodes: state.episodes.filter((episode) => episode.id !== id) }
        }),

      setBuildUpTo: (buildUpTo) => set({ buildUpTo: Math.max(0, Math.trunc(buildUpTo)) }),

      addPackPreset: (preset) =>
        set((state) =>
          // A pack ships one file per store id; adding the same preset twice
          // would collide in `data_dir/presets/` and fail the engine's build.
          state.packPresets.some((existing) => existing.fileName === preset.fileName)
            ? {}
            : { packPresets: [...state.packPresets, preset] },
        ),

      updatePackPreset: (index, patch) =>
        set((state) => ({
          packPresets: state.packPresets.map((preset, i) => (i === index ? { ...preset, ...patch } : preset)),
        })),

      removePackPreset: (index) =>
        set((state) => {
          const removed = state.packPresets[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("preset", removed.fileName, () => {
              set((s) => ({
                packPresets: [...s.packPresets.slice(0, index), removed, ...s.packPresets.slice(index)],
              }))
            })
          }
          return { packPresets: state.packPresets.filter((_, i) => i !== index) }
        }),

      addPrepScript: () =>
        set((state) => ({
          prepScripts: [
            ...state.prepScripts,
            {
              fileName: `setup${state.prepScripts.length > 0 ? state.prepScripts.length + 1 : ""}.js`,
              source: PREP_SCRIPT_TEMPLATE,
            },
          ],
        })),

      updatePrepScript: (index, patch) =>
        set((state) => ({
          prepScripts: state.prepScripts.map((script, i) => (i === index ? { ...script, ...patch } : script)),
        })),

      removePrepScript: (index) =>
        set((state) => {
          const removed = state.prepScripts[index]
          if (removed !== undefined) {
            useUndoStore.getState().push("prepScript", removed.fileName, () => {
              set((s) => ({
                prepScripts: [...s.prepScripts.slice(0, index), removed, ...s.prepScripts.slice(index)],
              }))
            })
          }
          return { prepScripts: state.prepScripts.filter((_, i) => i !== index) }
        }),

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

      seedFromSplit: (item, notesZh, notesEn) =>
        set({
          step: "metadata",
          items: [{ ...item, notesZh, notesEn }],
          metadata: { ...EMPTY_METADATA },
          panels: null,
          presentation: null,
          manualSkills: [],
          prepScripts: [],
          packPresets: [],
          episodes: [],
          buildUpTo: 0,
          writtenDir: null,
          runResult: null,
          packResult: null,
          builtPackPath: null,
          installedTo: null,
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
      setInstalledTo: (installedTo) => set({ installedTo }),

      reset: () =>
        set({
          step: "input",
          items: [],
          metadata: EMPTY_METADATA,
          loadError: null,
          panels: null,
          presentation: null,
          manualSkills: [],
          prepScripts: [],
          packPresets: [],
          episodes: [],
          buildUpTo: 0,
          outputDir: null,
          writtenDir: null,
          runResult: null,
          packResult: null,
          builtPackPath: null,
          installedTo: null,
          running: false,
          installAfterBuild: false,
        }),
    }),
    {
      name: "loreweaver-studio-pack",
      // Guarded: `persist` writes synchronously inside `set`, on every
      // keystroke, so a quota error here would abort the edit that caused it.
      // See `lib/persistStorage.ts`.
      storage: guardedLocalStorage,
      version: 1,
      // The metadata form is ONE persisted object, so zustand's shallow merge
      // replaces it wholesale — a blob written before a field existed comes
      // back missing that field, and the first `.trim()` on it throws. Filling
      // from the defaults is what makes adding a field to the form safe.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<PackState>
        return {
          ...current,
          ...saved,
          metadata: { ...EMPTY_METADATA, ...(saved.metadata ?? {}) },
        }
      },
      // What survives: every classification, promotion decision, metadata
      // field, panel, kit entry and the paths the build already used. What does
      // not: raw bytes (dropped, flagged for re-attach), the engine probe and
      // the last run's terminal output — all cheap to redo, and the terminal
      // capture can be a quarter-megabyte on its own.
      partialize: (state) => ({
        step: state.step,
        items: state.items.map((item) => ({
          ...item,
          base64: item.jsonText === null && item.base64 !== "" ? "" : item.base64,
          needsBytes: item.jsonText === null && item.base64 !== "",
        })),
        metadata: state.metadata,
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
        prepScripts: state.prepScripts,
        packPresets: state.packPresets,
        episodes: state.episodes,
        buildUpTo: state.buildUpTo,
        outputDir: state.outputDir,
        writtenDir: state.writtenDir,
        installAfterBuild: state.installAfterBuild,
        packResult: state.packResult,
        builtPackPath: state.builtPackPath,
      }),
    },
  ),
)

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
  prep: PackPrepScriptDraft[] = [],
  episodes: PackEpisode[] = [],
  buildUpTo = 0,
  presets: PackPresetDraft[] = [],
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
      episode: item.episode,
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
  // A rules script ships only when the YAML actually declares one: the engine
  // reads the name off `resolution.script` / `subsystems.*.script` and would
  // reject an orphan file, and a declared-but-absent script fails the build.
  // Ship it under the name the YAML asked for, whatever the field says.
  const declaredScript = readRulepack(metadata.rulepackPatch).summary.scripts[0]
  const scripts =
    declaredScript !== undefined && metadata.rulepackScriptSource.trim()
      ? [{ fileName: declaredScript, source: metadata.rulepackScriptSource }]
      : []
  const rulepacks = metadata.rulepackPatch.trim()
    ? [
        {
          // The file stem IS the system id (`.set <id>`), so the author owns it.
          id: metadata.rulepackId.trim() || `${metadata.id}-rules`,
          yamlText: metadata.rulepackPatch,
          scripts,
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
      .map((item) => ({ fileName: item.fileName, jsonText: item.jsonText ?? "", episode: item.episode })),
    skills: [...skills, ...manualSkills],
    rulepacks,
    assets: items
      .filter((item) => item.kind === "asset")
      .map((item) => ({ fileName: item.fileName, base64: item.base64, episode: item.episode })),
    prep,
    presets,
    panels: panels !== null && panels.yamlText.trim() ? panels : null,
    presentation,
    episodes,
    buildUpTo,
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
  prep: PackPrepScriptDraft[] = [],
  episodes: PackEpisode[] = [],
  buildUpTo = 0,
  presets: PackPresetDraft[] = [],
): Issue[] {
  // A restored session knows an item's name, kind and every decision made about
  // it, but not its bytes. Building anyway would write an empty file under a
  // name that promises content — so this blocks, and the review step offers the
  // re-attach.
  const missing = items
    .filter((item) => item.needsBytes)
    .map((item) => ({ key: "packItemNeedsBytes", params: { file: item.fileName } }))
  return [
    ...missing,
    ...validatePackDraft(
      buildDraftFromState(
        items,
        metadata,
        panels,
        manualSkills,
        presentation,
        prep,
        episodes,
        buildUpTo,
        presets,
      ),
    ),
  ]
}
