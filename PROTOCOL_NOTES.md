# Protocol notes from the first third-party client

Loreweaver Studio is the first client for the Loreweaver wire protocol built outside the
main repo, against `docs/protocol.md` (v1.7) and `@loreweaver/protocol` 1.7.0. This file
records everything the protocol or the shared package left ambiguous or unusable from the
outside — feedback for upstream, not workarounds we expect to keep forever.

> **Update — protocol 2.x:** the studio now pins `npm:loreweaver-protocol@2.1.0` and
> targets engine 2.x only. Items 1 and 2 below are resolved upstream (the 2.x package
> ships a built `dist/` with proper `types`, and 2.0 re-specified streaming as
> `narrative_delta` chunks closed by one full-text `narrative`); the corresponding local
> workarounds (source alias, stream/done merging) have been removed.

> **Update — protocol 2.3 (`pack_cards.kind`), 2026-08-18.** Every `pack_cards` entry now
> carries the card's 拆卡 kind, and it decides the import VERB: `character` → `.import <ref>
pc`, `world` → the keeper-only `.import <ref> world`. Before it existed the studio (and
> the TUI, and this repo's own play lane) hard-coded `pc`, so a player clicking a module's
> world card asked the server to build a character out of a module. 2.3 also adds
> `state.systems` — every rule system the server discovered, each with the dialect word
> that makes a character in it — which is what lets the character screen offer creation
> while knowing no rule system, and what puts a community pack's own system in the picker
> with no studio release. The studio pins `npm:loreweaver-protocol@2.3.0`; the local type
> shims that carried both fields before it published are gone. Note the authoring lane
> never had the card bug: `src/features/studio/pack/testDrive.ts` reads `kind` off the
> local pack source. The gap was only ever that the wire did not carry what the manifest
> already knew.

> **Update — the major-version check.** The shared package grew the compatibility
> predicate (`protocolMajor` / `protocolMismatch`) on 2026-08-08, hours after 2.1.0 was
> published; **2.1.1** carries it, and the studio pins that. The studio REFUSES a
> different-major `welcome` — the library only warns, and choosing to refuse is the
> app's call. Nothing about the check is reimplemented here.
>
> **One gate, one place (2026-08-15).** The check lives in `src/store/connection.ts`
> and nowhere else. The Rust transport crate used to run a second, hand-rolled
> `1.x` check at welcome time and closed the QUIC connection before the frontend
> ever saw the frame — so once the engine moved to 2.1 the app could not connect to
> any real server, and the TS refusal became dead code. The lesson generalizes: a
> version predicate duplicated in a layer that does not depend on
> `@loreweaver/protocol` cannot be bumped with the package, so it will go stale and
> fail closed. The transport is transport; it forwards `welcome` verbatim. The ALPN
> (`loreweaver/tui/1`) is the exception that proves the rule — it names the framing,
> is frozen independently of the wire version, and the engine says so in
> `net/iroh_server.py`.

## Package consumption

1. **`@loreweaver/protocol` exports point at an unbuilt `dist/`.** The package's
   `exports` map serves `./src/*.ts` only under the `bun` condition; `types` and
   `default` point at `dist/*.d.ts` / `dist/*.js`, which are neither committed nor built
   by a lifecycle hook a `file:` consumer would run. tsc (`moduleResolution: bundler`)
   and Vite both fail to resolve the package as shipped. We work around it with a
   `paths`/`resolve.alias` mapping straight into `src/index.ts`. Upstream fixes that
   would remove the workaround: publish with a `prepare` script, commit `dist/`, or add
   a `source`/`default` fallback condition pointing at the TS source.
   **Resolved in 2.1.0** — the published tarball ships built `dist/` (types + JS) and
   `src/`; the aliases are deleted and normal resolution is used.

## Wire protocol

2. **Streaming narrative chunk shape is under-specified.** `docs/protocol.md` says
   streaming is "multiple frames sharing the same `id` with `stream:true`, terminated by
   a frame with `done:true`", but does not state (a) that chunk `text` is a delta to
   append (the reference TUI appends), or (b) whether the terminating frame itself
   carries `stream:true`. We follow the TUI: merge only frames with `stream:true`,
   append deltas, carry `done` forward. A terminating frame with `done:true` but no
   `stream:true` would render as a duplicate line in both clients — worth pinning down.
   **Resolved in 2.0** — streaming is now `narrative_delta` chunks (concatenate by `id`)
   closed by a `narrative` with the same `id` whose full text REPLACES the draft (empty
   text drops it). The studio implements exactly that; no ambiguity left.

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
