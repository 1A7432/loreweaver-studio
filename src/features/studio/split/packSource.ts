// World-half → `.lwpack` SOURCE directory. The studio deliberately does NOT
// zip anything: validation and byte-determinism have exactly one source of
// truth — the engine (`python -m app --pack <dir>` / `loreweaver-server
// --pack`). This module only plans the source tree (pack.yaml + cards +
// lorebooks + skills + rulepack patches) that the engine CLI then builds.
// Field names and constraints mirror `core/pack.py`.

import { parse, stringify } from "yaml"
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
  /** M15 module-UI panels; null when the pack ships none. */
  panels: PackPanelsDraft | null
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
  if (draft.panels !== null) issues.push(...validatePanelsDraft(draft.panels, seenFiles))
  return issues
}

/** Structural mirror of `core/panels.py::parse_panels_text` — the shape-level
 * rules that decide whether the engine will even look at the file (slug/slot/
 * audience enums, tier-1 vs tier-2 key sets, asset confinement, caps). Deep
 * block validation stays the ENGINE's job; its build error lands in the wizard
 * terminal. Detail strings are author diagnostics, technical English on
 * purpose (same stance as the engine's). */
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
      else if (blocks.length > MAX_PANEL_BLOCKS) bad(`at most ${MAX_PANEL_BLOCKS} blocks`)
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
  }

  for (const path of filePaths) {
    if (!referenced.has(path)) issues.push({ key: "packPanelFileOrphan", params: { file: path } })
  }
  return issues
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
  if (draft.panels !== null) contents.panels = [PANELS_FILE_NAME]
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
  if (draft.assets.length > 0) {
    // Integrity fields (sha256/mime/size) are the engine's to fill at build.
    manifest.assets = draft.assets.map((asset) => ({ path: `assets/${asset.fileName}` }))
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
  if (draft.panels !== null) {
    files.push({ path: PANELS_FILE_NAME, contents: draft.panels.yamlText })
    for (const file of draft.panels.files) {
      if (file.contents !== undefined) files.push({ path: file.path, contents: file.contents })
      else if (file.base64 !== undefined) binaries.push({ path: file.path, base64: file.base64 })
    }
  }

  return { dirName: draft.id, files, binaries }
}
