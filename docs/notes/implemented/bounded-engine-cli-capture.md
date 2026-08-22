# Implemented: engine CLI pipes drain in parallel under a hard capture cap

- **Problem:** `run_engine_cli` read stdout to EOF before stderr, so a child
  that filled the OS stderr pipe while leaving stdout open deadlocked until
  the 600s timeout; both capture `Vec`s were also unbounded until a
  post-hoc truncate, and a timeout relied on `kill_on_drop` / Drop without
  an explicit kill, wait/reap, or reader join.
- **Verdict:** drain stdout and stderr from spawn, concurrently; keep a
  PREFIX of at most 256 KiB per pipe (then discard while still reading);
  append one truncated / read-error marker; on timeout kill + wait the
  child and then settle the reader tasks.
- **Reason:** a pack build that chatters on one pipe must not wedge the
  studio, must not grow the WebView payload without bound, and must not
  leave a zombie or a background reader after the command returns.
- **Rule home:** `src-tauri/src/engine.rs` (module docs + `run_engine_command`).
- **Date:** 2026-08-22
