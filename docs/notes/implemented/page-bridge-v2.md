# Implemented: page panels run, through bridge version 2

- **Problem:** a 3.0 page panel showed only its fallback. The parked 2.x host served a page
  and its declared assets from many files, fed it the 2.x `state` snapshot and sent
  `panel_intent` (choice/input/roll) through a shim that sent nothing on a 3.0 link.
- **Decision:** a page is ONE file, fetched by the hash the `panels` view gives into the
  verified cache and served by `panel://` as the only document under a per-mount secret token,
  with the bootstrap and theme spliced inline into its `<head>` and a fixed CSP (inline code,
  `data:`/`blob:` media, no network). The frame is `sandbox="allow-scripts"`. The bridge
  (`window.loreweaver`, version 2) hands the page the values of its declared views keyed by
  handle (hidden list elements removed, as every panel reads them), the log events after
  `ready()`, and `run` → `command.run` as the member — after the host checks the `commands`
  view, asks its OWN confirmation for a `danger` command, rate-limits per page and caps sizes.
  The app's `frame-src` is split per platform (`panel:` on macOS/Linux, `http://panel.localhost`
  on Windows) so a page cannot navigate its frame to a real `http` host on either.
- **Reason:** with one self-contained file there is nothing to resolve but the entry, so the
  scheme serves one path and the CSP needs no URL at all. A page acts only as the member could
  by hand, never with more: the same command table, the same server limits, and a human in the
  loop for anything destructive.
- **Not covered:** `<link rel=preconnect>` (Chromium applies no CSP to it) and WebRTC are not
  stopped by any CSP or sandbox flag; on Windows, wry injects Tauri's IPC script into every
  frame and Tauri counts `panel` as a local origin — whether WebView2 delivers a sub-frame's
  `chrome.webview.postMessage` to the app's handler is unverified. All listed in
  `docs/PAGE-BRIDGE.md`.
- **Rule home:** `docs/PAGE-BRIDGE.md` (the reference); `src/features/play/panels/bridge.ts`,
  `Tier2Frame.tsx`, `src-tauri/src/panel_serve.rs`.
- **Date:** 2026-11-27.
