// What went wrong with the file you just dropped, in terms you can act on.
//
// Import failures used to reach the UI as raw `Error.message` strings —
// "unsupportedFormat", "not a PNG file", or a `yaml` parser's own English. The
// author is left to guess whether the file was the wrong KIND, the right kind
// in a broken state, or fine but unreadable here.
//
// Every failure now resolves to an i18n key plus params, and every message says
// the same two things: what shape was expected, and what was found instead.

import { CardParseError } from "./split/charcard"
import { explainInitvar } from "./split/mvu"
import type { Issue } from "./model"

/** The extension the file arrived with, lower-cased, or "" — the messages lean
 * on it to say what was expected ("a .png with an embedded card"). */
function extensionOf(fileName: string): string {
  return /\.([^.]+)$/.exec(fileName.toLowerCase())?.[1] ?? ""
}

/** Curate one thrown import failure.
 *
 * `CardParseError` already carries a key (`charcard.ts`, `lorecard.ts`); this
 * maps it into the `studio.importErr.*` namespace and attaches the file name so
 * a batch drop says WHICH file. Anything else is an unexpected failure and
 * keeps its own message — inventing a friendly cause for an error we do not
 * recognize would be worse than showing the truth. */
export function describeImportFailure(cause: unknown, fileName: string): Issue {
  const file = fileName || "?"
  if (cause instanceof CardParseError) {
    return {
      key: `importErr.${cause.key}`,
      params: { file, ext: extensionOf(fileName), detail: cause.message.split(": ").slice(1).join(": ") },
    }
  }
  return {
    key: "importErr.unknown",
    params: { file, detail: cause instanceof Error ? cause.message : String(cause) },
  }
}

/** The failure of one `[InitVar]` block, with the position when the parser
 * gives one. Returns null when the block parses. */
export function describeInitvarFailure(source: string, where: string): Issue | null {
  const diagnosis = explainInitvar(source)
  if (diagnosis.ok) return null
  // Two syntax keys rather than a conditional clause inside one: a sentence
  // that has to work with and without a line number reads badly in both
  // languages, and the parser only sometimes gives us one.
  const reason = diagnosis.reason === "syntax" && diagnosis.line !== null ? "syntaxAt" : diagnosis.reason
  return {
    key: `importErr.initvar.${reason}`,
    params: { where, detail: diagnosis.detail, line: diagnosis.line ?? 0 },
  }
}
