# Handback — decisions for the owner

Questions raised while executing `docs/OVERHAUL-2026-08.md`. Nothing here
blocked the work: each item states what was shipped in the meantime and what
would change if you decide otherwise. Newest batch last.

All six batches are done, the owner's three follow-up decisions are
implemented, and every gate in §1 is green — including the round-trip gate and
its live-connect stage. Nothing is pushed.

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

### 2. Two different install targets in the pack bench — RESOLVED (unify)

Every install path now goes through `lib/packInstall.ts` and lands in the local
server's own data dir: it is the one directory the studio can promise something
about, since it is the one the app itself serves from. The command line the
bench displays carries the same `TRPG_DATA_DIR` overlay, so pasting it does
what the button did, and the run result names where the pack landed.

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

Consumed after the owner's go-ahead:

- **9 (`contents.presets`)** — the pack bench ships a preset straight from the
  studio's own library; the round-trip fixture builds one through the engine's
  real preset parser.
- **11 (`.var set/add`)** — a keeper write control on the state panel, off by
  default, routed through the ordinary command path.

Still untouched, and still requiring nothing:

- **10 (world-card prose → module brief)** — landed upstream; at most the forge
  could stop implying that a world card's prose is inert. Not a defect today.

## Batch 6 — the round-trip gate

### 4. The rules-script lane depends on an optional engine extra — RESOLVED (require it)

The probe is gone. `uv sync --extra ejs` is a documented prerequisite of the
round-trip gate, checked by name up front: a missing extra fails with the exact
command and the exact repo rather than surfacing later as a PackError about a
rulepack. One path, and the same coverage on every machine.
