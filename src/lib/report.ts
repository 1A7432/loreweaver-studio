// The session report as a page (protocol 3.0 §6.8): `report {format: "html"}` answers with a
// reference to the page — `data.media` `{hash, mime, size, name}` — not the page itself. The
// native side (`src-tauri/src/report.rs`) fetches it by hash over the byte channel and
// verifies it, into a cache of its own, before anything can save or open it. The bytes never
// enter the WebView: the only two ways out are a file the person saves and the system browser.
// A new page replaces the room's previous one of its edition, so a page is fetched at once.

import { invoke } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { isContentHash, type Result } from "loreweaver-protocol/v3"
import { toByteFailure } from "./media"

export interface ReportOffer {
  readonly hash: string
  readonly name: string
  readonly edition: "player" | "reveal"
}

/** The page a `report` result offers, or null when it is not a report page. */
export function reportOffer(result: Result | null): ReportOffer | null {
  if (result === null || !result.ok) return null
  const data = result.data as
    | { format?: unknown; edition?: unknown; media?: { hash?: unknown; mime?: unknown; name?: unknown } }
    | null
    | undefined
  if (typeof data !== "object" || data === null || data.format !== "html") return null
  const media = data.media
  if (typeof media !== "object" || media === null || media.mime !== "text/html") return null
  if (!isContentHash(media.hash)) return null
  return {
    hash: media.hash,
    name: typeof media.name === "string" ? media.name : "",
    edition: data.edition === "reveal" ? "reveal" : "player",
  }
}

/** Pull an offered page into the verified report cache; answers its size. Rejects with a
 * `ByteFailure`: the server's own words for a refusal (a replaced page, a reveal edition on a
 * connection that is not an admin's: `media_not_found`), or `not_html`, `hash_mismatch`, … */
export async function reportFetch(hash: string): Promise<number> {
  try {
    return await invoke<number>("report_fetch", { hash })
  } catch (error) {
    throw toByteFailure(error)
  }
}

/** Copy a fetched report to the path the save dialog returned. */
export function reportSave(hash: string, path: string): Promise<number> {
  return invoke<number>("report_save", { hash, path })
}

/** Ask where to save a fetched page and copy it there; the path written, or null when cancelled. */
export async function saveReportAs(offer: ReportOffer): Promise<string | null> {
  const path = await save({
    defaultPath: safeReportName(offer.name, offer.hash),
    filters: [{ name: "HTML", extensions: ["html"] }],
  })
  if (path === null) return null
  await reportSave(offer.hash, path)
  return path
}

/** Open a fetched report in the system browser under `name` (which must
 * already be {@link safeReportName}'s output — the native side only checks
 * it). Answers the opened path. */
export function reportOpen(hash: string, name: string): Promise<string> {
  return invoke<string>("report_open", { hash, name })
}

/** Longest stem kept, in UTF-8 bytes — file systems cap a name at 255 BYTES,
 * and a CJK character is three of them. Cut on code points, never mid-character.
 * The native check (`report::MAX_NAME_BYTES`) leaves room for the extension. */
const MAX_STEM_BYTES = 200

function utf8Length(char: string): number {
  const code = char.codePointAt(0) ?? 0
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

function capBytes(text: string, limit: number): string {
  let out = ""
  let used = 0
  for (const char of text) {
    used += utf8Length(char)
    if (used > limit) break
    out += char
  }
  return out
}

// C0/C1 controls (newline and tab included — a file name has no use for
// either) plus the invisible formatting and bidi controls that can make a
// name read as something it is not (`report\u202Elmth.exe`).
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
/** Unpaired UTF-16 surrogates: not a character at all, and not JSON the native side can read. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
/** What Windows forbids in a file name (separators are handled before this). */
const RESERVED_CHARS = /[<>:"|?*]/g
/** Windows device names, reserved whatever the extension. */
const RESERVED_STEM = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i

/** The server-suggested name reduced to a safe base file name ending in `.html`.
 *
 * `name` is untrusted: only its base name survives (no directory, no `..`),
 * controls are dropped, reserved characters become `-`, a Windows device name
 * is defused, and an unusable result falls back to one built from the hash.
 * Same rule as the reference client's `safeReportName`, plus the device names
 * and invisible characters a desktop app also has to care about. */
export function safeReportName(name: string, hash: string): string {
  const base = (
    String(name ?? "")
      .replace(INVISIBLE, "")
      .replace(LONE_SURROGATE, "")
      .split(/[\\/]/)
      .pop() ?? ""
  )
    .replace(RESERVED_CHARS, "-")
    .replace(/^[.\s]+|[.\s]+$/g, "")
  let stem = capBytes(base.replace(/\.html?$/i, ""), MAX_STEM_BYTES).replace(/[.\s]+$/, "")
  if (RESERVED_STEM.test(stem)) stem = `_${stem}`
  if (!stem) {
    const tag = hash
      .toLowerCase()
      .replace(/[^0-9a-f]/g, "")
      .slice(0, 12)
    return `loreweaver-report-${tag || "untitled"}.html`
  }
  return `${stem}.html`
}
