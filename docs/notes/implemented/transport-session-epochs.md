# Implemented: Tauri-bridge connection epochs and honest send verdicts

- **Problem:** switching ticket/connection left the previous Rust actor's
  status/frame events able to land in the WebView after the new session
  `clear()`, so an Offline or a narrative from room A could rewrite room B.
  Independently, `Command::Send` during reconnect backoff did `continue`
  while `ClientHandle::send_frame` / `transport_send` had already returned
  `Ok`, so a typed line vanished with a successful local echo.
- **Verdict:** each explicit `connect` mints a bridge `connectionId` (not a
  protocol field). The Rust bridge stamps that id on every forwarded event
  envelope; `handleEvent` is the single drop point for any other id,
  including events already emitted and sitting in the JS queue. `disconnect`
  nulls the generation _before_ asking Rust to close, and sets Offline
  locally so a queued Offline cannot write back. `send_frame` is async and
  carries a oneshot: backoff/offline/close reply `Err`; an online write
  replies `Ok` only after the control stream accepts the bytes; a write
  failure replies `Err` and trips a redial. Actor drop drains leftover
  waiters.
- **Consequences:** automatic reconnect/rejoin keeps the same id (same
  explicit connect). fetch/put already failed fast while down; Send now
  matches them. InputBox already marked a rejected `transportSend` as a
  failed echo — that path is the one backoff now hits. The id must never
  be added to a wire frame; a Rust-only emit-time check is not enough.
  A stale `connect()` invoke (generation A) that fails after B is current
  must not write offline/null — only the still-current id may settle.
  `disconnect()` writes state only before its invoke, so a later connect
  is safe from that function's tail.
- **Rule home:** `src-tauri/src/transport_bridge.rs` (`bridged_event`),
  `src/store/connection.ts` (`handleEvent` / `connect` / `disconnect`),
  `crates/transport/src/client.rs` (`Command::Send` + `ClientHandle::send_frame`).
- **Date:** 2026-08-22.
