// A room save as a file (protocol 3.0 §6.7 `save`, §11). The save is the whole room — every
// secret of it — and it never travels in a frame: `save {op: "export"}` stores it on the server
// where only admins can fetch it and answers `data {documents, events, media: {hash, mime, size,
// name}}`; restoring offers the file with `media.offer {purpose: "save"}`, sends it, and runs
// `save {op: "import", file: <hash>}`.
//
// The bytes never enter the WebView, either way: the native side (`src-tauri/src/save.rs`)
// fetches a save over the byte channel, checks it against the answer's hash and size, and writes
// it — private to this user — only to the path the admin picked in the native save dialog; it
// reads and sends a save the admin picked to restore. This module holds no save and parses none.

import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import { isContentHash, type ByteFile, type Result } from "loreweaver-protocol/v3"
import type { Connection } from "./connection"
import { toByteFailure, uploadFile, type PreparedFile } from "./media"
import { isTauri } from "./transport"

/** The type a save travels as, both ways. */
export const SAVE_MIME = "application/json"

/**
 * The largest save this client fetches or sends: the server's default limit for one save file
 * (`MAX_SAVE_FILE_BYTES`, `docs/protocol.md` §12.4). The protocol package does not state it, so
 * it is kept here, equal to the native side's `MAX_SAVE_BYTES` — a server configured lower still
 * refuses with its own coded answer.
 */
export const MAX_SAVE_BYTES = 256 * 1024 * 1024
/** The limit in the unit a person reads. */
export const SAVE_LIMIT_MB = Math.round(MAX_SAVE_BYTES / (1024 * 1024))

/** The file a `save` export answered with. */
export interface SaveOffer {
  readonly hash: string
  readonly size: number
  readonly name: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** The save file a result names, or null when the result is not a save export's answer. */
export function savedFile(result: Result | null): SaveOffer | null {
  if (result === null || !result.ok || !isPlainObject(result.data)) return null
  const { documents, events, media } = result.data
  if (!isCount(documents) || !isCount(events) || !isPlainObject(media)) return null
  if (media.mime !== SAVE_MIME || !isContentHash(media.hash) || !isCount(media.size)) return null
  return { hash: media.hash, size: media.size, name: typeof media.name === "string" ? media.name : "" }
}

/** "512 B", "12.3 KB", "4.5 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Where to write a save: the native save dialog's answer, or null when cancelled or outside the app. */
export async function pickSaveDestination(defaultName: string, label: string): Promise<string | null> {
  if (!isTauri()) return null
  const path = await save({ defaultPath: defaultName, filters: [{ name: label, extensions: ["json"] }] })
  return typeof path === "string" ? path : null
}

/** Which save file to restore: its path (the native side reads it), or null. */
export async function pickSaveSource(label: string): Promise<string | null> {
  if (!isTauri()) return null
  const path = await open({ multiple: false, filters: [{ name: label, extensions: ["json"] }] })
  return typeof path === "string" ? path : null
}

/**
 * Fetch the save an export named over the byte channel and write it at `path` (checked against
 * the answer's hash and size first). Answers the bytes written. Rejects with a `ByteFailure`: the
 * server's own words for a refusal (`media_not_found` once a newer export replaced it), or one of
 * this client's codes (`size_mismatch`, `hash_mismatch`, `not_a_save`, `write_failed`, …).
 */
export async function saveFetch(offer: SaveOffer, path: string): Promise<number> {
  try {
    return await invoke<number>("save_fetch", { hash: offer.hash, size: offer.size, path })
  } catch (error) {
    throw toByteFailure(error)
  }
}

/** Read and hash a save file natively: what its offer says (refuses `not_a_save`, `too_large`, …). */
export async function savePrepare(path: string): Promise<PreparedFile> {
  try {
    return await invoke<PreparedFile>("save_prepare", { path })
  } catch (error) {
    throw toByteFailure(error)
  }
}

/** PUT an accepted save upload natively; answers the server's receipt. */
export async function saveUpload(path: string, uploadId: string, expectedSha256: string): Promise<ByteFile> {
  try {
    return await invoke<ByteFile>("save_upload", { path, uploadId, expectedSha256 })
  } catch (error) {
    throw toByteFailure(error)
  }
}

/** The native steps a save upload takes, injectable for tests. */
export interface SaveUploadSteps {
  put: (path: string, uploadId: string, sha256: string) => Promise<ByteFile>
}

export const NATIVE_SAVE_UPLOAD: SaveUploadSteps = { put: saveUpload }

/**
 * Upload a save file already prepared (`savePrepare`): `media.offer {purpose: "save"}`, then the
 * bytes unless the room already holds them (`existing`). Resolves with the file as the server
 * keeps it — its `hash` is what `save {op: "import", file}` names. Rejects with a `ByteFailure`.
 */
export function uploadSave(
  connection: Connection,
  path: string,
  prepared: PreparedFile,
  steps: SaveUploadSteps = NATIVE_SAVE_UPLOAD,
): Promise<ByteFile> {
  return uploadFile(connection, path, "save", { prepare: () => Promise.resolve(prepared), put: steps.put })
}
