# Handback — decisions for the owner

Questions raised while executing `docs/OVERHAUL-2026-08.md`. Nothing here
blocked the work: each item states what was shipped in the meantime and what
would change if you decide otherwise. Newest batch last.

All six batches are done and every gate in §1 is green, including the
round-trip gate and its new live-connect stage. Nothing is pushed.

## Batch 0 — reconnect

### 1. The manual once-through in the app — DONE

The plan's acceptance was "a real `--serve` engine at HEAD accepts a studio
connection end-to-end (manually verified once via the app, and forever after
via the smoke gate)". Both halves are done.

Automated: `scripts/check_live_connect.sh` spawns a real engine in a sandboxed
data dir and dials it through the real transport crate on the production N0
profile; it is stage 5 of `bun run roundtrip`. It was also verified to FAIL
(exit 101) when the old version refusal is patched back in, so the gate has
teeth.

Manual: the built app was driven against a live engine via Accessibility. It
connected (`牌桌「acceptance」 · keeper · 在线`), rolled `1d100` through the
real dice engine, and ran a real `admin_export_room` whose backup file landed
on the server's disk. The new play surfaces were confirmed rendering live: the
version badge (`服务器 2.1.dev141+ge03d66c · 工作室 0.1.0`), the media and
audio decks, and the room-lifecycle section with its typed-name confirms. On
the authoring side: the advisory lint panel, the rule-system mode selector, the
prep-script editor, the episode timeline, the release-horizon selector with its
version advice, and the export flavor picker.

## Batch 1 — close the author loop

### 2. Two different install targets in the pack bench — still open

"Test now" installs the pack with `TRPG_DATA_DIR` pointed at the local server's
own data dir (`~/.loreweaver/data` by default), because that is the only
directory the one-click server will look in. The bench's existing **Install**
button, and the "install after build" checkbox, still run `--install` with the
studio's inherited environment — usually the engine checkout's `./data`.

So the same pack can end up installed in two places. The Test-now panel names
its target directory; the plain Install button does not.

**Decide:** whether the plain Install button should also target the local
server's data dir (one place, but it stops being "the CLI command shown
above"), or keep today's split and add a line of copy explaining it.

### 3. The engine lane landed four items mid-overhaul — mostly consumed

While Batch 1 was in flight, `trpg_kp` shipped the whole of §9's UPSTREAM_TODO
list. What has been consumed since:

- **12 (presentation kit v2)** — consumed the same day; it was a hard break
  (`KIT_VERSION = 2`, v1 rejected), so the round-trip gate went red until the
  studio emitted v2. The kit wizard also gained the promised template/palette
  UI, exactly as §9 anticipated.
- **Prep scripts + dev rooms** — both consumed in Batch 3: the prep-script
  editor ships ON with the real `contents.prep` location, and the dev room is
  the second Test-now mode the §3a seam was designed for.
- **The trust card's two new fields** (`presets`, `prep_scripts`) — mirrored in
  `PackTrust` and displayed.

Still unconsumed, and NOT in the plan's batch list:

- **9 (`contents.presets`)** — a pack can now ship ST completion presets. The
  natural studio-side move is a presets section in the pack bench, fed by the
  existing preset manager. Not started.
- **11 (`.var set/add`)** — the keeper can now write a tracker without a model
  turn. The natural move is a write control on the state panel, next to the
  pregen card. Not started.
- **10 (world-card prose → module brief)** — nothing is required. At most, the
  forge could stop implying that a world card's prose is inert.

**Decide:** whether 9 and 11 belong in this overhaul or a later one. Absent a
decision the overhaul was executed as written and they stay unconsumed.

## Batch 6 — the round-trip gate

### 4. The rules-script lane depends on an optional engine extra

Closing the `has_rules_script` blind spot means shipping a rulepack with a
stage-E script, and that compiles through QuickJS at BUILD time — which the
engine ships as the optional `ejs` extra. Requiring it would break the gate on
a plain `uv sync`.

**Shipped:** the gate probes the engine for `quickjs_available()`, includes the
lane when it can, and prints that it is skipping it when it cannot. Both paths
were run and both pass. A gate that quietly covers less would be worse than one
that admits it.

**Decide:** if you would rather the gate hard-require the extra (simpler, one
path, but a new prerequisite for anyone running it), say so and the probe comes
out.
