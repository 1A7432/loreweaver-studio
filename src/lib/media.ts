// The typed face of the native media-upload path (`src-tauri/src/media.rs`).
//
// Split at the protocol's own seam: the CONTROL half is frames, so the store
// owns it (`media_offer` out, `media_accept` back); the BYTE half is a PUT on
// the media channel, so it happens in Rust and the file's bytes never enter the
// WebView. The download half already worked this way (`panels/assets.ts`).

import { invoke } from "@tauri-apps/api/core"

/** Everything `media_offer` has to say about a file, computed natively. */
export interface MediaOffer {
  name: string
  mime: string
  size: number
  sha256: string
}

/** Read + hash a file and report the offer fields. Rejects a format outside
 * the engine's own two allowlists before the server has to. */
export function mediaPrepare(path: string): Promise<MediaOffer> {
  return invoke<MediaOffer>("media_prepare", { path })
}

/** PUT an accepted upload. Answers the sha256 the SERVER stored it under —
 * the hash every later `media` / `audio_library_item` broadcast will name. */
export function mediaUpload(path: string, uploadId: string, expectedSha256: string): Promise<string> {
  return invoke<string>("media_upload", { path, uploadId, expectedSha256 })
}
