// The advisory pack lint's data model: what it reads, and what it says.
//
// ADVISORY, always. The engine CLI is the only authority on whether a pack
// builds — `core/pack.py` re-validates everything at build time and refuses
// what it must. This lint catches the other class of defect: packs that build
// perfectly and then do nothing, or do it only for the keeper. Nothing here
// blocks a build; a finding is a sentence pointing at one thing.

export type PackLintSeverity = "warn" | "info"

export type PackLintRuleId =
  /** Declared, then never mentioned by lore, panel or code. */
  | "variableUnused"
  /** No keys, not constant, no condition — the entry can never fire. */
  | "loreNeverActivates"
  /** A bilingual field with one side filled and the other empty. */
  | "bilingualGap"
  /** A player-facing panel bound to a keeper-only variable: it renders blank. */
  | "panelBindsHiddenVariable"
  /** A panel bound to a variable this pack never declares. */
  | "panelBindsUnknownVariable"
  /** Hook / update-rule code touching a variable id nothing declares. */
  | "codeUnknownVariable"
  /** The wizard's draft stub, shipped as-is. */
  | "stubMarker"
  /** Pack metadata a reader needs and the manifest allows to be thin. */
  | "packMetadataThin"
  /** An asset referenced by a panel or the kit that the pack does not ship. */
  | "assetMissing"
  /** Content tagged to an episode this pack never declares. */
  | "episodeUnknown"
  /** An episode that will ship with no release notes. */
  | "episodeNoNotes"
  /** An earlier episode's content naming something a later one introduces. */
  | "episodeForwardReference"
  /** A hook handler reading a key its event's payload does not carry — always
   * undefined at run time, and silent about it. */
  | "hookUnknownEventField"

export type PackLintTargetKind = "variable" | "lore" | "panel" | "code" | "pack" | "asset" | "episode"

export interface PackLintTarget {
  kind: PackLintTargetKind
  /** Stable handle within the kind — a variable id, a panel id, a lore title,
   * a code origin. Used by the UI to point at the offending thing. */
  id: string
}

export interface PackLintFinding {
  ruleId: PackLintRuleId
  severity: PackLintSeverity
  /** i18n key under `studio.lint.msg.` plus its params. The message is a key,
   * not a string, because every user-facing string in this repo is — see
   * `bun run i18n:lint`. */
  key: string
  params: Record<string, string | number>
  target: PackLintTarget
}

export interface LintVariable {
  id: string
  labelEn: string
  labelZh: string
  visibility: "player" | "keeper"
}

export interface LintLoreEntry {
  /** Display handle (title, or a positional fallback the adapter supplies). */
  id: string
  title: string
  content: string
  /** Serialized-module tag ("" / absent = evergreen). */
  episode?: string
  /** Trigger keywords, comma/newline separated exactly as authored. */
  keys: string
  condition: string
  constant: boolean
  enabled: boolean
}

export interface LintCodeBlock {
  /** Where the code came from: `hooks`, a skill slug, an update-rule name. */
  origin: string
  source: string
}

export interface LintPackMeta {
  id: string
  nameEn: string
  nameZh: string
  descriptionEn: string
  descriptionZh: string
  license: string
}

/** One pack-relative media reference made outside `ui/panels.yaml` (the
 * presentation kit's subject refs and audio cues). */
export interface LintAssetRef {
  path: string
  from: string
}

/** What the lint needs to know about one installment. */
export interface LintEpisode {
  id: string
  ordinal: number
  title: string
  releaseNotes: string
}

export interface PackLintSource {
  /** Null in the forge, where there is no pack yet: the pack rules go quiet. */
  meta: LintPackMeta | null
  variables: LintVariable[]
  lore: LintLoreEntry[]
  /** Raw `ui/panels.yaml`; null when the pack ships no panels. */
  panelsYaml: string | null
  code: LintCodeBlock[]
  /** Serialized installments, and the ordinal the next build stops at. Empty
   * episodes means an ordinary one-shot pack and the episode rules go quiet. */
  episodes: LintEpisode[]
  buildUpTo: number
  /** Every media file the pack ships, as a pack-relative path — `assets/…` for
   * dropped assets and kit media, `ui/…` for panel files. A panel's `src` can
   * name either (`ui/handouts/page.png` is as legal as `assets/cover.png`), so
   * the missing-asset rule needs one list, not two. */
  shippedFiles: string[]
  assetRefs: LintAssetRef[]
  /** Every FILE carrying an episode tag, whatever its kind. Lore entries carry
   * their own tags and are checked through `lore`, but an asset has no entries
   * to hide a typo in — and neither does a PNG card, whose tag lives only on
   * the item. Without this list the whole-file tag was checked for nobody. */
  taggedFiles: LintTaggedFile[]
}

export interface LintTaggedFile {
  /** Pack-relative path, for the finding's own text. */
  path: string
  episode: string
}

export function emptyLintSource(): PackLintSource {
  return {
    meta: null,
    variables: [],
    lore: [],
    panelsYaml: null,
    code: [],
    episodes: [],
    buildUpTo: 0,
    shippedFiles: [],
    assetRefs: [],
    taggedFiles: [],
  }
}
