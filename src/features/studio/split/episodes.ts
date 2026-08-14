// Serialized modules (连载模组): one pack, cumulative versions.
//
// The design, settled with the owner on 2026-08-15 and implemented as written:
//
//   A serialized work is a SINGLE pack whose release at episode N contains
//   episodes 1..N. An episode is an authoring-time grouping and a release
//   checkpoint — never a separate pack.
//
// That falls out of the engine's own update semantics rather than being
// imposed on them: re-importing a pack replaces content by source, and an
// InitVar merge preserves player progress, so shipping 1..N again is exactly
// how a reader gets the new chapter without losing their game. It also makes
// spoiler-safety structural instead of procedural: the file circulating at
// version N contains no future-episode content at all, so there is no gating
// machinery to get wrong, and nothing to leak.
//
// Versioning convention: MINOR is the episode (`1.4.x` carries episodes 1–4).
// Surfaced, never enforced — an author who versions differently is not wrong,
// they are just not using the convention, and a build that refused them would
// be inventing a rule the engine does not have.

/** One installment. `id` is the stable handle content is tagged with; `ordinal`
 * is what "up to episode N" compares against. */
export interface PackEpisode {
  id: string
  ordinal: number
  title: string
  summary: string
  /** What changed in this installment — the CHANGELOG entry. */
  releaseNotes: string
}

/** Anything an author can tag. Untagged means episode 1 / evergreen: a pack
 * that never heard of episodes must keep building exactly as it did. */
export interface EpisodeTagged {
  episode?: string
}

export const EPISODE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** The ordinal an episode id resolves to, or null when nothing declares it.
 * Null is the lint's business, not the build's — see {@link includedInBuild}. */
export function ordinalOf(episodes: PackEpisode[] | undefined, id: string | undefined): number | null {
  const tag = (id ?? "").trim()
  if (!tag) return 1
  const match = (episodes ?? []).find((episode) => episode.id === tag)
  return match?.ordinal ?? null
}

/** Is this content in the build that goes "up to episode N"?
 *
 * Untagged content is evergreen and always in. An unknown tag is INCLUDED, on
 * purpose: a typo must not silently drop an author's work out of the release,
 * and the lint says so loudly instead. Dropping content is the one failure
 * mode a build cannot be forgiven for — the author would ship a hole. */
export function includedInBuild(
  episodes: PackEpisode[] | undefined,
  item: EpisodeTagged,
  upTo: number,
): boolean {
  const ordinal = ordinalOf(episodes, item.episode)
  return ordinal === null || ordinal <= upTo
}

/** The highest ordinal any episode declares (0 when there are none).
 *
 * Tolerates a missing list: a draft assembled before serialization existed —
 * or by a script that is not typechecked — simply has no episodes, and that is
 * an ordinary one-shot pack, not an error. */
export function latestOrdinal(episodes: PackEpisode[] | undefined): number {
  return (episodes ?? []).reduce((max, episode) => Math.max(max, episode.ordinal), 0)
}

/** Episodes 1..upTo, in order. */
export function episodesUpTo(episodes: PackEpisode[] | undefined, upTo: number): PackEpisode[] {
  return (episodes ?? [])
    .filter((episode) => episode.ordinal <= upTo)
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
}

/** The version the convention suggests for a build up to episode N: MINOR is
 * the episode. Advice for the UI, never applied behind the author's back. */
export function suggestedVersion(current: string, upTo: number): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(current.trim())
  if (match === null) return current
  const [, major, , patch, suffix] = match
  return `${major}.${upTo}.${patch}${suffix}`
}

/** Does the version already follow the convention for this build? */
export function versionMatchesConvention(version: string, upTo: number): boolean {
  const match = /^(\d+)\.(\d+)\./.exec(version.trim())
  return match !== null && Number(match[2]) === upTo
}

/**
 * `CHANGELOG.md` for the pack source, from the release-notes chain of every
 * episode in this build.
 *
 * Newest first, the way a reader scans one. The Bomb-3 `--publish`/`--update`
 * rails will consume this file; until then it is still the thing a subscriber
 * reads to find out what the new chapter is.
 *
 * Returns "" when nothing has release notes — an empty changelog is worse than
 * no changelog, and the lint already asks for the notes.
 */
export function buildChangelog(
  packName: string,
  version: string,
  episodes: PackEpisode[] | undefined,
  upTo: number,
): string {
  const included = episodesUpTo(episodes, upTo)
  if (included.length === 0) return ""
  const lines = [`# ${packName || "Changelog"}`, ""]
  let wroteAny = false
  for (const episode of [...included].reverse()) {
    const notes = episode.releaseNotes.trim()
    const title = episode.title.trim() || episode.id
    // The version stamp only belongs on the episode this build releases; the
    // earlier ones shipped under their own.
    const stamp = episode.ordinal === upTo && version.trim() ? ` — ${version.trim()}` : ""
    lines.push(`## ${episode.ordinal}. ${title}${stamp}`, "")
    if (episode.summary.trim()) lines.push(episode.summary.trim(), "")
    if (notes) {
      lines.push(notes, "")
      wroteAny = true
    }
  }
  return wroteAny ? `${lines.join("\n").trimEnd()}\n` : ""
}

// --- filtering a built artifact ---------------------------------------------

/** The studio-private tag it writes onto an exported entry/pregen. It exists so
 * a later "build up to episode N" can still tell which installment a piece of
 * content belongs to; it is STRIPPED from everything written into a pack, so no
 * built artifact ever carries it. */
export const EPISODE_FIELD = "episode"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function keepEntry(episodes: PackEpisode[] | undefined, raw: unknown, upTo: number): boolean {
  if (!isRecord(raw)) return true
  const tag = raw[EPISODE_FIELD]
  return includedInBuild(episodes, { episode: typeof tag === "string" ? tag : undefined }, upTo)
}

function stripTag(raw: unknown): unknown {
  if (!isRecord(raw) || raw[EPISODE_FIELD] === undefined) return raw
  const rest = { ...raw }
  delete rest[EPISODE_FIELD]
  return rest
}

function filterList(episodes: PackEpisode[] | undefined, raw: unknown, upTo: number): unknown {
  if (Array.isArray(raw)) {
    return raw.filter((entry) => keepEntry(episodes, entry, upTo)).map(stripTag)
  }
  if (isRecord(raw)) {
    // A SillyTavern world-info export keys its entries by index string.
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      if (keepEntry(episodes, value, upTo)) kept[key] = stripTag(value)
    }
    return kept
  }
  return raw
}

/**
 * Drop every future-episode entry from one card/lorebook JSON, and strip the
 * studio's tag from what survives.
 *
 * The three shapes a pack can carry, all handled because the pack bench takes
 * whatever the author drops:
 *   - lorecard v1 (`{format: "loreweaver.card", worldbook, pregens}`),
 *   - a SillyTavern card (`{spec, data: {character_book: {entries}}}`, and the
 *     unwrapped v1 shape),
 *   - a plain world-info export (`{entries}`, list or index-keyed map).
 *
 * Returns the text unchanged when it is not JSON, when the pack has no
 * episodes, or when nothing was tagged — a one-shot pack's bytes must be
 * byte-identical to what they were before serialization existed.
 */
export function filterEpisodeContent(
  jsonText: string,
  episodes: PackEpisode[] | undefined,
  upTo: number,
): string {
  if ((episodes ?? []).length === 0) return jsonText
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return jsonText
  }
  if (!isRecord(parsed)) return jsonText

  const next = { ...parsed }
  let touched = false
  const apply = (holder: Record<string, unknown>, key: string) => {
    const before = holder[key]
    if (before === undefined) return
    const after = filterList(episodes, before, upTo)
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      holder[key] = after
      touched = true
    }
  }

  apply(next, "worldbook")
  apply(next, "pregens")
  apply(next, "entries")
  if (isRecord(next.character_book)) {
    const book = { ...next.character_book }
    apply(book, "entries")
    next.character_book = book
  }
  if (isRecord(next.data)) {
    const data = { ...next.data }
    if (isRecord(data.character_book)) {
      const book = { ...data.character_book }
      apply(book, "entries")
      data.character_book = book
    }
    next.data = data
  }

  return touched ? `${JSON.stringify(next, null, 2)}\n` : jsonText
}
