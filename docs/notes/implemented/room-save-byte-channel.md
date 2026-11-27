# Implemented: a room save travels on the byte channel and never enters the WebView

- **Problem:** engine `a41fa78` (protocol 3.0, unreleased) moved `save` off the control stream: an
  export answers a reference `{hash, mime, size, name}` to a file only admins can fetch, and an
  import names a file uploaded with `media.offer {purpose: "save"}`. Studio exported the room as
  a JSON object inside the answer and imported it as a `bundle` argument — read whole into the
  WebView, parsed and re-sent as one line — so any room over 8 MiB could not move at all.
- **Verdict:** the WebView keeps the control half (the dialogs, `save` export/import and the
  offer, through the session); `src-tauri/src/save.rs` keeps the bytes. Saving asks for the path
  first, runs the export, and `save_fetch` GETs the file with a ceiling of its own (256 MiB, the
  server's `MAX_SAVE_FILE_BYTES`; `LinkHandle::fetch_within`), checks type, size and SHA-256
  against the answer, and writes it through a fresh 0600 temporary file renamed over the picked
  path. Restoring runs `save_prepare` (read, size cap, starts like one JSON object, hash), shows
  the name and size, then the offer, `save_upload` (re-read, still the offered bytes, receipt
  checked) and `save {op: "import", file}`. Refusals are the server's words; this client's
  failures are worded from its catalogs.
- **Reason:** a save holds every secret of the room. Keeping it out of the WebView and out of
  every cache (the panel-asset cache is served to page panels; the report cache is shared with
  the browser copy) leaves exactly one copy on disk, where the admin put it, readable by the
  admin alone. A per-fetch ceiling keeps `MAX_BLOB_BYTES` at 128 MiB for everything else instead
  of doubling it for one file. Asking for the path first fetches the file the moment it is
  named: the room keeps only its latest export.
- **Rule home:** `src-tauri/src/save.rs`; `crates/transport/src/limits.rs` (`MAX_SAVE_BYTES`,
  `accepted_size`); `src/lib/roomSave.ts`; `src/features/play/screens/RoomLifecycle.tsx`; the
  live check `src-tauri/tests/save_live.rs`.
- **Date:** 2026-11-27.
