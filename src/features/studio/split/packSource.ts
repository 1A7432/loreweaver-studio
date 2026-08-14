// World-half → `.lwpack` SOURCE directory. The studio deliberately does NOT
// zip anything: validation and byte-determinism have exactly one source of
// truth — the engine (`python -m app --pack <dir>` / `loreweaver-server
// --pack`). This module only plans the source tree (pack.yaml + cards +
// lorebooks + skills + rulepack patches) that the engine CLI then builds.
// Field names and constraints mirror `core/pack.py`.

import { parse, stringify } from "yaml"
import { evaluate } from "@loreweaver/protocol"
import type { Issue } from "../model"

export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/
export const MAX_HOOK_SOURCE_CHARS = 40_000
const MAX_NOTE_CHARS = 2_000

// M15 panel caps, mirroring `core/panels.py` (author-time strictness — the
// engine re-validates at build; these keep the wizard red inline).
export const PANELS_FILE_NAME = "ui/panels.yaml"
const MAX_PANELS_PER_PACK = 16
const MAX_PANEL_BLOCKS = 32
const MAX_PANEL_EXTRA_ASSETS = 8
const PANEL_SLOTS = new Set(["sidebar", "tray", "modal"])
const PANEL_AUDIENCES = new Set(["all", "player", "keeper"])
const PANEL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

// M19 presentation kit (演出资料包), mirroring `core/presentation.py` — the
// single schema authority; the engine re-parses the emitted file at pack
// build (`core/pack.py::_validate_pack_presentation`), so these enums/caps
// are copied from it, not invented.
export const PRESENTATION_FILE_NAME = "ui/presentation.yaml"
/** `core/presentation.py::KIT_VERSION`. v2 (M19 completion, 2026-08-15) added
 * the `templates` allowlist and `style.palette` the M19 spec had promised, and
 * the engine REJECTS a v1 file outright — one clean break, no dual-schema
 * reader, per the standing no-backcompat sanction. The studio emits v2 only.
 * (This closed `UPSTREAM_TODO` item 12.) */
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
/** `core/presentation.py::TEMPLATE_KINDS` — the performance shapes the Stage
 * Director may stage. An EMPTY list means all of them; the engine's
 * `allows_template()` reads it that way, so the wizard must not "helpfully"
 * pre-tick every box (that would emit an allowlist the author never chose). */
export const PRESENTATION_TEMPLATE_KINDS = ["image", "title_card", "letter", "clipping", "text"] as const
/** Soft editor hints only — the engine takes each asset's MIME from the file
 * EXTENSION (`core/pack.py::_ASSET_MIME_BY_SUFFIX`, a table it owns rather than
 * the build machine's mimetypes db) and checks it against
 * `core/hooks.py::UI_IMAGE_MIMES` / `core/presentation.py::AUDIO_MIMES`
 * (`core/pack.py::_enforce_kit_assets`). These two lists are that table's
 * documented surface, pinned upstream by `tests/core/test_pack_asset_mime.py`. */
export const PRESENTATION_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "svg"] as const
export const PRESENTATION_AUDIO_EXTENSIONS = ["mp3", "ogg", "wav", "flac", "m4a", "aac"] as const

// M19 (protocol 2.1) template additions, mirroring `core/panels.py`: the
// `image` kind, the four performance kinds' required/optional fields with
// their per-field caps (`core/hooks.py`), and the `visible_when` portable
// subset (`core/condexpr.py` — MAX_EXPR_LEN included).
const MAX_UI_LABEL_CHARS = 120
const MAX_UI_CAPTION_CHARS = 300
const MAX_UI_BODY_CHARS = 4_000
const MAX_VISIBLE_WHEN_CHARS = 500
const PERFORMANCE_KIND_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  letter: { required: ["body"], optional: ["from", "to", "date"] },
  clipping: { required: ["headline", "body"], optional: ["source", "date"] },
  map_pin: { required: ["src", "label", "x", "y"], optional: ["note"] },
  title_card: { required: ["title"], optional: ["subtitle", "act"] },
}
const PERFORMANCE_FIELD_CAPS: Record<string, number> = {
  body: MAX_UI_BODY_CHARS,
  headline: MAX_UI_LABEL_CHARS,
  label: MAX_UI_LABEL_CHARS,
  title: MAX_UI_LABEL_CHARS,
  from: MAX_UI_LABEL_CHARS,
  to: MAX_UI_LABEL_CHARS,
  date: MAX_UI_LABEL_CHARS,
  source: MAX_UI_LABEL_CHARS,
  act: MAX_UI_LABEL_CHARS,
  note: MAX_UI_CAPTION_CHARS,
  subtitle: MAX_UI_CAPTION_CHARS,
}

export interface PackCardDraft {
  /** File name under `cards/` (already sanitized, extension included). */
  fileName: string
  /** Exactly one of these: JSON card text, or original PNG bytes. */
  jsonText?: string
  base64?: string
  /** Install notes (table rules / usage guide, shown at install). */
  notesEn: string
  notesZh: string
}

export interface PackSkillDraft {
  slug: string
  nameEn: string
  descriptionEn: string
  descriptionZh: string
  /** Hook sources, concatenated into one hooks.js. */
  hooks: string[]
  /** Hand-written SKILL.md body (frontmatter included). When set it ships
   * VERBATIM instead of the generated stub — real keeper skills carry prompt
   * sections, not just a description line. */
  skillMd?: string
}

/** One file a tier-2 panel ships (path is pack-relative, under `ui/`). */
export interface PackPanelFileDraft {
  path: string
  /** Exactly one of these: UTF-8 text (html/js/css ride as text for readable
   * diffs) or raw bytes. */
  contents?: string
  base64?: string
}

/** The pack's module-UI declaration: `ui/panels.yaml` + every panel file. */
export interface PackPanelsDraft {
  yamlText: string
  files: PackPanelFileDraft[]
}

/** One picturable subject (the 定妆 convention). An empty ref is LEGAL — it
 * means "nameable in captions, never generated" (`core/presentation.py`:
 * ref-mandatory is doctrine enforced by the runtime, not by the schema). */
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

/** One audio cue the Director may call for, bound to a pack audio asset. */
export interface PackPresentationAudioDraft {
  uid: string
  id: string
  layer: string
  /** Basename under `assets/` + bytes; a cue without its file is invalid. */
  assetFileName: string
  assetBase64: string
  title: string
}

/** The pack's Stage Director brief: `ui/presentation.yaml` + its media files. */
export interface PackPresentationDraft {
  generation: string
  /** Kit v2 `templates`: the performance shapes the Director may stage. EMPTY
   * means every shape is allowed — it is not the same as listing them all,
   * because the engine reads an empty list as "no allowlist". */
  templates: string[]
  keywordsEn: string
  keywordsZh: string
  /** Banned elements, one per line. */
  bannedText: string
  /** Kit v2 `style.palette`: hex codes or colour words, one per line. */
  paletteText: string
  subjects: PackPresentationSubjectDraft[]
  audio: PackPresentationAudioDraft[]
}

// M20 F prep-phase scripts (`contents.prep`), mirroring `core/prep_script.py`
// and the build-side checks in `core/pack.py::_validate_pack_prep_scripts`.
// The engine's build checks are deliberately STATIC (extension, size, UTF-8) so
// packs build identically on machines without the optional QuickJS extra; a
// syntax error surfaces at `run_prep_plan`'s preview instead. The studio mirrors
// exactly those checks, plus advisory counts of the runtime caps.
export const PREP_DIR = "prep"
export const MAX_PREP_SCRIPT_CHARS = 20_000
export const MAX_PREP_OPERATIONS = 200

/** One prep-phase plan script. `plan(tool, args)` is the only callable the
 * sandbox exposes; the engine applies the emitted operation list through the
 * ordinary tool path, previewed whole before anything is touched. */
export interface PackPrepScriptDraft {
  /** File name under `prep/` — `.js`, the extension the build enforces. */
  fileName: string
  source: string
}

export interface PackRulepackDraft {
  /** Becomes `rulepacks/<id>.yaml`; the id must be a slug. */
  id: string
  yamlText: string
}

export interface PackLorebookDraft {
  fileName: string
  jsonText: string
}

/** One media asset. The author side only declares the path — sha256/mime/size
 * are filled in by the engine at build time. */
export interface PackAssetDraft {
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
  lorebooks: PackLorebookDraft[]
  skills: PackSkillDraft[]
  rulepacks: PackRulepackDraft[]
  assets: PackAssetDraft[]
  /** M20 F prep-phase plan scripts. They NEVER run automatically — a keeper
   * invokes one by reference and previews the plan first. */
  prep: PackPrepScriptDraft[]
  /** M15 module-UI panels; null when the pack ships none. */
  panels: PackPanelsDraft | null
  /** M19 presentation kit; null when the pack ships none — the Stage Director
   * is kit-gated, so null means "no staged beats for rooms of this module". */
  presentation: PackPresentationDraft | null
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

/** Author-side validation, mirroring what `core.pack.build_pack` will reject —
 * surfaced BEFORE the engine run so the wizard can go red inline. */
export function validatePackDraft(draft: WorldPackDraft): Issue[] {
  const issues: Issue[] = []
  if (!PACK_ID_RE.test(draft.id)) issues.push({ key: "packIdInvalid" })
  if (!SEMVER_RE.test(draft.version)) issues.push({ key: "packVersionInvalid" })
  if (!draft.nameEn.trim() && !draft.nameZh.trim()) issues.push({ key: "packNameRequired" })
  if (!draft.descriptionEn.trim() && !draft.descriptionZh.trim()) {
    issues.push({ key: "packDescriptionRequired" })
  }
  if (!draft.license.trim()) issues.push({ key: "packLicenseRequired" })
  if (draft.authors.every((author) => !author.trim())) issues.push({ key: "packAuthorsRequired" })

  const seenFiles = new Set<string>()
  for (const card of draft.cards) {
    if ((card.jsonText === undefined) === (card.base64 === undefined)) {
      issues.push({ key: "packCardBodyMissing", params: { file: card.fileName } })
    }
    if (card.notesEn.length > MAX_NOTE_CHARS || card.notesZh.length > MAX_NOTE_CHARS) {
      issues.push({ key: "packNotesTooLong", params: { file: card.fileName, max: MAX_NOTE_CHARS } })
    }
    const path = `cards/${card.fileName}`
    if (seenFiles.has(path)) issues.push({ key: "packDuplicatePath", params: { file: path } })
    seenFiles.add(path)
  }
  const seenSkillSlugs = new Set<string>()
  for (const skill of draft.skills) {
    if (!PACK_ID_RE.test(skill.slug)) {
      issues.push({ key: "packSkillSlugInvalid", params: { file: skill.slug } })
    }
    if (seenSkillSlugs.has(skill.slug)) {
      issues.push({ key: "packDuplicatePath", params: { file: `skills/${skill.slug}` } })
    }
    seenSkillSlugs.add(skill.slug)
    const joined = joinHooks(skill.hooks)
    if (joined.length > MAX_HOOK_SOURCE_CHARS) {
      issues.push({ key: "packHooksTooLong", params: { file: skill.slug, max: MAX_HOOK_SOURCE_CHARS } })
    }
    // A hand-written SKILL.md must open with YAML frontmatter or the engine's
    // `parse_skill_text` refuses the whole pack.
    const custom = skill.skillMd?.trim()
    if (custom && !custom.startsWith("---")) {
      issues.push({ key: "packSkillMdNoFrontmatter", params: { file: skill.slug } })
    }
  }
  for (const rulepack of draft.rulepacks) {
    if (!PACK_ID_RE.test(rulepack.id)) {
      issues.push({ key: "packRulepackIdInvalid", params: { file: rulepack.id } })
    }
  }
  for (const lorebook of draft.lorebooks) {
    const path = `lorebooks/${lorebook.fileName}`
    if (seenFiles.has(path)) issues.push({ key: "packDuplicatePath", params: { file: path } })
    seenFiles.add(path)
  }
  for (const asset of draft.assets) {
    const path = `assets/${asset.fileName}`
    if (seenFiles.has(path)) issues.push({ key: "packDuplicatePath", params: { file: path } })
    seenFiles.add(path)
  }
  for (const script of draft.prep) {
    // The engine's build-side checks, verbatim (`_validate_pack_prep_scripts`):
    // `.js` extension and the sandbox's character cap. Everything else about a
    // prep script is checked at preview time, not at build.
    const path = `${PREP_DIR}/${script.fileName}`
    if (!script.fileName.toLowerCase().endsWith(".js")) {
      issues.push({ key: "packPrepNotJs", params: { file: path } })
    }
    if (script.fileName.includes("/")) {
      issues.push({ key: "packPrepPath", params: { file: script.fileName } })
    }
    if (script.source.length > MAX_PREP_SCRIPT_CHARS) {
      issues.push({ key: "packPrepTooLong", params: { file: path, max: MAX_PREP_SCRIPT_CHARS } })
    }
    if (!script.source.trim()) issues.push({ key: "packPrepEmpty", params: { file: path } })
    if (seenFiles.has(path)) issues.push({ key: "packDuplicatePath", params: { file: path } })
    seenFiles.add(path)
  }
  if (draft.panels !== null) issues.push(...validatePanelsDraft(draft.panels, seenFiles))
  if (draft.presentation !== null) issues.push(...validatePresentationDraft(draft.presentation, seenFiles))
  return issues
}

/** Advisory reading of one prep script: how many operations it plans, and
 * whether it reaches for anything the sandbox does not expose.
 *
 * `plan(tool, args)` is the ONLY callable (`core/prep_script.py::_PRELUDE`),
 * and the engine caps a plan at {@link MAX_PREP_OPERATIONS} operations. A
 * literal count is a lower bound — a loop can plan far more — so this reports
 * what it can see and says so. */
export function readPrepScript(source: string): {
  literalPlanCalls: number
  hasLoop: boolean
  forbidden: string[]
  chars: number
} {
  const withoutStrings = source.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, " ")
  const literalPlanCalls = (withoutStrings.match(/\bplan\s*\(/g) ?? []).length
  const hasLoop = /\b(?:for|while)\s*\(/.test(withoutStrings)
  // The sandbox has no host, no network and no engine state. Naming one of
  // these is not a build error — it is a script that will fail at preview.
  const forbidden = ["fetch", "require", "import", "process", "globalThis.__plan", "XMLHttpRequest"].filter(
    (name) => new RegExp(`\\b${name.replace(".", "\\.")}\\b`).test(withoutStrings),
  )
  return { literalPlanCalls, hasLoop, forbidden, chars: source.length }
}

/** The block-level 2.1 helpers. Everything else deep stays the ENGINE's job;
 * its build error lands in the wizard terminal. The two things the wizard CAN
 * be actionable about: the five new block kinds' required fields, and
 * `visible_when`, which the engine refuses at pack build
 * (`core.panels._validated_visible_when`) so the wizard must catch it FIRST. */

function isBindingShape(value: unknown): boolean {
  return typeof value === "object" && value !== null && ("$var" in value || "$leaf" in value)
}

/** A localized text field, mirroring `core/panels.py::_localized`: a plain
 * string, an `{en,zh}` map, or a binding (checked only against the room). */
function checkLocalized(value: unknown, cap: number): string | null {
  if (isBindingShape(value)) return null
  if (typeof value === "string") {
    return value.trim().length > 0 && value.length <= cap
      ? null
      : `must be a non-empty string of at most ${cap} chars`
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
    const unknown = entries.map(([key]) => key).filter((key) => key !== "en" && key !== "zh")
    if (unknown.length > 0) return `unknown locale keys ${unknown.sort().join(", ")}`
    if (entries.length === 0) return "needs at least one of en, zh"
    for (const [locale, text] of entries) {
      if (typeof text !== "string" || !text.trim() || text.length > cap) {
        return `${locale}: must be a non-empty string of at most ${cap} chars`
      }
    }
    return null
  }
  return "expected a string or an en/zh mapping"
}

/** A bindable number, mirroring `core/panels.py::_scalar(types=(int, float))`. */
function checkBindableNumber(value: unknown): string | null {
  if (isBindingShape(value)) return null
  return typeof value === "number" && Number.isFinite(value) ? null : "expected a number or a $var binding"
}

/** A pack-relative asset path, mirroring `core/panels.py::_validated_asset_path`. */
function checkAssetPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "must be a relative path string"
  const path = value.trim()
  if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || !part.trim())) {
    return "must be a plain relative path (no .. segments)"
  }
  return null
}

/** One `visible_when` condition, mirroring `core/panels.py::_validated_visible_when`
 * (which pairs `compile_expression(probe="1")` with `check_subset`). The shipped
 * evaluator IS the portable subset, so a dry run rejects syntax errors AND
 * out-of-subset constructs in one pass; the `"1"` probe coerces as a number
 * AND orders as a string, so a type only the runtime can know never fails the
 * build-time check. */
function checkVisibleWhen(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "must be a non-empty condition string"
  const condition = value.trim()
  if (condition.length > MAX_VISIBLE_WHEN_CHARS) {
    return `condition exceeds ${MAX_VISIBLE_WHEN_CHARS} chars`
  }
  try {
    evaluate(condition, () => "1")
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `${message} (visible_when is the portable subset: comparisons, boolean logic, literals, dotted references — no arithmetic, calls or brackets)`
  }
}

/** The 2.1 block-level checks: `visible_when` on ANY block (a repeat wrapper
 * and its inner template included), and the five new kinds' required fields.
 * Returns the image/map_pin `src` paths — the engine folds those into the ONE
 * content-addressed asset pipeline (`core.pack._validate_pack_panels`), so the
 * caller counts them as panel file references exactly like tier-2 assets. */
function validateTemplateBlocks(
  blocks: readonly unknown[],
  label: string,
  bad: (detail: string) => void,
  inRepeat = false,
): string[] {
  const srcs: string[] = []
  for (const [index, block] of blocks.entries()) {
    const here = `${label}[${index}]`
    if (typeof block !== "object" || block === null) {
      bad(`${here}: each block must be a mapping`)
      continue
    }
    const record = block as Record<string, unknown>
    if ("visible_when" in record) {
      const problem = checkVisibleWhen(record.visible_when)
      if (problem) bad(`${here}.visible_when: ${problem}`)
    }
    if ("repeat" in record) {
      if (inRepeat) {
        bad(`${here}: repeat does not nest`)
        continue
      }
      const spec = record.repeat as Record<string, unknown> | null
      if (typeof spec !== "object" || spec === null) {
        bad(`${here}.repeat: must be a mapping`)
        continue
      }
      if (typeof spec.prefix !== "string" || !spec.prefix.trim()) {
        bad(`${here}.repeat.prefix: must be a non-empty string`)
      }
      srcs.push(...validateTemplateBlocks([spec.block], `${here}.repeat.block`, bad, true))
      continue
    }
    const kind = record.kind
    if (kind === "image") {
      const problem = checkAssetPath(record.src)
      if (problem) bad(`${here}.src: ${problem}`)
      else srcs.push((record.src as string).trim())
      for (const field of ["caption", "alt"] as const) {
        if (record[field] === undefined) continue
        const issue = checkLocalized(
          record[field],
          field === "caption" ? MAX_UI_CAPTION_CHARS : MAX_UI_LABEL_CHARS,
        )
        if (issue) bad(`${here}.${field}: ${issue}`)
      }
      continue
    }
    if (typeof kind !== "string" || !(kind in PERFORMANCE_KIND_FIELDS)) continue
    const fields = PERFORMANCE_KIND_FIELDS[kind]
    for (const field of fields.required) {
      if (record[field] === undefined) {
        bad(`${here}: missing ${field}`)
        continue
      }
      const problem =
        field === "src"
          ? checkAssetPath(record[field])
          : field === "x" || field === "y"
            ? checkBindableNumber(record[field])
            : checkLocalized(record[field], PERFORMANCE_FIELD_CAPS[field])
      if (problem) bad(`${here}.${field}: ${problem}`)
      else if (field === "src") srcs.push((record[field] as string).trim())
    }
    for (const field of fields.optional) {
      if (record[field] === undefined) continue
      const problem = checkLocalized(record[field], PERFORMANCE_FIELD_CAPS[field])
      if (problem) bad(`${here}.${field}: ${problem}`)
    }
  }
  return srcs
}

/** Structural mirror of `core/panels.py::parse_panels_text` — the shape-level
 * rules that decide whether the engine will even look at the file (slug/slot/
 * audience enums, tier-1 vs tier-2 key sets, asset confinement, caps), plus
 * the 2.1 block checks above. Detail strings are author diagnostics,
 * technical English on purpose (same stance as the engine's). */
function validatePanelsDraft(panels: PackPanelsDraft, seenFiles: Set<string>): Issue[] {
  const issues: Issue[] = []
  const filePaths = new Set<string>()
  for (const file of panels.files) {
    const path = file.path
    const clean =
      path.startsWith("ui/") &&
      !path.endsWith("/") &&
      path !== PANELS_FILE_NAME &&
      path.split("/").every((part) => part.trim().length > 0 && part !== "." && part !== "..")
    if (!clean) {
      issues.push({ key: "packPanelPathInvalid", params: { file: path } })
      continue
    }
    if (filePaths.has(path) || seenFiles.has(path)) {
      issues.push({ key: "packDuplicatePath", params: { file: path } })
    }
    filePaths.add(path)
    seenFiles.add(path)
    if ((file.contents === undefined) === (file.base64 === undefined)) {
      issues.push({ key: "packPanelFileBodyMissing", params: { file: path } })
    }
  }

  let doc: unknown
  try {
    doc = parse(panels.yamlText)
  } catch (error) {
    issues.push({
      key: "packPanelsYamlInvalid",
      params: { detail: error instanceof Error ? error.message.split("\n")[0] : String(error) },
    })
    return issues
  }
  const root = doc as Record<string, unknown> | null
  const list = root !== null && typeof root === "object" ? root.panels : undefined
  if (!Array.isArray(list) || list.length === 0) {
    issues.push({ key: "packPanelsShape" })
    return issues
  }
  if (list.length > MAX_PANELS_PER_PACK) {
    issues.push({ key: "packPanelsCount", params: { max: MAX_PANELS_PER_PACK } })
  }

  const referenced = new Set<string>()
  const seenIds = new Set<string>()
  // Image/map_pin `src`s join the same content-addressed pipeline as tier-2
  // assets (`core.pack`): referenced (never orphaned), and an error when the
  // source tree does not ship them.
  const noteImageSrcs = (srcs: readonly string[], panelRef: string) => {
    for (const src of srcs) {
      referenced.add(src)
      if (!filePaths.has(src)) {
        issues.push({ key: "packPanelMissingFile", params: { panel: panelRef, file: src } })
      }
    }
  }
  for (const [index, rawPanel] of list.entries()) {
    const panel = rawPanel as Record<string, unknown> | null
    const bad = (detail: string) =>
      issues.push({
        key: "packPanelInvalid",
        params: { panel: typeof panel?.id === "string" ? panel.id : `#${index + 1}`, detail },
      })
    if (panel === null || typeof panel !== "object") {
      bad("each panel must be a mapping")
      continue
    }
    const id = typeof panel.id === "string" ? panel.id : ""
    if (!PANEL_SLUG_RE.test(id)) bad("id must be a lowercase slug ([a-z0-9-], max 64)")
    else if (seenIds.has(id)) bad("duplicate panel id")
    else seenIds.add(id)
    if (panel.title === undefined) bad("missing title")
    if (typeof panel.slot !== "string" || !PANEL_SLOTS.has(panel.slot)) {
      bad("slot must be sidebar | tray | modal")
    }
    if (panel.audience !== undefined) {
      if (typeof panel.audience !== "string" || !PANEL_AUDIENCES.has(panel.audience)) {
        bad("audience must be all | player | keeper")
      }
    }

    if (panel.entry === undefined) {
      // Tier 1: blocks required; tier-2 keys forbidden.
      if (panel.assets !== undefined || panel.fallback !== undefined) {
        bad("only a tier-2 panel (with entry) declares assets/fallback")
      }
      const blocks = panel.blocks
      if (!Array.isArray(blocks) || blocks.length === 0) bad("a tier-1 panel needs blocks")
      else {
        if (blocks.length > MAX_PANEL_BLOCKS) bad(`at most ${MAX_PANEL_BLOCKS} blocks`)
        noteImageSrcs(validateTemplateBlocks(blocks, "blocks", bad), id || `#${index + 1}`)
      }
      continue
    }

    // Tier 2: entry html + explicit assets (entry included) + explicit fallback.
    if (panel.blocks !== undefined) bad("a tier-2 panel declares fallback blocks, not blocks")
    const entry = typeof panel.entry === "string" ? panel.entry : ""
    if (!/\.html?$/i.test(entry)) bad("entry must be an .html document")
    const assets = Array.isArray(panel.assets) ? panel.assets.filter((a) => typeof a === "string") : []
    if (assets.length === 0) bad("a tier-2 panel must list every file it ships (entry included)")
    else {
      if (!assets.includes(entry)) bad("assets must include the entry document itself")
      if (assets.length - 1 > MAX_PANEL_EXTRA_ASSETS) {
        bad(`at most ${MAX_PANEL_EXTRA_ASSETS} assets beyond the entry`)
      }
      const entryDir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : ""
      for (const asset of assets) {
        if (entryDir !== "" && !asset.startsWith(`${entryDir}/`)) {
          bad(`${asset} is outside the entry's directory ${entryDir}`)
        }
        referenced.add(asset)
        if (!filePaths.has(asset)) {
          issues.push({ key: "packPanelMissingFile", params: { panel: id || `#${index + 1}`, file: asset } })
        }
      }
    }
    if (!("fallback" in panel))
      bad("fallback is required for a tier-2 panel (write `fallback: null` to opt out)")
    else if (Array.isArray(panel.fallback)) {
      if (panel.fallback.length === 0) bad("fallback must be a non-empty list of blocks (or null)")
      else {
        if (panel.fallback.length > MAX_PANEL_BLOCKS) bad(`fallback: at most ${MAX_PANEL_BLOCKS} blocks`)
        noteImageSrcs(validateTemplateBlocks(panel.fallback, "fallback", bad), id || `#${index + 1}`)
      }
    }
  }

  for (const path of filePaths) {
    if (!referenced.has(path)) issues.push({ key: "packPanelFileOrphan", params: { file: path } })
  }
  return issues
}

/** A kit media file ships as `assets/<fileName>`: it must stay a plain
 * basename so the resulting pack-relative path passes the engine's
 * confinement check (`core/presentation.py::_asset_path`). */
function checkKitFileName(fileName: string): string | null {
  if (fileName.includes("/")) return "must be a plain file name (kit files land directly under assets/, no /)"
  return checkAssetPath(`assets/${fileName}`)
}

/** Structural mirror of `core/presentation.py::parse_presentation_text` —
 * same enums, same caps, same slug rule, so a kit green here survives the
 * engine's re-parse at build. Subject/cue issues carry `uid` + `field` params
 * so the wizard stage renders them next to the offending input; duplicate
 * paths raised here carry `from: "presentation"` for step partitioning. The
 * pack-layer MIME rules (`core/pack.py::_enforce_kit_assets`) are the
 * engine's — the editor only soft-hints them by extension. */
function validatePresentationDraft(kit: PackPresentationDraft, seenFiles: Set<string>): Issue[] {
  const issues: Issue[] = []
  type GenerationMode = (typeof PRESENTATION_GENERATION_MODES)[number]
  type SubjectKind = (typeof PRESENTATION_SUBJECT_KINDS)[number]
  type AudioLayer = (typeof PRESENTATION_AUDIO_LAYERS)[number]

  const noteKitAssetPath = (path: string) => {
    if (seenFiles.has(path)) {
      issues.push({ key: "packDuplicatePath", params: { file: path, from: "presentation" } })
    }
    seenFiles.add(path)
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

  // The emitted file itself is capped (`core/presentation.py:MAX_PRESENTATION_FILE_BYTES`).
  const bytes = new TextEncoder().encode(buildPresentationYaml(kit)).length
  if (bytes > MAX_PRESENTATION_FILE_BYTES) {
    issues.push({ key: "packPresentationTooBig", params: { max: MAX_PRESENTATION_FILE_BYTES } })
  }
  return issues
}

/** `ui/presentation.yaml`, emitted exactly in the shape
 * `core/presentation.py::parse_presentation_text` accepts: `version: 2` and an
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
 * block and the source tree's binaries so every ref/cue passes the asset-block
 * membership check (`core/pack.py::_enforce_kit_assets`). */
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

/** The kit at a glance — the same numbers the engine's trust card discloses
 * (`core/pack.py`: `presentation` = subject count; `imagegen` = generation
 * allowed AND at least one subject ships a ref). */
export function presentationSummary(kit: PackPresentationDraft): {
  subjects: number
  withRefs: number
  audio: number
  mode: "allow" | "pack_only"
  imagegen: boolean
} {
  const withRefs = kit.subjects.filter((subject) => subject.refBase64 !== "").length
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

/** Manifest v2: a card entry is a plain path, or a `{path, notes}` mapping
 * when install notes exist. Authors NEVER declare `kind` — the engine rejects
 * a declared kind outright (`core/pack.py::_parse_card_entry`); detection at
 * build time is the single source of truth and stamps the built manifest. */
function cardEntryToYaml(card: PackCardDraft): unknown {
  const path = `cards/${card.fileName}`
  const notes = localized(card.notesEn, card.notesZh)
  if (Object.keys(notes).length === 0) return path
  return { path, notes }
}

export function buildManifestYaml(draft: WorldPackDraft): string {
  const contents: Record<string, unknown> = {}
  if (draft.skills.length > 0) contents.skills = draft.skills.map((skill) => `skills/${skill.slug}`)
  if (draft.rulepacks.length > 0) {
    contents.rulepacks = draft.rulepacks.map((rulepack) => `rulepacks/${rulepack.id}.yaml`)
  }
  if (draft.cards.length > 0) contents.cards = draft.cards.map(cardEntryToYaml)
  if (draft.lorebooks.length > 0) {
    contents.lorebooks = draft.lorebooks.map((lorebook) => `lorebooks/${lorebook.fileName}`)
  }
  if (draft.prep.length > 0) {
    contents.prep = draft.prep.map((script) => `${PREP_DIR}/${script.fileName}`)
  }
  if (draft.panels !== null) contents.panels = [PANELS_FILE_NAME]
  if (draft.presentation !== null) contents.presentation = [PRESENTATION_FILE_NAME]
  // NOTE: no `trust` block — it is generated at pack time; a hand-written one
  // is rejected by the engine (`parse_manifest_text(expect_trust=False)`).
  // Same for `files:` (the built archive's generated inventory) and card
  // `kind` (detection-stamped). `manifest_version` stays omitted — for an
  // AUTHOR manifest omission means "current" (`core/pack.py:318`).
  const manifest: Record<string, unknown> = {
    id: draft.id,
    version: draft.version,
    name: localized(draft.nameEn, draft.nameZh),
    description: localized(draft.descriptionEn, draft.descriptionZh),
    authors: draft.authors.map((author) => author.trim()).filter((author) => author.length > 0),
    license: draft.license.trim(),
    // Minimum engine versions (minimum-compare only; `protocol` + `server` are
    // the only keys the engine accepts). "2.0" mirrors the flagship reference
    // pack (`content/xipu-songdeng/pack.yaml`) and covers every content kind
    // the studio can emit.
    engine: { protocol: "2.0" },
    contents,
  }
  const kitFiles = draft.presentation !== null ? presentationKitFiles(draft.presentation) : []
  if (draft.assets.length > 0 || kitFiles.length > 0) {
    // Integrity fields (sha256/mime/size) are the engine's to fill at build.
    // Kit refs/cues MUST sit in this block (`core/pack.py::_enforce_kit_assets`).
    manifest.assets = [
      ...draft.assets.map((asset) => ({ path: `assets/${asset.fileName}` })),
      ...kitFiles.map((file) => ({ path: `assets/${file.fileName}` })),
    ]
  }
  return stringify(manifest, { lineWidth: 0 })
}

function joinHooks(hooks: string[]): string {
  return hooks
    .map((code, index) => (hooks.length > 1 ? `// --- hook ${index + 1} ---\n${code}` : code))
    .join("\n\n")
}

/** SKILL.md with the frontmatter `core.skills.parse_skill_text` expects. A
 * hand-written `skillMd` ships verbatim — the author owns the whole document. */
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

/** Lay out the full source tree. Callers hand the plan to the Rust side to
 * write, then run the engine CLI on the resulting directory. */
export function buildPackSourcePlan(draft: WorldPackDraft): PackSourcePlan {
  const files: PackTextFile[] = [{ path: "pack.yaml", contents: buildManifestYaml(draft) }]
  const binaries: PackBinaryFile[] = []

  for (const card of draft.cards) {
    if (card.jsonText !== undefined) {
      files.push({ path: `cards/${card.fileName}`, contents: card.jsonText })
    } else if (card.base64 !== undefined) {
      binaries.push({ path: `cards/${card.fileName}`, base64: card.base64 })
    }
  }
  for (const lorebook of draft.lorebooks) {
    files.push({ path: `lorebooks/${lorebook.fileName}`, contents: lorebook.jsonText })
  }
  for (const skill of draft.skills) {
    files.push({ path: `skills/${skill.slug}/SKILL.md`, contents: buildSkillMd(skill) })
    if (skill.hooks.length > 0) {
      files.push({ path: `skills/${skill.slug}/hooks.js`, contents: joinHooks(skill.hooks) })
    }
  }
  for (const rulepack of draft.rulepacks) {
    files.push({ path: `rulepacks/${rulepack.id}.yaml`, contents: rulepack.yamlText })
  }
  for (const asset of draft.assets) {
    binaries.push({ path: `assets/${asset.fileName}`, base64: asset.base64 })
  }
  for (const script of draft.prep) {
    files.push({ path: `${PREP_DIR}/${script.fileName}`, contents: script.source })
  }
  if (draft.panels !== null) {
    files.push({ path: PANELS_FILE_NAME, contents: draft.panels.yamlText })
    for (const file of draft.panels.files) {
      if (file.contents !== undefined) files.push({ path: file.path, contents: file.contents })
      else if (file.base64 !== undefined) binaries.push({ path: file.path, base64: file.base64 })
    }
  }
  if (draft.presentation !== null) {
    files.push({ path: PRESENTATION_FILE_NAME, contents: buildPresentationYaml(draft.presentation) })
    for (const file of presentationKitFiles(draft.presentation)) {
      binaries.push({ path: `assets/${file.fileName}`, base64: file.base64 })
    }
  }

  return { dirName: draft.id, files, binaries }
}
