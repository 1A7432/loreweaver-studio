# Protocol notes from the first third-party client

Loreweaver Studio is the first client for the Loreweaver wire protocol built outside the
main repo, against `docs/protocol.md` (v1.7) and `@loreweaver/protocol` 1.7.0. This file
records everything the protocol or the shared package left ambiguous or unusable from the
outside — feedback for upstream, not workarounds we expect to keep forever.

## Package consumption

1. **`@loreweaver/protocol` exports point at an unbuilt `dist/`.** The package's
   `exports` map serves `./src/*.ts` only under the `bun` condition; `types` and
   `default` point at `dist/*.d.ts` / `dist/*.js`, which are neither committed nor built
   by a lifecycle hook a `file:` consumer would run. tsc (`moduleResolution: bundler`)
   and Vite both fail to resolve the package as shipped. We work around it with a
   `paths`/`resolve.alias` mapping straight into `src/index.ts`. Upstream fixes that
   would remove the workaround: publish with a `prepare` script, commit `dist/`, or add
   a `source`/`default` fallback condition pointing at the TS source.

## Wire protocol

2. **Streaming narrative chunk shape is under-specified.** `docs/protocol.md` says
   streaming is "multiple frames sharing the same `id` with `stream:true`, terminated by
   a frame with `done:true`", but does not state (a) that chunk `text` is a delta to
   append (the reference TUI appends), or (b) whether the terminating frame itself
   carries `stream:true`. We follow the TUI: merge only frames with `stream:true`,
   append deltas, carry `done` forward. A terminating frame with `done:true` but no
   `stream:true` would render as a duplicate line in both clients — worth pinning down.

3. **History replay interacts with reconnects only for narrative/media.** On every join
   the server replays recent `narrative` (and media/audio state). Narrative replay is
   deduplicatable via `id` (we do); `dice` and `system` frames have no id and are not
   replayed, so a reconnect keeps them only as long as the local scrollback survives.
   Documenting the replay window (last 30) and its dedup contract in protocol.md would
   help client authors — today it is only discoverable from the server source.

4. **`state.variables` enum entries carry no options list.** `ModuleVariable` for
   `kind:"enum"` sends only the current value, while the server-side modvars spec knows
   the full options set. A client can therefore display an enum tracker but never offer
   a picker. If enum trackers are ever meant to be interactive (or even just show the
   space of values), v1.8 could add an optional `options?: string[]` to the entry.

5. **`ui` sidebar frames without an `id`.** The spec defines replacement per id but not
   the key of an id-less sidebar frame. We treat all id-less sidebar frames as one
   anonymous region (last write wins). If hooks are expected to emit several id-less
   persistent panels, the spec should say so (we would then append instead).

6. **`ui` inline `replace:true` with no prior match.** We append in that case, per "a
   client without in-place updates simply appends". Stating that explicitly for the
   no-match case would avoid divergent behavior.

7. **Client-side `turn_status` safety timeout is unspecified.** The protocol asks
   clients to "apply a safety timeout in case an end frame is lost" without suggesting a
   value. We copied the reference TUI's 120s. A recommended value in protocol.md keeps
   clients consistent.

8. **`join.locale` is accepted but undocumented.** `net/session.py` reads a locale off
   the join frame (falling back to the server default), but neither `docs/protocol.md`
   nor `JoinFrame` in `@loreweaver/protocol` mention the field. Either document it (we
   would then send the UI language) or drop it server-side.

## Non-issues worth confirming

- ALPN `loreweaver/tui/1` + newline-delimited JSON over one `open_bi` stream worked
  exactly as documented against iroh 1.0 (Rust) ↔ iroh 1.0 (Python server bindings).
- "Accept any 1.x, ignore unknown frames" versioning was painless to implement; the
  shared `isServerFrame` validator table is genuinely useful outside the WS client.
- `state.reset` clearing local scrollback, keeper-only variable filtering, and the
  fatal-vs-recoverable error code split are all clear and implementable as written.
