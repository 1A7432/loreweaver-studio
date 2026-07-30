// World-half → `.lwpack` SOURCE directory. The studio deliberately does NOT
// zip anything: validation and byte-determinism have exactly one source of
// truth — the engine (`python -m app --pack <dir>` / `loreweaver-server
// --pack`). This module only plans the source tree (pack.yaml + cards +
// lorebooks + skills + rulepack patches) that the engine CLI then builds.
// Field names and constraints mirror `core/pack.py`.

import { stringify } from "yaml"
import type { Issue } from "../model"

export const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/
export const MAX_HOOK_SOURCE_CHARS = 40_000
const MAX_NOTE_CHARS = 2_000

export interface PackCardDraft {
  /** File name under `cards/` (already sanitized, extension included). */
  fileName: string
  kind: "character" | "world"
  /** Exactly one of these: JSON card text, or original PNG bytes. */
  jsonText?: string
  base64?: string
  /** Structural detection result for this card (drives kind enforcement). */
  hasWorldPayloads: boolean
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
    // The engine's `_enforce_card_kind`: world machinery ⇒ `kind: world`.
    if (card.hasWorldPayloads && card.kind !== "world") {
      issues.push({ key: "packCardKindMismatch", params: { file: card.fileName } })
    }
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
  for (const skill of draft.skills) {
    if (!PACK_ID_RE.test(skill.slug)) {
      issues.push({ key: "packSkillSlugInvalid", params: { file: skill.slug } })
    }
    const joined = joinHooks(skill.hooks)
    if (joined.length > MAX_HOOK_SOURCE_CHARS) {
      issues.push({ key: "packHooksTooLong", params: { file: skill.slug, max: MAX_HOOK_SOURCE_CHARS } })
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
  return issues
}

function localized(en: string, zh: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (en.trim()) out.en = en.trim()
  if (zh.trim()) out.zh = zh.trim()
  return out
}

/** A card entry dumps to a plain path when it carries no declarations (the
 * engine round-trips old manifests that way) and to a mapping otherwise. */
function cardEntryToYaml(card: PackCardDraft): unknown {
  const path = `cards/${card.fileName}`
  const notes = localized(card.notesEn, card.notesZh)
  if (card.kind === "character" && Object.keys(notes).length === 0) return path
  const entry: Record<string, unknown> = { path, kind: card.kind }
  if (Object.keys(notes).length > 0) entry.notes = notes
  return entry
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
  // NOTE: no `trust` block — it is generated at pack time; a hand-written one
  // is rejected by the engine (`parse_manifest_text(expect_trust=False)`).
  const manifest: Record<string, unknown> = {
    id: draft.id,
    version: draft.version,
    name: localized(draft.nameEn, draft.nameZh),
    description: localized(draft.descriptionEn, draft.descriptionZh),
    authors: draft.authors.map((author) => author.trim()).filter((author) => author.length > 0),
    license: draft.license.trim(),
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

/** SKILL.md with the frontmatter `core.skills.parse_skill_text` expects. */
export function buildSkillMd(skill: PackSkillDraft): string {
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

  return { dirName: draft.id, files, binaries }
}
