// Pull a verified audio blob and turn it into a short-lived object URL.
//
// The previous path concatenated a `data:` URL around the base64 IPC payload.
// At the protocol's 128 MiB audio default that is a second ~171 MiB string
// sitting in the DOM (`4/3 * 128` plus the prefix). A `blob:` URL is a few
// dozen bytes. Decode walks the IPC string in 4-character chunks so a full
// 128 MiB `atob` binary string never sits beside the output buffer; the
// `Uint8Array` owns an exact backing store and is handed to `Blob` without
// an extra `slice`. No new URI scheme, no path export, no extra security
// surface — `assetReadBase64` was already the read half of the verified cache.

import { assetFetch, assetReadBase64 } from "./panels/assets"

/** Base64 characters per `atob` call. A multiple of 4 (one quantum) and
 * small enough that the temporary binary string stays off the 128 MiB path. */
export const BASE64_DECODE_CHUNK_CHARS = 16 * 1024

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/

function decodedByteLength(base64: string): number {
  if (base64.length === 0) return 0
  if (base64.length % 4 !== 0 || !BASE64_BODY.test(base64)) {
    throw new Error("invalid base64")
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return (base64.length / 4) * 3 - padding
}

/** Standard-base64 → bytes without materializing a full binary string.
 *
 * The IPC payload stays where it is. Each `atob` sees at most
 * {@link BASE64_DECODE_CHUNK_CHARS} characters; the output is one
 * pre-sized `Uint8Array` whose backing `ArrayBuffer` is exactly the
 * decoded length. Empty input is empty bytes. Padding (`=`, `==`) is
 * only valid at the end. */
export function bytesFromBase64(base64: string): Uint8Array {
  const out = new Uint8Array(decodedByteLength(base64))
  let offset = 0
  for (let i = 0; i < base64.length; i += BASE64_DECODE_CHUNK_CHARS) {
    const chunk = base64.slice(i, i + BASE64_DECODE_CHUNK_CHARS)
    let binary: string
    try {
      binary = atob(chunk)
    } catch {
      throw new Error("invalid base64")
    }
    for (let j = 0; j < binary.length; j += 1) {
      out[offset + j] = binary.charCodeAt(j)
    }
    offset += binary.length
  }
  if (offset !== out.length) throw new Error("invalid base64")
  return out
}

/** Decode the IPC base64 once into a `blob:` URL the `<audio>` element can play. */
export function objectUrlFromBase64(base64: string, mime: string): string {
  const bytes = bytesFromBase64(base64)
  // `new Uint8Array(n)` owns an ArrayBuffer of exactly n bytes (offset 0).
  // Cast only — do not `slice` a second 128 MiB copy. The Blob constructor
  // may still copy internally; that is the browser's, not ours.
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime || "audio/mpeg" })
  return URL.createObjectURL(blob)
}

export async function cachedAudioUrl(hash: string, mime: string): Promise<string> {
  await assetFetch(hash)
  const base64 = await assetReadBase64(hash)
  return objectUrlFromBase64(base64, mime)
}
