# Implemented: host-process lifecycle — drain until death, one Exit per host id

- **Problem:** `host_local.rs` dropped the stderr reader the moment the iroh
  ticket + sidecar key arrived (the comment claimed the pipe would keep
  draining; the `ready` future returned and took the `BufReader` with it). A
  chatty server could then block on a full stderr pipe. Separately, a
  spontaneous crash or external kill never emitted `HostLocalEvent::Exit`, so
  the WebView could sit at `phase: "ready"` / `hostedSession: true` forever.
  A numeric generation that stayed current after `try_observe_exit` then let
  `announce_ready` emit Ready after Exit. And a Rust emit-before-check cannot
  see frames already in the Tauri/JS queue — the same gap the transport
  session id closed — so an old Exit could land after a new start.
- **Decision:** stdout and stderr are each drained line-by-line from spawn
  until the process closes the fd. The **same** stderr reader scans for the
  ticket; Ready is announced by a sidecar waiter that does not own the reader.
  A readiness timeout emits only a readiness Error — it never wraps or drops
  a drain. The WebView mints a `hostId` on `start` and passes it to Rust;
  every `HostLocalEvent` carries it. `ingest` is the single filter
  (`hostEventApplies`). Observed death clears Rust `current_host_id` so a
  late Ready cannot follow; Exit is still emitted with that id. Explicit
  `stop` moves the id to `stoppingHostId` (only the confirming Exit applies)
  and waits up to 5s for death. After a WebView reload, `reconnectIfServing`
  adopts `host_local_status.hostId` so the live child's Exit is still
  accepted. Exit kind is structured (`exitKind` / `exitCode`); the connect
  screen translates it.
- **Reason:** the Child is not shareable across `wait()` and `start_kill()`
  without a lock, and holding `std::sync::Mutex` across `.await` deadlocks
  stop against the monitor. Polling `try_wait` under a short lock, and
  waiting on a _taken_ Child outside the mutex, keeps kill_on_drop / status /
  already-running / reconnect semantics. The host id — not a Rust-only
  counter — is what makes a stale queued event structurally unable to poison
  a new session or revive a dead one. The ticket scan window is capped
  (64 KiB) so 90s of pre-ready stderr cannot grow without bound.
- **Scope limit (deliberate):** acquisition (checkout / verified cache /
  download), `kill_on_drop`, reload-reconnect via persisted ticket+key, and
  the already-running refusal are unchanged. `stop` is synchronous with
  process death up to `STOP_WAIT`; after that the taken Child is dropped and
  `kill_on_drop` finishes the job — we do not block the command forever.
- **Rule home:** `src-tauri/src/host_local.rs` (slot / host id / drain /
  monitor helpers); `src/lib/hostLocal.ts` `hostEventApplies`;
  `src/store/hostLocal.ts` `ingest` first line + `stop()`.
- **Date:** 2026-08-22.
