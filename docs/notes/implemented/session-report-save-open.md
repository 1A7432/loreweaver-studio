# Implemented: the session report is saved or opened, never rendered

- **Problem:** protocol 2.4 announces a server-generated HTML session report
  (`report` frame) to the connection that asked for it, and forbids a client
  from rendering it inside its own UI. The studio had to fetch it, verify it,
  and get it to the person without ever showing the HTML in a WebView.
- **Verdict:** the bytes ride the existing media GET (`fetch_blob`) and the
  existing verifier (`verify_and_store`) into a `reports/` cache of their own,
  fetched as soon as the frame lands. The session view shows a non-blocking
  notice with Save (native save dialog, default `~/Downloads/<safe name>`) and
  Open in browser (a copy at `reports-open/<hash>/<safe name>` in the app
  cache, opened by `tauri-plugin-opener` from Rust). The reveal edition gets a
  spoiler badge, a danger rail and a do-not-share warning; any variant that is
  not explicitly `player` is shown as reveal.
- **Reason:** a separate cache directory means `panel://` can never serve a
  report to a tier-2 iframe. Calling the opener from Rust means the WebView
  holds no opener permission at all, so the only thing it can get opened is a
  verified report this code wrote — narrower than any capability scope. The
  name is untrusted: `safeReportName` reduces it to a base name, and the native
  side only checks it (one transform, one home). Overwrite is never silent
  because the native save dialog confirms a replace; the browser copy lives in a
  per-hash directory, so an existing file there already holds the same bytes.
  `tauri-plugin-opener` is pinned `~2.5`: 2.6+ requires tauri 2.12, which would
  drag the tauri crate ahead of `@tauri-apps/api`.
- **Rule home:** `src-tauri/src/report.rs` (fetch/save/open, name check);
  `src/lib/report.ts` (`safeReportName`); `src/store/report.ts` (offers);
  `src/features/play/ReportNotice.tsx`.
- **Date:** 2026-10-16.
