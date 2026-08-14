# Handback — decisions for the owner

Questions raised while executing `docs/OVERHAUL-2026-08.md`. Nothing here blocked
the work: each item states what was shipped in the meantime and what would change
if you decide otherwise. Newest batch last.

## Batch 0 — reconnect

### 1. The manual once-through in the app is still owed

The plan's acceptance is "a real `--serve` engine at HEAD accepts a studio
connection end-to-end (manually verified once via the app, and forever after via
the smoke gate)". The smoke gate is done and passing: it spawns a real engine and
dials it through the real transport crate on the production N0 profile
(`scripts/check_live_connect.sh`, stage 5 of `bun run roundtrip`). The two links
the gate does not cover are `src-tauri/src/transport_bridge.rs` — read and
confirmed to be a pass-through with no version logic of its own — and the WebView
store, which now has a test fed the exact frame `net/session.py::welcome_frame`
builds at engine HEAD.

**Shipped:** the automated half, plus a check that the gate really fails when the
old refusal is reintroduced (it exits 101, verified by patching the check back in
and reverting).

**Owed:** driving the built app against a live engine once, by hand. That needs the
Tauri app built and a GUI session, and §10's final acceptance demo needs the same
thing, so it is folded into that rather than done twice.

## Batch 1 — close the author loop

### 2. Two different install targets in the pack bench

"Test now" installs the pack with `TRPG_DATA_DIR` pointed at the local server's own
data dir (`~/.loreweaver/data` by default), because that is the only directory the
one-click server will look in. The bench's existing **Install** button, and the
"install after build" checkbox, still run `--install` with the studio's inherited
environment — which usually means the engine checkout's `./data`.

So the same pack can end up installed in two places, and the bench does not say so.
The Test-now panel names its target directory; the plain Install button does not.

**Shipped:** the two paths as described, with Test now's target displayed.

**Decide:** whether the plain Install button should also target the local server's
data dir (one place, but it stops being "the CLI command shown above"), or keep
today's split and add a line of copy explaining it.

### 3. The engine lane landed four items mid-overhaul

While Batch 1 was in flight, `trpg_kp` shipped `96c7228` (`.var set/add`),
`fbcd08c` (`contents.presets`), `fd6613a` (presentation kit **v2**) and `884fe51`
(world-card prose → keeper module brief) — the whole of §9's UPSTREAM_TODO list,
items 9–12.

Item 12 forced a decision immediately: kit v2 is a hard break (`KIT_VERSION = 2`,
v1 rejected outright), so the round-trip gate went red the moment it landed. It is
consumed — the studio emits v2 and the kit wizard gained the promised
template/palette UI, exactly as §9 anticipated ("the kit wizard gains a
template/palette UI in a follow-up batch here").

**Shipped:** item 12, fully, plus `UPSTREAM_TODO.md` updated for all four.

**Decide:** whether items 9, 10 and 11 get consumed inside this overhaul or wait.
None is in the plan's batch list. The natural homes would be:

- **9 (`contents.presets`)** — the preset manager exports a preset into a pack's
  source tree. Fits Batch 3 (surface new engine capabilities).
- **11 (`.var set/add`)** — a keeper write control on the state panel. Fits Batch 4
  (complete the play half), next to the pregen roster card.
- **10 (world-card prose)** — nothing is required; at most the forge stops implying
  that a world card's prose is inert.

Absent a decision, the overhaul is executed as written and these stay unconsumed.
