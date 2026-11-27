// How the connect form words a connection that ended without being asked to:
// each code in its own sentence, in the UI's language. The codes come from
// three places — the Rust link (`LinkCloseCode`), the connection owner
// (`OwnerCloseCode`, plus `no_shell` outside the app) and the server's fatal
// `error` frames (protocol 3.0 §4.5) — and an unknown one still says something.

import type { TFunction } from "i18next"
import type { ConnectionFailure } from "../../lib/connection"

/** Link and owner codes with a sentence of their own (`connect.error.<code>`). */
const LINK_CODES: ReadonlySet<string> = new Set([
  "invalid_ticket",
  "bind_failed",
  "dial_timeout",
  "dial_failed",
  "protocol_violation",
  "closed_by_peer",
  "connection_lost",
  "welcome_timeout",
  "ping_timeout",
  "send_failed",
  "no_shell",
])

/** The fatal `error` codes of protocol 3.0 §4.5 (`connect.refused.<code>`). */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
  "protocol_mismatch",
  "bad_key",
  "bad_name",
  "hello_first",
  "bad_frame",
])

export interface FailureText {
  /** Our sentence. */
  readonly text: string
  /** The server's own words (already in this member's language), when it gave any. */
  readonly detail?: string
}

export function describeFailure(failure: ConnectionFailure, t: TFunction): FailureText {
  switch (failure.kind) {
    case "refused": {
      const text = REFUSAL_CODES.has(failure.code)
        ? t(`connect.refused.${failure.code}`)
        : t("connect.refused.other", { code: failure.code })
      return failure.message ? { text, detail: failure.message } : { text }
    }
    case "link":
      return {
        text: LINK_CODES.has(failure.code)
          ? t(`connect.error.${failure.code}`)
          : t("connect.error.other", { code: failure.code }),
      }
    case "lost":
      return { text: t("connect.lost") }
  }
}
