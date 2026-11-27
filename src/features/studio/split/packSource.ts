// The pack draft → a pack SOURCE tree for the 3.0 engine (`docs/lwf/formats/pack.md`,
// manifest 3, in the engine repository). The studio deliberately does NOT zip anything:
// validation, bundling and byte-determinism have exactly one source of truth — the
// engine's builder (`loreweaver pack <dir> --out <file>`). This module only plans the tree
// (pack.yaml, cards, skills, rule-pack patches, module sources, panels, the presentation
// kit and its media) that the builder then turns into a `.lwpack`.
//
// What 3.0 refuses is not here at all: no lorebooks (lore rides inside a card), no prompt
// presets, no prep scripts, no rules scripts beside a rule pack, no `skills/<id>/hooks.js`.
// Code is a MODULE: a TypeScript or JavaScript entry under `src/`, declared in the manifest,
// bundled by the builder (`docs/lwf/formats/pack.md` §3).

import { stringify } from "yaml"
import {
  buildChangelog,
  filterEpisodeContent,
  includedInBuild,
  latestOrdinal,
  type EpisodeTagged,
  type PackEpisode,
} from "./episodes"
import { checkPackPath, checkPanelsText } from "../pack/panelsCheck"
import { readRulepack } from "./rulepack"
import type { Issue } from "../model"

/** `server/src/core/packs/manifest.ts`. */
export const MANIFEST_VERSION = 3
/** The wire protocol a Studio-written pack needs at least (`engine.protocol`). */
export const ENGINE_PROTOCOL = "3.0"
export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/
/** A rule system's id: its file's stem (`server/src/core/rulepacks/compile.ts`). */
export const RULE_SYSTEM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
/** A skill's id: its directory's name (`server/src/core/skills/parse.ts`). */
export const SKILL_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
/** A module's id: the prefix of its commands and views, `<id>/<name>`. */
export const MODULE_ID_RE = /^[a-z][a-z0-9_]{0,63}$/
export const MAX_MODULES = 16
/** Entries per content kind. */
export const MAX_KIND_ENTRIES = 64
export const MAX_ASSETS = 512
/** A module source's extensions in a source tree (`MODULE_SOURCE_EXTENSIONS`). */
export const MODULE_SOURCE_EXTENSIONS = [".ts", ".mts", ".tsx", ".js", ".mjs", ".jsx"] as const
/** Where module sources live in the tree. */
export const MODULE_DIR = "src"
const MAX_NOTE_CHARS = 2_000
const MAX_TEXT_CHARS = 2_000
const MAX_LICENSE_CHARS = 200
const MAX_AUTHOR_CHARS = 200
const MAX_AUTHORS = 32

export const PANELS_FILE_NAME = "ui/panels.yaml"
/** Code a pack may not carry outside its module entries (`SCRIPT_EXTENSIONS`). */
const SCRIPT_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".tsx",
  ".jsx",
  ".wasm",
  ".node",
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
]

// The presentation kit (演出资料包), mirroring `server/src/core/presentation/kit.ts` — the
// engine re-parses the emitted file at build, so these enums and caps are copied from it.
export const PRESENTATION_FILE_NAME = "ui/presentation.yaml"
/** `KIT_VERSION`: a v1 kit is refused outright. */
export const PRESENTATION_KIT_VERSION = 2
const MAX_PRESENTATION_FILE_BYTES = 128 * 1024
const MAX_PRESENTATION_SUBJECTS = 64
const MAX_PRESENTATION_AUDIO = 32
const MAX_PRESENTATION_BANNED = 24
const MAX_PRESENTATION_TEXT_CHARS = 400
const MAX_PRESENTATION_PROMPT_CHARS = 1_000
const MAX_PRESENTATION_PALETTE = 8
const MAX_PRESENTATION_PALETTE_CHARS = 80
export const PRESENTATION_GENERATION_MODES = ["allow", "pack_only"] as const
export const PRESENTATION_SUBJECT_KINDS = ["npc", "location", "item"] as const
export const PRESENTATION_AUDIO_LAYERS = ["bgm", "ambience", "sfx"] as const
/** `TEMPLATE_KINDS`. An EMPTY list means all of them, so the wizard never pre-ticks every box. */
export const PRESENTATION_TEMPLATE_KINDS = ["image", "title_card", "letter", "clipping", "text"] as const
/** The asset types a pack may ship, by extension (`ASSET_MIME_BY_EXTENSION`). */
export const PRESENTATION_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg"] as const
export const PRESENTATION_AUDIO_EXTENSIONS = [
  "mp3",
  "ogg",
  "oga",
  "opus",
  "wav",
  "flac",
  "m4a",
  "aac",
] as const
const ASSET_EXTENSIONS: readonly string[] = [
  ...PRESENTATION_IMAGE_EXTENSIONS,
  ...PRESENTATION_AUDIO_EXTENSIONS,
]

export type CardKind = "world" | "character"

export interface PackCardDraft extends EpisodeTagged {
  /** File name under `cards/` (already sanitized, extension included). */
  fileName: string
  /** Exactly one of these: JSON card text, or original PNG bytes. */
  jsonText?: string
  base64?: string
  /** What the card is, as Studio detected it. Written as `kind:`; the engine checks it
   * against the card itself and refuses the pack on a mismatch (`card_kind_mismatch`). */
  kind: CardKind
  /** Notes for the room admin. */
  notesEn: string
  notesZh: string
}

export interface PackSkillDraft {
  slug: string
  nameEn: string
  descriptionEn: string
  descriptionZh: string
  /** Hand-written SKILL.md (frontmatter included). When set it ships VERBATIM instead of the
   * generated stub — real keeper skills carry prompt sections, not just a description. */
  skillMd?: string
}

/** One module: content code the builder bundles (`docs/lwf/formats/pack.md` §3). Studio
 * writes the source the author gave it and declares it; it does not type-check or run it. */
export interface PackModuleDraft {
  uid: string
  /** MUST equal the id the module passes to `defineModule`. */
  id: string
  /** The entry file's name under `src/`. */
  fileName: string
  source: string
}

/** One file a panel names (a page's HTML, a picture), at its pack path under `ui/`. */
export interface PackPanelFileDraft {
  path: string
  /** Exactly one of these: UTF-8 text (an HTML page) or raw bytes. */
  contents?: string
  base64?: string
}

/** The pack's panels: `ui/panels.yaml` + every file it names. */
export interface PackPanelsDraft {
  yamlText: string
  files: PackPanelFileDraft[]
}

/** One picturable subject. An empty ref is LEGAL: nameable, never generated. */
export interface PackPresentationSubjectDraft {
  uid: string
  id: string
  kind: string
  nameEn: string
  nameZh: string
  /** Basename under `assets/` + bytes; both empty = no reference image. */
  refFileName: string
  refBase64: string
  prompt: string
}

/** One audio cue, bound to a pack sound. */
export interface PackPresentationAudioDraft {
  uid: string
  id: string
  layer: string
  /** Basename under `assets/` + bytes; a cue without its file is invalid. */
  assetFileName: string
  assetBase64: string
  title: string
}

/** The presentation kit: `ui/presentation.yaml` + its media files. */
export interface PackPresentationDraft {
  generation: string
  /** `templates`: EMPTY means every shape is allowed. */
  templates: string[]
  keywordsEn: string
  keywordsZh: string
  /** Banned elements, one per line. */
  bannedText: string
  /** `style.palette`: hex codes or colour words, one per line. */
  paletteText: string
  subjects: PackPresentationSubjectDraft[]
  audio: PackPresentationAudioDraft[]
}

export interface PackRulepackDraft {
  /** Becomes `rulepacks/<id>.yaml`; the id is the rule system's. */
  id: string
  yamlText: string
}

/** One media asset (a picture or a sound). */
export interface PackAssetDraft extends EpisodeTagged {
  fileName: string
  base64: string
}

export interface WorldPackDraft {
  id: string
  version: string
  nameEn: string
  nameZh: string
  descriptionEn: string
  descriptionZh: string
  authors: string[]
  license: string
  cards: PackCardDraft[]
  skills: PackSkillDraft[]
  rulepacks: PackRulepackDraft[]
  modules: PackModuleDraft[]
  assets: PackAssetDraft[]
  /** Panels; null when the pack ships none. */
  panels: PackPanelsDraft | null
  /** The presentation kit; null when the pack ships none. */
  presentation: PackPresentationDraft | null
  /** Serialized installments. Empty = an ordinary one-shot pack. */
  episodes: PackEpisode[]
  /** Build up to this episode ordinal; 0 (or absent) means "everything". */
  buildUpTo?: number
}

export interface PackTextFile {
  path: string
  contents: string
}

export interface PackBinaryFile {
  path: string
  base64: string
}

export interface PackSourcePlan {
  /** Suggested directory name for the source tree (= the pack id). */
  dirName: string
  files: PackTextFile[]
  binaries: PackBinaryFile[]
}

export function safeFileName(raw: string, fallback: string): string {
  const base = raw
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
  return base || fallback
}

/** Text counted in code points, as the engine counts it. */
function charCount(text: string): number {
  return Array.from(text).length
}

function extensionOf(path: string): string {
  const name = path.split("/").at(-1) ?? ""
  const dot = name.lastIndexOf(".")
  return dot <= 0 ? "" : name.slice(dot).toLowerCase()
}

/** Where an author reads how to write a module (the engine's module SDK guide). */
export const SDK_GUIDE_URL = "https://github.com/1A7432/loreweaver/blob/v3/sdk/README.md"

/** Whether a module's source names its id where `defineModule` takes it. Advisory: Studio
 * does not parse TypeScript, so this only catches the plain mismatch. */
export function moduleIdMentioned(source: string, id: string): boolean {
  if (!id) return true
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\bid\\s*:\\s*["'\`]${escaped}["'\`]`).test(source)
}

/** The module entry's pack path. */
export function moduleEntryPath(module: Pick<PackModuleDraft, "fileName">): string {
  return `${MODULE_DIR}/${module.fileName.trim()}`
}

/** Author-side validation, mirroring what the engine's builder refuses — surfaced BEFORE
 * the build so the wizard goes red inline. The builder stays the authority. */
export function validatePackDraft(draft: WorldPackDraft): Issue[] {
  const issues: Issue[] = []
  if (!PACK_ID_RE.test(draft.id)) issues.push({ key: "packIdInvalid" })
  if (!SEMVER_RE.test(draft.version)) issues.push({ key: "packVersionInvalid" })
  if (!draft.nameEn.trim() && !draft.nameZh.trim()) issues.push({ key: "packNameRequired" })
  if (!draft.descriptionEn.trim() && !draft.descriptionZh.trim())
    issues.push({ key: "packDescriptionRequired" })
  for (const text of [draft.nameEn, draft.nameZh, draft.descriptionEn, draft.descriptionZh]) {
    if (charCount(text.trim()) > MAX_TEXT_CHARS) {
      issues.push({ key: "packTextTooLong", params: { max: MAX_TEXT_CHARS } })
      break
    }
  }
  if (!draft.license.trim()) issues.push({ key: "packLicenseRequired" })
  else if (charCount(draft.license.trim()) > MAX_LICENSE_CHARS) {
    issues.push({ key: "packLicenseTooLong", params: { max: MAX_LICENSE_CHARS } })
  }
  const authors = draft.authors.map((author) => author.trim()).filter(Boolean)
  if (authors.length === 0) issues.push({ key: "packAuthorsRequired" })
  if (authors.length > MAX_AUTHORS || authors.some((author) => charCount(author) > MAX_AUTHOR_CHARS)) {
    issues.push({ key: "packAuthorsTooMany", params: { max: MAX_AUTHORS, chars: MAX_AUTHOR_CHARS } })
  }

  // One file, one role: a path is named once (case-insensitively, as the engine compares).
  const seenFiles = new Set<string>()
  const claim = (path: string, from?: string) => {
    const key = path.normalize("NFC").toLowerCase()
    if (seenFiles.has(key))
      issues.push({ key: "packDuplicatePath", params: from ? { file: path, from } : { file: path } })
    seenFiles.add(key)
  }

  if (draft.cards.length > MAX_KIND_ENTRIES)
    issues.push({ key: "packTooManyEntries", params: { kind: "cards", max: MAX_KIND_ENTRIES } })
  for (const card of draft.cards) {
    if ((card.jsonText === undefined) === (card.base64 === undefined)) {
      issues.push({ key: "packCardBodyMissing", params: { file: card.fileName } })
    }
    if (charCount(card.notesEn) > MAX_NOTE_CHARS || charCount(card.notesZh) > MAX_NOTE_CHARS) {
      issues.push({ key: "packNotesTooLong", params: { file: card.fileName, max: MAX_NOTE_CHARS } })
    }
    const path = `cards/${card.fileName}`
    if (!/\.(png|json)$/i.test(card.fileName) || checkPackPath(path) !== null) {
      issues.push({ key: "packCardFileName", params: { file: card.fileName } })
    }
    claim(path)
  }

  if (draft.skills.length > MAX_KIND_ENTRIES)
    issues.push({ key: "packTooManyEntries", params: { kind: "skills", max: MAX_KIND_ENTRIES } })
  const seenSkillSlugs = new Set<string>()
  for (const skill of draft.skills) {
    if (!SKILL_ID_RE.test(skill.slug))
      issues.push({ key: "packSkillSlugInvalid", params: { file: skill.slug } })
    if (seenSkillSlugs.has(skill.slug))
      issues.push({ key: "packDuplicatePath", params: { file: `skills/${skill.slug}` } })
    seenSkillSlugs.add(skill.slug)
    claim(`skills/${skill.slug}/SKILL.md`)
    // A hand-written SKILL.md must open with YAML front matter or the engine refuses the pack.
    const custom = skill.skillMd?.trim()
    if (custom && !custom.startsWith("---"))
      issues.push({ key: "packSkillMdNoFrontmatter", params: { file: skill.slug } })
  }

  if (draft.rulepacks.length > MAX_KIND_ENTRIES) {
    issues.push({ key: "packTooManyEntries", params: { kind: "rulepacks", max: MAX_KIND_ENTRIES } })
  }
  for (const rulepack of draft.rulepacks) {
    if (!RULE_SYSTEM_ID_RE.test(rulepack.id))
      issues.push({ key: "packRulepackIdInvalid", params: { file: rulepack.id } })
    // A rule pack that needs the rules-script lane is refused: that lane is not part of 3.0.
    if (readRulepack(rulepack.yamlText).summary.scripts.length > 0) {
      issues.push({ key: "packRulepackScript", params: { file: rulepack.id } })
    }
    claim(`rulepacks/${rulepack.id}.yaml`)
  }

  if (draft.modules.length > MAX_MODULES)
    issues.push({ key: "packModulesTooMany", params: { max: MAX_MODULES } })
  const moduleIds = new Set<string>()
  for (const module of draft.modules) {
    const label = module.id || module.fileName || "?"
    if (!MODULE_ID_RE.test(module.id)) issues.push({ key: "packModuleIdInvalid", params: { id: label } })
    else if (moduleIds.has(module.id))
      issues.push({ key: "packModuleIdDuplicate", params: { id: module.id } })
    moduleIds.add(module.id)
    const fileName = module.fileName.trim()
    const path = moduleEntryPath(module)
    if (
      fileName.includes("/") ||
      !MODULE_SOURCE_EXTENSIONS.some((extension) => fileName.toLowerCase().endsWith(extension)) ||
      checkPackPath(path) !== null
    ) {
      issues.push({ key: "packModuleFileName", params: { id: label, file: fileName } })
    }
    if (!module.source.trim()) issues.push({ key: "packModuleEmpty", params: { id: label } })
    claim(path)
  }

  if (draft.assets.length > MAX_ASSETS) issues.push({ key: "packTooManyAssets", params: { max: MAX_ASSETS } })
  for (const asset of draft.assets) {
    const path = `assets/${asset.fileName}`
    // Anything but a picture or a sound is refused (`asset_type`).
    if (!ASSET_EXTENSIONS.includes(extensionOf(path).slice(1))) {
      issues.push({ key: "packAssetType", params: { file: path } })
    }
    claim(path)
  }
  if (draft.panels !== null) issues.push(...validatePanelsDraft(draft, seenFiles))
  if (draft.presentation !== null) issues.push(...validatePresentationDraft(draft.presentation, seenFiles))
  return issues
}

/** The panels file against the engine's reader (`panelsCheck.ts`), and the files it names
 * against what the pack ships: a page's HTML from the panel files, every picture from the
 * panel files, the dropped assets or the kit's media. */
function validatePanelsDraft(draft: WorldPackDraft, seenFiles: Set<string>): Issue[] {
  const panels = draft.panels as PackPanelsDraft
  const issues: Issue[] = []
  const filePaths = new Set<string>()
  for (const file of panels.files) {
    const path = file.path
    if (
      !path.startsWith("ui/") ||
      path === PANELS_FILE_NAME ||
      path === PRESENTATION_FILE_NAME ||
      checkPackPath(path) !== null
    ) {
      issues.push({ key: "packPanelPathInvalid", params: { file: path } })
      continue
    }
    // A page is ONE self-contained HTML file: a script beside it is code the pack may not carry.
    if (SCRIPT_EXTENSIONS.includes(extensionOf(path))) {
      issues.push({ key: "packPanelScriptFile", params: { file: path } })
    }
    const key = path.normalize("NFC").toLowerCase()
    if (filePaths.has(path) || seenFiles.has(key))
      issues.push({ key: "packDuplicatePath", params: { file: path } })
    filePaths.add(path)
    seenFiles.add(key)
    if ((file.contents === undefined) === (file.base64 === undefined)) {
      issues.push({ key: "packPanelFileBodyMissing", params: { file: path } })
    }
  }

  const checked = checkPanelsText(panels.yamlText)
  for (const problem of checked.problems) {
    issues.push({
      key: "packPanelInvalid",
      params: { code: problem.code, at: problem.path || PANELS_FILE_NAME, detail: problem.detail ?? "" },
    })
  }

  const shipped = new Set<string>([...filePaths, ...draft.assets.map((asset) => `assets/${asset.fileName}`)])
  if (draft.presentation !== null) {
    for (const file of presentationKitFiles(draft.presentation)) shipped.add(`assets/${file.fileName}`)
  }
  const referenced = new Set<string>()
  for (const panel of checked.panels) {
    if (panel.entry !== null) {
      referenced.add(panel.entry)
      const page = panels.files.find((file) => file.path === panel.entry)
      if (page === undefined)
        issues.push({ key: "packPanelMissingFile", params: { panel: panel.id, file: panel.entry } })
      else if (page.contents === undefined && page.base64 !== undefined) {
        issues.push({ key: "packPanelPageNotText", params: { file: panel.entry } })
      }
    }
    for (const image of panel.images) {
      referenced.add(image)
      if (!shipped.has(image))
        issues.push({ key: "packPanelMissingFile", params: { panel: panel.id, file: image } })
      else if (!(PRESENTATION_IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(image).slice(1))) {
        issues.push({ key: "packPanelImageType", params: { panel: panel.id, file: image } })
      }
    }
  }
  // A panel file nothing names never reaches the archive: the builder reads only named files.
  if (checked.problems.length === 0) {
    for (const path of filePaths) {
      if (!referenced.has(path)) issues.push({ key: "packPanelFileOrphan", params: { file: path } })
    }
  }
  return issues
}

/** Every stored panels file's checks, as the editor shows them inline. */
export function panelsProblems(yamlText: string) {
  return checkPanelsText(yamlText).problems
}

/** A kit media file ships as `assets/<fileName>`: a plain basename, so the pack path passes
 * the engine's path rule. */
function checkKitFileName(fileName: string): string | null {
  if (fileName.includes("/")) return "must be a plain file name (kit files land directly under assets/, no /)"
  const problem = checkPackPath(`assets/${fileName}`)
  return problem === null ? null : `not a usable file name (${problem})`
}

/** Structural mirror of the engine's kit reader (`server/src/core/presentation/kit.ts`) —
 * same enums, same caps, same slug rule, so a kit green here survives the
 * engine's re-parse at build. Subject/cue issues carry `uid` + `field` params
 * so the wizard stage renders them next to the offending input; duplicate
 * paths raised here carry `from: "presentation"` for step partitioning. Whether
 * each file IS a picture or a sound (`kit_asset_type`) is the engine's check;
 * the editor only soft-hints it by extension. */
function validatePresentationDraft(kit: PackPresentationDraft, seenFiles: Set<string>): Issue[] {
  const issues: Issue[] = []
  type GenerationMode = (typeof PRESENTATION_GENERATION_MODES)[number]
  type SubjectKind = (typeof PRESENTATION_SUBJECT_KINDS)[number]
  type AudioLayer = (typeof PRESENTATION_AUDIO_LAYERS)[number]

  const noteKitAssetPath = (path: string) => {
    const key = path.normalize("NFC").toLowerCase()
    if (seenFiles.has(key)) {
      issues.push({ key: "packDuplicatePath", params: { file: path, from: "presentation" } })
    }
    seenFiles.add(key)
  }

  if (!PRESENTATION_GENERATION_MODES.includes(kit.generation as GenerationMode)) {
    issues.push({ key: "packPresentationGeneration", params: { value: kit.generation } })
  }
  type TemplateKind = (typeof PRESENTATION_TEMPLATE_KINDS)[number]
  const seenTemplates = new Set<string>()
  for (const template of kit.templates) {
    if (!PRESENTATION_TEMPLATE_KINDS.includes(template as TemplateKind)) {
      issues.push({
        key: "packPresentationTemplateKind",
        params: { value: template, field: "templates" },
      })
    } else if (seenTemplates.has(template)) {
      issues.push({
        key: "packPresentationTemplateDuplicate",
        params: { value: template, field: "templates" },
      })
    }
    seenTemplates.add(template)
  }
  const paletteLines = kit.paletteText.split("\n").filter((line) => line.trim().length > 0)
  if (paletteLines.length > MAX_PRESENTATION_PALETTE) {
    issues.push({
      key: "packPresentationPaletteCount",
      params: { max: MAX_PRESENTATION_PALETTE, field: "palette" },
    })
  }
  paletteLines.forEach((entry, index) => {
    if (entry.trim().length > MAX_PRESENTATION_PALETTE_CHARS) {
      issues.push({
        key: "packPresentationPaletteTooLong",
        params: { index: index + 1, max: MAX_PRESENTATION_PALETTE_CHARS, field: "palette" },
      })
    }
  })
  for (const [locale, text] of [
    ["en", kit.keywordsEn],
    ["zh", kit.keywordsZh],
  ] as const) {
    if (text.trim() && text.length > MAX_PRESENTATION_TEXT_CHARS) {
      issues.push({
        key: "packPresentationKeywordsTooLong",
        params: {
          locale,
          max: MAX_PRESENTATION_TEXT_CHARS,
          field: `keywords${locale === "en" ? "En" : "Zh"}`,
        },
      })
    }
  }
  const bannedLines = kit.bannedText.split("\n").filter((line) => line.trim().length > 0)
  if (bannedLines.length > MAX_PRESENTATION_BANNED) {
    issues.push({
      key: "packPresentationBannedCount",
      params: { max: MAX_PRESENTATION_BANNED, field: "banned" },
    })
  }
  bannedLines.forEach((entry, index) => {
    if (entry.length > MAX_PRESENTATION_TEXT_CHARS) {
      issues.push({
        key: "packPresentationBannedTooLong",
        params: { index: index + 1, max: MAX_PRESENTATION_TEXT_CHARS, field: "banned" },
      })
    }
  })

  if (kit.subjects.length > MAX_PRESENTATION_SUBJECTS) {
    issues.push({ key: "packPresentationSubjectsCount", params: { max: MAX_PRESENTATION_SUBJECTS } })
  }
  const seenSubjectIds = new Set<string>()
  for (const [index, subject] of kit.subjects.entries()) {
    const label = subject.id.trim() || `#${index + 1}`
    const bad = (field: string, detail: string) =>
      issues.push({
        key: "packPresentationSubjectInvalid",
        params: { uid: subject.uid, subject: label, field, detail },
      })
    const id = subject.id.trim()
    if (!PACK_ID_RE.test(id)) bad("id", "id must be a lowercase slug ([a-z0-9-], max 64)")
    else if (seenSubjectIds.has(id)) issues.push({ key: "packPresentationDuplicateSubject", params: { id } })
    else seenSubjectIds.add(id)
    if (!PRESENTATION_SUBJECT_KINDS.includes(subject.kind as SubjectKind)) {
      bad("kind", `kind must be one of ${PRESENTATION_SUBJECT_KINDS.join(", ")}`)
    }
    if (!subject.nameEn.trim() && !subject.nameZh.trim()) bad("nameEn", "name: needs at least one of en, zh")
    if (subject.nameEn.trim() && subject.nameEn.length > MAX_PRESENTATION_TEXT_CHARS) {
      bad("nameEn", `name.en: at most ${MAX_PRESENTATION_TEXT_CHARS} chars`)
    }
    if (subject.nameZh.trim() && subject.nameZh.length > MAX_PRESENTATION_TEXT_CHARS) {
      bad("nameZh", `name.zh: at most ${MAX_PRESENTATION_TEXT_CHARS} chars`)
    }
    if (subject.prompt.length > MAX_PRESENTATION_PROMPT_CHARS) {
      bad("prompt", `prompt: at most ${MAX_PRESENTATION_PROMPT_CHARS} chars`)
    }
    const fileName = subject.refFileName.trim()
    if ((fileName === "") !== (subject.refBase64 === "")) {
      bad("ref", "ref file incomplete — re-upload the reference image")
    }
    if (fileName !== "") {
      const pathProblem = checkKitFileName(fileName)
      if (pathProblem) bad("refFileName", pathProblem)
      else noteKitAssetPath(`assets/${fileName}`)
    }
  }

  if (kit.audio.length > MAX_PRESENTATION_AUDIO) {
    issues.push({ key: "packPresentationAudioCount", params: { max: MAX_PRESENTATION_AUDIO } })
  }
  const seenCueIds = new Set<string>()
  for (const [index, cue] of kit.audio.entries()) {
    const label = cue.id.trim() || `#${index + 1}`
    const bad = (field: string, detail: string) =>
      issues.push({
        key: "packPresentationCueInvalid",
        params: { uid: cue.uid, cue: label, field, detail },
      })
    const id = cue.id.trim()
    if (!PACK_ID_RE.test(id)) bad("id", "id must be a lowercase slug ([a-z0-9-], max 64)")
    else if (seenCueIds.has(id)) issues.push({ key: "packPresentationDuplicateCue", params: { id } })
    else seenCueIds.add(id)
    if (!PRESENTATION_AUDIO_LAYERS.includes(cue.layer as AudioLayer)) {
      bad("layer", `layer must be one of ${PRESENTATION_AUDIO_LAYERS.join(", ")}`)
    }
    const fileName = cue.assetFileName.trim()
    if (fileName === "") {
      bad("asset", "asset: a cue needs its audio file — upload one (mp3, ogg, wav, flac, m4a, aac)")
    } else {
      const pathProblem = checkKitFileName(fileName)
      if (pathProblem) bad("assetFileName", pathProblem)
      else noteKitAssetPath(`assets/${fileName}`)
      if (cue.assetBase64 === "") bad("asset", "asset file incomplete — re-upload the audio")
    }
    if (cue.title.length > MAX_PRESENTATION_TEXT_CHARS) {
      bad("title", `title: at most ${MAX_PRESENTATION_TEXT_CHARS} chars`)
    }
  }

  // The emitted file itself is capped (`MAX_KIT_BYTES`).
  const bytes = new TextEncoder().encode(buildPresentationYaml(kit)).length
  if (bytes > MAX_PRESENTATION_FILE_BYTES) {
    issues.push({ key: "packPresentationTooBig", params: { max: MAX_PRESENTATION_FILE_BYTES } })
  }
  return issues
}

/** `ui/presentation.yaml`, emitted exactly in the shape
 * the engine's kit reader accepts: `version: 2` and an
 * explicit `generation` always; optional sections omitted when empty;
 * localized fields ride as `{en, zh}` maps with the filled locales only;
 * media references point at `assets/<fileName>` (the flagship's layout). */
export function buildPresentationYaml(kit: PackPresentationDraft): string {
  type GenerationMode = (typeof PRESENTATION_GENERATION_MODES)[number]
  const doc: Record<string, unknown> = {
    version: PRESENTATION_KIT_VERSION,
    generation: PRESENTATION_GENERATION_MODES.includes(kit.generation as GenerationMode)
      ? kit.generation
      : "allow",
  }
  // Omitted when empty, never written as "all five": the engine reads an empty
  // allowlist as no restriction, and an author who ticked nothing chose that.
  const templates = kit.templates.filter((template, index) => kit.templates.indexOf(template) === index)
  if (templates.length > 0) doc.templates = templates
  const style: Record<string, unknown> = {}
  const keywords = localized(kit.keywordsEn, kit.keywordsZh)
  if (Object.keys(keywords).length > 0) style.keywords = keywords
  const banned = kit.bannedText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (banned.length > 0) style.banned = banned
  const palette = kit.paletteText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (palette.length > 0) style.palette = palette
  if (Object.keys(style).length > 0) doc.style = style
  if (kit.subjects.length > 0) {
    doc.subjects = kit.subjects.map((subject) => {
      const entry: Record<string, unknown> = {
        id: subject.id.trim(),
        kind: subject.kind,
        name: localized(subject.nameEn, subject.nameZh),
      }
      const ref = subject.refFileName.trim()
      if (ref) entry.ref = `assets/${ref}`
      const prompt = subject.prompt.trim()
      if (prompt) entry.prompt = prompt
      return entry
    })
  }
  if (kit.audio.length > 0) {
    doc.audio = kit.audio.map((cue) => {
      const entry: Record<string, unknown> = {
        id: cue.id.trim(),
        layer: cue.layer,
        asset: `assets/${cue.assetFileName.trim()}`,
      }
      const title = cue.title.trim()
      if (title) entry.title = title
      return entry
    })
  }
  return stringify(doc, { lineWidth: 0 })
}

/** The kit's media files in declaration order (subject refs, then cue
 * assets), de-duplicated by file name — folded into the manifest `assets:`
 * block (for a readable manifest: the builder takes them along listed or not)
 * and the source tree's binaries. */
export function presentationKitFiles(kit: PackPresentationDraft): { fileName: string; base64: string }[] {
  const files: { fileName: string; base64: string }[] = []
  const seen = new Set<string>()
  const note = (fileName: string, base64: string) => {
    const name = fileName.trim()
    if (name === "" || base64 === "" || seen.has(name)) return
    seen.add(name)
    files.push({ fileName: name, base64 })
  }
  for (const subject of kit.subjects) note(subject.refFileName, subject.refBase64)
  for (const cue of kit.audio) note(cue.assetFileName, cue.assetBase64)
  return files
}

/** The kit at a glance: subjects and cues (what the engine's trust card counts), and
 * whether image generation can happen at all (generation allowed AND at least one
 * subject ships a reference picture). */
export function presentationSummary(kit: PackPresentationDraft): {
  subjects: number
  withRefs: number
  audio: number
  mode: "allow" | "pack_only"
  imagegen: boolean
} {
  // The ref PATH counts, not the bytes: `ref` is what `buildPresentationYaml` writes
  // from `refFileName`, and the persisted session drops the bytes and keeps the name.
  const withRefs = kit.subjects.filter((subject) => subject.refFileName.trim() !== "").length
  const mode = kit.generation === "pack_only" ? "pack_only" : "allow"
  return {
    subjects: kit.subjects.length,
    withRefs,
    audio: kit.audio.length,
    mode,
    imagegen: mode === "allow" && withRefs > 0,
  }
}

function localized(en: string, zh: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (en.trim()) out.en = en.trim()
  if (zh.trim()) out.zh = zh.trim()
  return out
}

/** A card entry: `{path, kind}` and the notes for the room admin when there are any. */
function cardEntryToYaml(card: PackCardDraft): Record<string, unknown> {
  const entry: Record<string, unknown> = { path: `cards/${card.fileName}`, kind: card.kind }
  const notes = localized(card.notesEn, card.notesZh)
  if (Object.keys(notes).length > 0) entry.notes = notes
  return entry
}

/** The build's horizon: the episode ordinal this release stops at. 0 episodes (an ordinary
 * pack) or an unset `buildUpTo` both mean "everything". */
export function buildHorizon(draft: WorldPackDraft): number {
  const latest = latestOrdinal(draft.episodes)
  if (latest === 0) return Number.MAX_SAFE_INTEGER
  const upTo = draft.buildUpTo ?? latest
  return upTo > 0 ? upTo : latest
}

/**
 * The draft as it will actually SHIP: content tagged past the horizon is gone.
 *
 * Everything downstream — the manifest, the file plan, the asset block — reads this and only
 * this, so there is exactly one place a future episode can be excluded and no way for two of
 * them to disagree about what a release contains.
 */
export function draftForRelease(draft: WorldPackDraft): WorldPackDraft {
  const upTo = buildHorizon(draft)
  if (upTo === Number.MAX_SAFE_INTEGER) return draft
  const keep = <T extends EpisodeTagged>(item: T) => includedInBuild(draft.episodes, item, upTo)
  const trim = (jsonText: string) => filterEpisodeContent(jsonText, draft.episodes, upTo)
  return {
    ...draft,
    cards: draft.cards
      .filter(keep)
      .map((card) => (card.jsonText === undefined ? card : { ...card, jsonText: trim(card.jsonText) })),
    assets: draft.assets.filter(keep),
  }
}

export function buildManifestYaml(input: WorldPackDraft): string {
  const draft = draftForRelease(input)
  const contents: Record<string, unknown> = {}
  if (draft.skills.length > 0) contents.skills = draft.skills.map((skill) => `skills/${skill.slug}`)
  if (draft.rulepacks.length > 0)
    contents.rulepacks = draft.rulepacks.map((rulepack) => `rulepacks/${rulepack.id}.yaml`)
  if (draft.cards.length > 0) contents.cards = draft.cards.map(cardEntryToYaml)
  if (draft.presentation !== null) contents.presentation = [PRESENTATION_FILE_NAME]
  if (draft.panels !== null) contents.panels = [PANELS_FILE_NAME]
  const manifest: Record<string, unknown> = {
    manifest_version: MANIFEST_VERSION,
    id: draft.id,
    version: draft.version,
    name: localized(draft.nameEn, draft.nameZh),
    description: localized(draft.descriptionEn, draft.descriptionZh),
    authors: draft.authors.map((author) => author.trim()).filter((author) => author.length > 0),
    license: draft.license.trim(),
    // A minimum, never a range: the wire protocol every kind Studio writes needs.
    engine: { protocol: ENGINE_PROTOCOL },
  }
  if (draft.modules.length > 0) {
    // The builder bundles each entry and rewrites `entry` to the bundle it writes.
    manifest.modules = draft.modules.map((module) => ({ id: module.id, entry: moduleEntryPath(module) }))
  }
  if (Object.keys(contents).length > 0) manifest.contents = contents
  // The pictures and sounds a kit or a panel names travel with them, listed or not; what is
  // listed here are the dropped assets and, for a readable manifest, the kit's media.
  const kitFiles = draft.presentation !== null ? presentationKitFiles(draft.presentation) : []
  if (draft.assets.length > 0 || kitFiles.length > 0) {
    const listed = new Set<string>()
    manifest.assets = [
      ...draft.assets.map((asset) => asset.fileName),
      ...kitFiles.map((file) => file.fileName),
    ]
      .map((fileName) => `assets/${fileName}`)
      .filter((path) => (listed.has(path) ? false : (listed.add(path), true)))
      .map((path) => ({ path }))
  }
  return stringify(manifest, { lineWidth: 0 })
}

/** SKILL.md with the front matter the engine's skill reader expects. A hand-written
 * `skillMd` ships verbatim — the author owns the whole document. */
export function buildSkillMd(skill: PackSkillDraft): string {
  const custom = skill.skillMd?.trim()
  if (custom) return custom.endsWith("\n") ? custom : `${custom}\n`
  const frontmatter = stringify(
    {
      name: skill.nameEn.trim() || skill.slug,
      description: skill.descriptionEn.trim() || skill.slug,
      metadata: { scope: "room" },
    },
    { lineWidth: 0 },
  )
  const zhBlock = skill.descriptionZh.trim() ? `\n${skill.descriptionZh.trim()}\n` : ""
  return `---\n${frontmatter}---\n\n${skill.descriptionEn.trim() || skill.slug}\n${zhBlock}`
}

/** Lay out the full source tree. Callers hand the plan to the Rust side to write, then run
 * the engine's builder on the resulting directory. */
export function buildPackSourcePlan(input: WorldPackDraft): PackSourcePlan {
  // ONE filtered view for the whole plan: the manifest and the files it names are built from
  // the same object, so a future episode cannot survive in one and not the other.
  const draft = draftForRelease(input)
  const files: PackTextFile[] = [{ path: "pack.yaml", contents: buildManifestYaml(draft) }]
  const binaries: PackBinaryFile[] = []

  // The release notes, for the author's repository. The builder reads only the files the
  // manifest names, so this never reaches the archive.
  const changelog = buildChangelog(
    input.nameEn || input.nameZh,
    input.version,
    input.episodes,
    buildHorizon(input),
  )
  if (changelog) files.push({ path: "CHANGELOG.md", contents: changelog })

  for (const card of draft.cards) {
    if (card.jsonText !== undefined) files.push({ path: `cards/${card.fileName}`, contents: card.jsonText })
    else if (card.base64 !== undefined) binaries.push({ path: `cards/${card.fileName}`, base64: card.base64 })
  }
  for (const skill of draft.skills)
    files.push({ path: `skills/${skill.slug}/SKILL.md`, contents: buildSkillMd(skill) })
  for (const rulepack of draft.rulepacks)
    files.push({ path: `rulepacks/${rulepack.id}.yaml`, contents: rulepack.yamlText })
  for (const module of draft.modules) {
    const source = module.source.endsWith("\n") ? module.source : `${module.source}\n`
    files.push({ path: moduleEntryPath(module), contents: source })
  }
  for (const asset of draft.assets) binaries.push({ path: `assets/${asset.fileName}`, base64: asset.base64 })
  if (draft.panels !== null) {
    files.push({ path: PANELS_FILE_NAME, contents: draft.panels.yamlText })
    for (const file of draft.panels.files) {
      if (file.contents !== undefined) files.push({ path: file.path, contents: file.contents })
      else if (file.base64 !== undefined) binaries.push({ path: file.path, base64: file.base64 })
    }
  }
  if (draft.presentation !== null) {
    files.push({ path: PRESENTATION_FILE_NAME, contents: buildPresentationYaml(draft.presentation) })
    const written = new Set(binaries.map((binary) => binary.path))
    for (const file of presentationKitFiles(draft.presentation)) {
      const path = `assets/${file.fileName}`
      if (!written.has(path)) binaries.push({ path, base64: file.base64 })
    }
  }
  return { dirName: draft.id, files, binaries }
}
