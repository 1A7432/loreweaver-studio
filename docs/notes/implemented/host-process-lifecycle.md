# Implemented: hosting a 3.0 server locally — one slot, a bounded start, no orphan

- **Problem:** "Host locally & play" ran the 2.x Python server: it downloaded a
  release bundle (with checksum verification), read key files the server wrote
  beside its data, scraped the ticket from stderr and streamed every line to the
  WebView as events, with a WebView-minted host id to filter queued events and a
  parked-Ready dance for a stop that crossed a Ready. None of that exists in 3.0,
  and the event's `host_id` field went out in snake case (the enum's
  `rename_all` renamed variants, not fields) while TypeScript read `hostId`.
- **Decision:** `host_local.rs` is a small process owner, independent of Tauri
  (`LocalHost`), with a thin command layer:
  - the engine is found by the app's one probe (`engine::probe_candidates`,
    first candidate answering `--version` with `3.x`);
  - `start` claims the one slot first, then finds the engine, then (a data
    directory already in use whose key the app lost) mints an admin key with
    the server's `key` command, then spawns `serve --until-stdin-closes`
    (its standard input a pipe the slot holds for the child's life) from an empty temp
    working directory with the app's environment minus `TRPG_*` plus
    `TRPG_DATA_DIR` (and `TRPG_LOCALE`), and resolves on the ONE ready line, or
    fails with a coded `HostFailure` (refused + problems, exited + last stderr
    lines, timeout, cancelled, no engine…). It is a plain async command: no
    progress events, so nothing can arrive out of order;
  - a supervisor task owns the child (holding the host only weakly): it waits
    for death or a stop (the input pipe closed, and SIGTERM on Unix, 5s, then
    a kill), releases the slot, and only a death nobody
    asked for (ready, not stopping) is emitted — `HostExited {hostId, code,
stderr}`, camelCase, pinned by a test;
  - `stop` signals and waits until the slot is released; a stop during any
    step of the start cancels it; the app's `RunEvent::Exit` stops the server;
  - the admin key: `first_key` on a fresh data directory, kept in
    `local-server-keys.json` in the app data folder (0600, keyed by data
    directory) — not in the WebView's storage; the key reaches the WebView only
    in `start`'s answer and goes straight to the connection;
  - pressing the button again while the server runs for the same folder (after
    a reload) returns its ready again (`reused`) instead of refusing;
  - the server is reachable by the people invited (owner's ruling, 2026-11-27: a
    table hosted here is for inviting friends, and the engine needs a network to
    reach its model anyway): no `--local`, so it serves over the public relays and
    its ticket, the one to hand to friends, is the same after every restart. The
    ready answer says how to dial it (`network`, `n0`) and the WebView dials it as
    it dials any pasted ticket. Loopback-only (`serve --local`, the `local`
    profile) survives as ONE test-only option, `HostConfig::network`, which the
    live gate and the unit tests pass; no command, setting or button chooses it,
    and the Tauri command always passes `n0`.
- **Reason:** with the ready line on stdout and a bounded wait, the start is a
  request with an answer, so the generation machinery the streamed 2.x design
  needed (host ids minted in the WebView, a stopping id, a parked Ready) has
  nothing left to guard. Keeping the key beside the app rather than in
  localStorage ties it to the data directory it belongs to, whatever the
  WebView forgets.
- **Orphans:** a crash or SIGKILL of the app closes the server's input pipe
  (the operating system closes it with the process), and the server stops by
  itself (`--until-stdin-closes`, engine `docs/deploy.md`); the live gate drops
  a host without stopping it and checks the server is gone. The flag is always
  passed: the probe accepts only a 3.x engine, and the 3.0 engine has it.
- **Not covered:** a `loreweaver.cmd` shim on Windows would be killed without
  its child on a hard stop (closing the pipe still reaches the server).
- **Rule home:** `src-tauri/src/host_local.rs` (+ its tests and
  `src-tauri/tests/host_local_live.rs`), `src/store/hostLocal.ts`.
- **Date:** 2026-08-22; rewritten for 3.0 on 2026-11-27; the input pipe 2026-11-27;
  reachable by invited friends (no `--local`) 2026-11-27.
