// Moving a file to the room (protocol 3.0 §11.2–11.4): the control half is the session's
// `call media.offer`, the byte half a PUT the Rust side makes (`src-tauri/src/media.rs`), so a
// file's bytes never enter the WebView. Downloads go the same way (`panels/assets.ts`).
//
// Every way this can fail comes back as a `ByteFailure`: a refusal the server worded (an offer
// refused on the control stream, an error line on the byte channel) keeps the server's own
// message, already in this member's language; anything else is one of this client's codes,
// which the UI words (`play.transfer.error.*`).

import { invoke } from "@tauri-apps/api/core"
import {
  decodeMediaOfferResult,
  type ByteFile,
  type MediaOfferParams,
  type Result,
  type UploadPurpose,
} from "loreweaver-protocol/v3"
import type { Connection } from "./connection"

/** Everything `media.offer` has to say about a file, computed natively. */
export type PreparedFile = Omit<MediaOfferParams, "purpose">

export class ByteFailure extends Error {
  readonly code: string
  /** The server said it: `message` is its words, in this member's language. */
  readonly server: boolean

  constructor(code: string, message = code, server = false) {
    super(message)
    this.name = "ByteFailure"
    this.code = code
    this.server = server
  }
}

/** What a native command or the session rejected with, as a `ByteFailure`. */
export function toByteFailure(error: unknown): ByteFailure {
  if (error instanceof ByteFailure) return error
  if (typeof error === "object" && error !== null && "code" in error) {
    const record = error as { code: unknown; message?: unknown; server?: unknown }
    return new ByteFailure(
      String(record.code),
      typeof record.message === "string" ? record.message : String(record.code),
      record.server === true,
    )
  }
  return new ByteFailure("failed", error instanceof Error ? error.message : String(error))
}

/** Read and hash a file natively; refuses a type the purpose does not take before the server has to. */
export async function mediaPrepare(path: string, purpose: UploadPurpose): Promise<PreparedFile> {
  try {
    return await invoke<PreparedFile>("media_prepare", { path, purpose })
  } catch (error) {
    throw toByteFailure(error)
  }
}

/** PUT an accepted upload; answers the server's receipt (checked natively against what was sent). */
export async function mediaUpload(path: string, uploadId: string, expectedSha256: string): Promise<ByteFile> {
  try {
    return await invoke<ByteFile>("media_upload", { path, uploadId, expectedSha256 })
  } catch (error) {
    throw toByteFailure(error)
  }
}

/** The native steps an upload takes, injectable for tests. */
export interface UploadSteps {
  prepare: (path: string, purpose: UploadPurpose) => Promise<PreparedFile>
  put: (path: string, uploadId: string, sha256: string) => Promise<ByteFile>
}

export const NATIVE_UPLOAD: UploadSteps = { prepare: mediaPrepare, put: mediaUpload }

/**
 * Upload the file at `path` for `purpose`: prepare it, offer it, and send the bytes unless the
 * room already holds them. Resolves with the file as the server keeps it (its `hash` is what
 * `import {file}` names). Rejects with a `ByteFailure`.
 */
export async function uploadFile(
  connection: Connection,
  path: string,
  purpose: UploadPurpose,
  steps: UploadSteps = NATIVE_UPLOAD,
): Promise<ByteFile> {
  const file = await steps.prepare(path, purpose)
  let result: Result
  try {
    result = await connection.session.call("media.offer", { ...file, purpose })
  } catch (error) {
    throw toByteFailure(error)
  }
  if (!result.ok) throw new ByteFailure(result.error.code, result.error.message, true)
  const offer = decodeMediaOfferResult(result.data)
  if (offer === null) throw new ByteFailure("bad_reply")
  if ("existing" in offer) {
    const { hash, size, mime, name } = offer.existing
    return { hash, size, mime, name }
  }
  return steps.put(path, offer.upload_id, file.sha256)
}
