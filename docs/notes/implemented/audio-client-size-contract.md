# Implemented: client media cap matches the published 128 MiB audio default

- **Problem:** the engine and `docs/protocol.md` allow 128 MiB per audio file.
  Studio's transport GET used a 64 MiB ceiling, so a 65–128 MiB track could be
  offered, stored, and broadcast, then `assetFetch` failed and `AudioDeck`
  swallowed the error as silence. `media_prepare` / `media_upload` also read
  the whole file before any size check.
- **Verdict:** one client defensive ceiling, `loreweaver_transport::MAX_BLOB_BYTES`
  = 128 MiB, shared by the GET path and the upload pre-check. Over 128 MiB is
  refused (header, metadata, or post-read). 64–128 MiB is allowed. A layer
  whose fetch/read/decode fails shows a localized error and a Retry; the
  error lives on that layer only and clears on hash change or a successful
  retry. Playback uses a `blob:` URL from the verified-cache bytes.
- **Reason:** the 64 MiB number was a second, staler copy of a published
  default, not a security policy. A client ceiling is still required so a
  hostile peer cannot force an unbounded allocation; it just has to be the
  same number the protocol already documents. A new URI scheme (or exporting
  cache paths through `convertFileSrc`) would be a new security surface for
  a memory optimization; `blob:` reuses the existing `assetReadBase64` read
  and the `img-src` already allowed `blob:` for pictures. CSP adds
  `media-src 'self' blob:` so `<audio>` can play those object URLs.
- **Rule home:** `crates/transport/src/limits.rs` (`MAX_BLOB_BYTES`,
  `accepted_blob_size`); `src-tauri/src/media.rs` (`read_capped_file`);
  `src/features/play/audioPlayback.ts`; `src/store/audio.ts` (`loadError` /
  `retryLayer`).
- **Date:** 2026-08-22.

## Memory trade-off (base64 → playback)

A 128 MiB file still crosses the WebView boundary as standard-base64
(~171 MiB, 4/3). That IPC string is unchanged; shrinking it would mean
a new native→JS byte channel, which is out of scope.

What this change removes is the _second_ 4/3 string in the DOM. The old
path did `` `data:${mime};base64,${base64}` `` and parked that ~171 MiB
URL on `<audio src>`. Playback is now a short `blob:` URL.

Decode is chunked: `atob` sees at most 16 KiB of characters at a time,
written into one pre-sized `Uint8Array` (128 MiB) whose backing buffer
is already exact — it is cast into `Blob`, not `slice`d into a second
full ArrayBuffer. A full 128 MiB binary string is not allocated.

Honest peak while `objectUrlFromBase64` is running, for a 128 MiB file:

- the IPC base64 string still live (~171 MiB);
- the output `Uint8Array` (128 MiB);
- one ~12 KiB `atob` binary string (reused per chunk);
- plus whatever copy the browser's `Blob` constructor keeps (commonly
  another 128 MiB; that is the engine's, not a slice we make).

That is still large. It is smaller than the previous decode (full
`atob` string + `Uint8Array` + `buffer.slice` + `Blob`). After the
function returns and the caller drops the base64 local, JS can collect
the IPC string and the `Uint8Array`; what we keep is the `Blob` and
the object URL. Object URLs are revoked on hash change, retry, unmount,
and decode failure so a layer cannot accumulate 128 MiB blobs.
