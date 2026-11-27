// The words for moving a file to or from the room, and whether this member may upload at all.
// A refusal the server worded is shown as it came (already in this member's language); a
// failure on this side of the link is worded here, from its code.

import type { TFunction } from "i18next"
import { stripControlChars, type SessionSnapshot } from "loreweaver-protocol/v3"
import { toByteFailure } from "../../lib/media"
import { viewData } from "./room"

/** This client's own failure codes that have words of their own (`play.transfer.error.*`). */
const WORDED = new Set([
  "bad_type",
  "not_a_file",
  "too_large",
  "unreadable",
  "changed",
  "receipt_mismatch",
  "not_connected",
  "no_shell",
  "stalled",
  "timeout",
  "hash_mismatch",
  "not_html",
  "not_a_save",
  "size_mismatch",
])

/** What a person reads for a failed upload, fetch or file read. */
export function transferErrorText(error: unknown, t: TFunction): string {
  const failure = toByteFailure(error)
  if (failure.server && failure.message.trim() !== "") return stripControlChars(failure.message)
  if (WORDED.has(failure.code)) return t(`play.transfer.error.${failure.code}`)
  return t("play.transfer.error.generic", { code: failure.code })
}

/**
 * Why this member may not upload now, or null when nothing on this side says so: an observer
 * never uploads; nobody does while the `room` view says the switch is off. (The server decides
 * in the end; this only keeps a control from offering what it would refuse.)
 */
export function uploadBlocked(snapshot: SessionSnapshot | null): "observer" | "off" | null {
  const role = viewData(snapshot, "me")?.member.role ?? snapshot?.welcome?.you.role ?? null
  if (role === "observer") return "observer"
  if (viewData(snapshot, "room")?.uploads === false) return "off"
  return null
}
