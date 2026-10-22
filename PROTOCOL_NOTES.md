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

> **Update — protocol 2.4 (`report` frame), 2026-10-16.** `.report html` and the
> keeper-key-only `.report html reveal` announce a server-generated HTML session report to
> the ONE connection that asked, as
> `{type:"report", hash, name, size, mime:"text/html", variant}`. The studio pins
> `npm:loreweaver-protocol@2.4.0`. The bytes ride the ordinary media GET into their own
> verified cache (`src-tauri/src/report.rs` — never `panel-assets/`, which `panel://`
> serves to tier-2 iframes) and never enter the WebView: the protocol forbids a client
> from rendering the report in its own UI, so the session view offers Save (native
> dialog, which confirms any replace) and Open in browser (a named copy in the app cache,
> opened by `tauri-plugin-opener` from Rust — the WebView holds no opener permission).
> `name` is untrusted and reduced to a safe base name (`src/lib/report.ts`); the native
> side re-checks it, refusing rather than repairing. The reveal edition wears a spoiler
> badge and warning.

> **Update — protocol 2.5 (display labels), 2026-10-22.** The wire now carries a display
> name BESIDE each raw id the studio used to print: `value_label` on an `enum` entry of
> `state.variables`, `state.character.attribute_labels`, `subsystem_label` on `dice`, and
> `blurb` / `claimed_by_name` on `state.pregens` entries. The studio pins
> `npm:loreweaver-protocol@2.5.0`. Every label is display-only; whatever WRITES keeps the
> raw id: the tracker row shows the option name with the id as its tooltip, while the
> keeper's write field keeps the id as placeholder and `.var set` sends what was typed;
> the character screen names `APP` as "外貌" (the key stays the tooltip, the React key and
> the `.st APP=<n>` write); the dice chip shows the subsystem's name, drops the forced
> uppercase that only suited ids, and is left out when it would repeat the roll's own
> `expr` (the engine already writes a SAN check's `expr` as "理智"); the pregen roster
> shows each card's player-facing blurb and names a claimer from `claimed_by_name`, then
> presence, then the id, while "yours" is still decided by member id. Panel templates
> follow LWF panels §5.1 rule 7 (a `$var` / repeat `$leaf: value` binding that is
> DISPLAYED shows `value_label`; `visible_when`, tones and numbers read the raw value),
> with `fixtures/panel_template_vectors.json` refreshed from the engine byte for byte;
> tier-2 panels get the new fields through the bridge unchanged. The forge has no editor
> for a card's `option_labels`, but now carries an imported enum's value verbatim, so a
> lorecard round trip no longer drops it. Item 4 below is half answered: an enum shows
> its current option's name, and still has no options list.

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

3. **History replay interacts with reconnects.** On every join the server replays the
   last 30 chat-history entries as `narrative` frames, plus (since 2.3) the `dice` and
   npc `narrative` frames recorded between them, plus media/audio state — all in FRESH
   frames: a replayed `narrative` gets a new `id` every time (`render_frame` in
   `net/session.py`), so `id` cannot dedupe a replay against what the client already
   shows (`docs/protocol.md` says clients "dedupe a `narrative` by `id`"; that holds
   for a live stream's closing frame, not for a replay). The studio therefore rebuilds
   its log from the replay on every `welcome` instead of appending to it. Not replayed
   at all: `system` frames, command replies (`speaker:"system"`), `ui` blocks, `error`s,
   and a player's dot/slash command lines — the log drops those on a reconnect, and
   keeps the player's own un-echoed lines as "not delivered". A replayed player line
   from an engine that does not yet name the seat has no `name`. Still worth stating in
   protocol.md for client authors: the replay window, the fresh ids, and that
   `state` is the frame that ends it.

4. **`state.variables` enum entries carry no options list.** `ModuleVariable` for
   `kind:"enum"` sends only the current value, while the server-side modvars spec knows
   the full options set. A client can therefore display an enum tracker but never offer
   a picker. If enum trackers are ever meant to be interactive (or even just show the
   space of values), v1.8 could add an optional `options?: string[]` to the entry.
   (2.5 added `value_label`, the current option's display name; the options list is
   still absent.)

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
