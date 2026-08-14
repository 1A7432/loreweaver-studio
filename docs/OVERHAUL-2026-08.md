# Studio overhaul — construction plan (2026-08)

This is a construction document for an AI coding agent working in THIS repo
(loreweaver-studio). It was produced by a full cross-repo reconnaissance on
2026-08-14 against the engine at M23 (`trpg_kp` HEAD, 43 commits ahead of this
repo's last sync on 2026-08-08). Execute it batch by batch, in order, under the
ground rules below. The engine repo is a sibling checkout at
`../trpg_kp` — read it freely, but this plan changes NOTHING there: engine-side
work runs in a parallel lane (§9) owned by someone else. If you discover a new
engine-side need, append it to `UPSTREAM_TODO.md` (the established channel) and
work around nothing.

Context you must internalize before touching code:

- The wire protocol is 2.1 on BOTH sides and all five contract surfaces
  (protocol, pack manifest v2, lorecard v1, engine CLI flags, presentation kit)
  were verified drift-free on 2026-08-14. This overhaul is NOT a format
  catch-up. It is: one critical connectivity fix, closing the author loop,
  UX hardening, surfacing new engine capabilities, completing the play half,
  and serialized-module support.
- This repo's superpower is its mirror discipline: every module that copies
  engine semantics names its engine source file in a header comment, and
  `scripts/check_roundtrip.sh` builds a real pack through the real engine CLI
  and runs engine pytest suites. Preserve and extend that discipline.

## 1. Ground rules

- **Conventions**: English identifiers/comments/commits. Every user-facing
  string goes through `src/i18n` with BOTH `en.json` and `zh.json` entries
  (`bun run i18n:lint` gates this). Commit style matches the existing log:
  `type(scope): lowercase sentence` (see `git log --oneline`).
- **Verification per batch** (all must pass before the batch is "done"):
  `bun run lint && bun run format:check && bun run typecheck && bun run test
&& bun run i18n:lint`; for Rust changes also
  `cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings
&& cargo test --workspace`; and `bun run roundtrip` (needs the engine
  checkout; it must stay green after every batch).
- **Commits**: one commit per coherent step, committed when green. **Do NOT
  push** — the owner reviews and pushes.
- **Protocol is additive-only** and owned by the engine. This repo never
  invents wire frames. Consume what `docs/protocol.md` (engine repo) and the
  `@loreweaver/protocol` npm types define; unknown-frame tolerance stays.
- **Mirror comments**: whenever you copy engine constants/semantics, add the
  header comment naming the engine file (existing pattern in `split/*.ts`,
  `model.ts`).
- **When blocked**: write the question into `UPSTREAM_TODO.md` (cross-repo
  needs) or a `HANDBACK.md` at repo root (owner decisions), and continue with
  the next unblocked task. Never invent an engine contract.

## 2. Batch 0 — reconnect (P0, strictly first)

**The studio cannot currently connect to any real engine.** All networking
runs through the Rust transport bridge (`src/lib/transport.ts` — "all
networking happens in the Tauri core"). On `welcome`, the Rust actor checks
`frames::protocol_supported()` (`crates/transport/src/frames.rs`), which
accepts only protocol major `"1"`, and on mismatch closes the QUIC connection
as Fatal WITHOUT forwarding the frame. The engine announces `"2.1"`
(`net/session.py::_PROTOCOL_VERSION`). Result: every live connection is
refused in Rust, and the TS-side major-mismatch refusal added in commit
`52de8b9` (`src/store/connection.ts`, `protocolMismatch()`) is unreachable
dead code. The Rust loopback test `unsupported_protocol_major_is_fatal`
(`crates/transport/tests/loopback.rs`) currently PINS the wrong behavior.

**Fix — single decision point.** The Rust layer stops judging the wire
protocol version entirely; it is transport, not policy:

1. Delete `protocol_supported()` and the welcome-time version check in
   `crates/transport/src/client.rs`. Forward the `welcome` frame to the
   frontend unconditionally (keep the `settled`/backoff-reset mechanics).
   The TS layer (`connection.ts`), which compares against the _installed npm
   protocol package's_ major, becomes the ONLY protocol gate — future bumps
   touch one place: the npm dependency.
2. Do NOT touch the ALPN string (`loreweaver/tui/1`) — it is frozen
   independently of the wire version and matches the engine's
   `net/iroh_server.py`.
3. Rewrite the loopback test: welcome frames of any version are forwarded
   verbatim and the connection stays open; add a companion TS test asserting
   `connection.ts` refuses major-mismatched welcomes (it likely exists —
   verify it runs against a live-shaped frame).
4. **Live-connect smoke gate.** The root cause of non-detection: no test ever
   connects to a real engine. Add a script (e.g. `scripts/check_live_connect.sh`,
   wired into `check_roundtrip.sh` as a new stage) that spawns the engine from
   the sibling checkout (`python -m app --serve --keys <tmpdir>` — background,
   with timeout + kill; never foreground-block), connects through the REAL
   Rust transport crate (a `#[ignore]`-by-default cargo integration test the
   script runs explicitly, taking the ticket via env), completes the join
   handshake, and asserts a `welcome` with protocol 2.x reached the event
   channel. The gate must fail if the Rust layer ever again refuses a welcome
   the TS layer would accept.

Acceptance: a real `--serve` engine at HEAD accepts a studio connection
end-to-end (manually verified once via the app, and forever after via the
smoke gate).

## 3. Batch 1 — close the author loop

### 3a. "Test this pack now"

After a successful build+install in the pack bench (`PackWizard.tsx` already
shells `--pack … --json` then `--install … --yes`), the author currently
dead-ends: playing the pack means manually switching to Play, starting a local
server, and importing by hand. Close it:

- Add a **Test now** action on the successful-build/install screen that:
  starts (or reuses) the local host (`src/store/hostLocal.ts` +
  `src-tauri/src/host_local.rs`), connects as keeper with the sidecar key,
  and then issues the import command(s) for the just-installed pack's world
  card(s) through the normal command path. Read the exact command shapes from
  the engine docs (`docs/plugins.md`, `docs/cards.md` — pack-relative
  `.import <packId>/<path> world` landed as UPSTREAM_TODO item 6); do not
  guess them.
- Show progress states (host starting → connected → importing → ready) and
  reuse the existing failure messaging (`hostLocal` already has good errors).
- Design the seam so a future "mount source dir" dev-room mode (engine-side,
  in flight — §9) can slot in as an alternative to install-then-import. Keep
  the invocation behind one function so the mode is swappable.

### 3b. Advisory pack lint (client-side)

A lint panel over the pack bench and forge, advisory-only (never blocks a
build — the engine CLI remains the authority). The studio already holds all
the data client-side. Initial rule set:

1. Variables declared but referenced nowhere (worldbook text, panel bindings,
   hooks source).
2. Lore entries that can never activate: empty `keys`, `constant: false`, no
   `condition`.
3. en/zh gaps: variable labels, panel labels, any bilingual field with one
   side empty.
4. Panels binding variables that are keeper-only / not exposed — they render
   blank for players (the trap the exposure model creates; this rule is the
   whole reason the lint exists, from the H2 plan).
5. Hooks / update-rules code referencing unknown variable ids.
6. Leftover stub markers (the `// TODO` body the wizard's update-rules stage
   emits — see Batch 2).
7. Pack metadata: missing description/license; assets referenced but absent.

Architecture: a pure module (`src/features/studio/lint/`) taking the project /
pack-source model and returning `{severity, ruleId, message, target}` — fully
unit-tested, i18n'd messages, surfaced in the PackWizard review step and the
forge toolbar. Extensible: Batch 5 adds episode rules.

## 4. Batch 2 — UX hemostasis

1. **Persist the Split and Pack sessions.** Today `SplitView.tsx` is raw
   `useState` and `store/pack.ts` says "Nothing here persists": a tab switch
   or reload silently destroys hours of work — the worst UX defect found.
   Persist both (zustand `persist`, mirroring `store/studio.ts` /
   `wizard/store.ts`). Binary blobs (dropped PNG/MP3) need not survive
   verbatim: persist text content + item metadata (name/size/hash) and mark
   binary items "re-attach needed" on restore. If full persistence is
   unreasonable for some state, a tab-switch/`beforeunload` confirmation is
   the floor — silent loss is not acceptable.
2. **Undo for destructive actions.** No app-wide undo exists (only two
   "cannot be undone" strings). Add a lightweight snapshot undo for deletes
   (project, variable, worldbook entry, pregen, pack item, episode): toast
   with an Undo button, in-memory stack. Not a full editor undo.
3. **Export flavor made visible.** The forge toolbar PNG export silently uses
   the secrets-stripped flavor while the wizard finish exports the
   secrets-included release flavor (deliberate, but invisible —
   `StudioView.tsx` `doExportPng` comment). Give every ST/PNG export point an
   explicit flavor indicator + switcher (safe-to-circulate vs
   release-with-secrets), with the current default preserved per site.
4. **Update-rules stage emits real code.** `wizard/apply.ts` always emits a
   stub `// TODO: apply the rules above with setvar/incvar` hook body.
   Generate real `setvar`/`incvar` handler code deterministically from the
   structured rules the author entered; fall back to the stub only when no
   rules exist, and label the output as a draft either way.
5. **Curated import errors.** Card/bundle import failures currently surface
   raw `Error` strings. Say what shape was expected vs found (ST V2/V3
   envelope, lorecard v1, PNG chunk missing, InitVar parse failure with
   line/reason).

## 5. Batch 3 — surface the engine's new capabilities

1. **Full rulepack editing.** The pack bench only offers an `extends:` patch
   textarea; authoring a complete new rule system in-app is impossible. Add a
   "full rulepack" mode: raw YAML editor with advisory client-side validation
   mirroring the engine's rulepack schema (read `core/rulepacks.py` +
   `docs/plugins.md` for the field list: names/defaults/derived/alias/
   st_show/set_keys/resolution/sheet/subsystems/commands/expertise/display…),
   load-from-file, and inclusion in the pack source tree. Advisory only — the
   engine build stays the authority. (A structured visual editor is future
   work, not this batch.)
2. **Prep-script editor — GATED on upstream.** The engine's M20 F prep-phase
   hatch (`core/prep_script.py`: sandboxed JS emitting a `plan(tool, args)`
   operation list, ≤20000 chars, ≤200 ops) is a new authorable deliverable,
   but its author-facing docs and pack-asset convention do not exist yet —
   the engine lane (§9) is writing them. Build the editor shell (textarea +
   static size/ops checks mirroring the engine constants + an API reference
   panel) behind a feature flag, and wire the export location only once the
   upstream convention lands. Check `UPSTREAM_TODO.md` / engine
   `docs/plugins.md` for it before starting; if not landed, ship the flag off.
3. **Deterministic worldbook macros note.** M23 made `{{random}}`/`{{pick}}`
   deterministic per (room, turn) for replay stability. No studio preview
   renders these macros today (verified) — so just add a help-text hint in
   `WorldbookTab` and the wizard variables/worldbook stages so authors aren't
   surprised that "random" repeats within a turn.

## 6. Batch 4 — complete the play half (the author's test bench)

Read the engine's `docs/protocol.md` for every frame named here; consume, do
not reinterpret. Gate each UI on `welcome.features` where a feature string
exists (today only `"demo"` is read).

1. **Room lifecycle admin UI.** `admin.ts` already ingests `admin_room_op` /
   `admin_update` replies, but NO screen sends `admin_export_room`,
   `admin_import_room`, `admin_reset_room` (story/chars/all scopes),
   `admin_delete_room`, `admin_delete_room_data`, or `admin_update_server`.
   Add a keeper Rooms screen section for backup/restore/reset/delete and a
   server self-update action — destructive ops get explicit typed-name or
   double-confirm dialogs, and reset scope choices mirror the engine's
   semantics (read `docs/operating.md`).
2. **Pregen roster card.** `state.pregens` already reaches the tier-2 panel
   bridge but the native `StatePanel.tsx` has no card. Add a PregenCard
   (list + claim button issuing the `.pc claim` command path used elsewhere).
3. **Dice detail.** `DiceLine.tsx` drops `frame.detail`: opposed checks show
   no opposing roll or winner, subsystem checks no label. Render `detail`
   verbatim-but-pretty per the protocol's "a client may surface verbatim"
   contract (left/right/winner for `kind:"opposed"`, subsystem label, bonus/
   penalty dice, SAN loss when present).
4. **Server version surfaced.** `welcome.version` exists precisely for
   client/server drift detection and is never displayed. Show it on the
   connect/status surfaces next to the client's own version; flag a mismatch
   softly.
5. **Media family.** Implement upload (`media_offer`/`media_accept` + byte
   channel), broadcast display in the narrative log, `media_enabled` /
   `media_set_enabled` (keeper toggle), and `avatar_set` (+ avatar rendering
   in presence/party). The content-addressed asset cache
   (`src-tauri/src/asset_cache.rs`, `assets.ts::assetFetch`) is already the
   fetch path for `image` blocks — reuse it.
6. **Audio family.** `audio_library_item`, `audio_control`, `audio_state` →
   BGM/ambience/SFX playback fed from the byte-channel cache, volume/mute UI,
   and the keeper-side control surface the protocol defines. Autoplay
   restrictions in the webview may require a first-interaction unlock — handle
   it, don't silently fail.

## 7. Batch 5 — serialized modules (连载模组)

Design (settled with the owner, 2026-08-15 — implement as written):

- **Model: ONE pack, cumulative versions.** A serialized work is a single
  pack whose release at episode N contains episodes 1..N. An episode is an
  authoring-time grouping + a release checkpoint — NOT a separate pack. This
  matches the engine's update semantics (re-import replaces by source,
  InitVar merge preserves player progress) and the H2 subscription rail built
  on them. The pack file circulating at version N contains no future-episode
  content — spoiler-safe by construction, no gating machinery needed.
- **Versioning convention**: minor = episode (e.g. `1.4.x` carries episodes
  1–4). Surface it, don't hard-enforce it.
- **Data model**: the pack project gains `episodes: [{id, ordinal, title,
summary, releaseNotes}]`; pack items, worldbook entries, and pregens gain an
  optional `episode` tag (untagged = episode 1 / evergreen). Variables stay
  global (a variable first used in episode N simply appears on update via
  InitVar merge).
- **UI**: an episode timeline in the pack bench; a "build up to episode N"
  selector on the build step (default: latest); per-episode release notes
  editor.
- **Build**: content tagged to episodes > N is EXCLUDED from the written
  source tree (verify by test — a future-episode lore entry must not appear
  in any built artifact). Generate `CHANGELOG.md` in the pack source from the
  release-notes chain — the Bomb-3 `--publish`/`--update` rails will consume
  it later.
- **Lint rules** (extend Batch 1): content tagged to a nonexistent episode;
  episode with empty release notes at build time; cross-episode references to
  future content.
- **Engine**: needs nothing now. Provenance records and "new chapter" room
  hints are Bomb-3 engine work, out of scope here.

## 8. Documentation fixes (fold into the nearest batch's commits)

- `docs/FORMATS.md` claims PNG embedding and alternate-greetings export are
  "not yet implemented" — both shipped (`pngCard.ts::embedCardIntoPng` wired
  into StudioView + WizardView; `exporters.ts` emits `alternate_greetings`/
  `alternate_openings`). Fix the doc.
- `README.md` says native-bundle import "awaits upstream M14" —
  `doImportNative()` exists and works. Fix.
- `UPSTREAM_TODO.md` line-number drift: `cmd_preset` is now
  `gateway/commands.py:1178` (literal-path read at 1206–1207), `cmd_var` at
  2027–2083. Update on next touch.
- Round-trip gate blind spots (extend `gen_roundtrip_pack.ts` when touching
  it): no PNG-embedded card ever passes through the ENGINE's parser; no
  world-flavored ST card (with `[InitVar]`/hooks) exercises engine-side world
  detection; `has_ejs`/`has_rules_script` are pinned false so those pack
  shapes are never built. Add fixtures for all three.

## 9. Engine-side parallel lane (context only — NOT yours)

Running concurrently in `trpg_kp`, owned separately. Do not build, block on,
or duplicate these; where a batch depends on one, the batch text says so:

- Dev-room hot reload (mount a pack SOURCE dir into a sandbox room; save →
  live reload) — the future second mode of "Test now" (§3a).
- Prep-script author documentation + pack-asset convention (unblocks §5.2).
- `{{random}}`/`{{pick}}` determinism documented for authors.
- UPSTREAM_TODO items: 9 (presets as pack assets + pack-relative
  `.preset import`), 11 (`.var set/add` keeper write), 10 and 12 per owner
  verdict (world-card prose seeding; presentation kit template list +
  palette — if 12 lands as a schema extension, the kit wizard gains a
  template/palette UI in a follow-up batch here).

## 10. Final acceptance demo

With a real engine checkout at HEAD, in one sitting: author a small pack in
the wizard → build + install → **Test now** → play a turn against the live
Keeper (dice line with detail, a panel, BGM if configured) → return to the
bench, edit, rebuild, retest → tag content as episode 2, build "up to episode
1" and verify exclusion, then build episode 2 with release notes → lint panel
clean → every suite in §1 green, including the live-connect smoke gate.
