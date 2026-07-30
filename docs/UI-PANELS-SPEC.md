# UI panels spec — SNAPSHOT

> Snapshot for the studio window, refreshed 2026-07-30 after M15a landed. The
> CANONICAL spec lives in the main repo at `trpg_kp/docs/specs/M15-ui-panels.md`
> — on divergence, canonical wins; amend there first, then refresh this copy.
> (Notably: the earlier draft's `asset_request` frame is DROPPED — asset pull
> rides the media byte channel's `{op:"get", hash}`.)

## Goal

Modules dress the table: a world ships not just rules and lore but its own interface —
HUDs, case boards, maps, minigames — rendered by protocol clients. This replaces the
retired chat adapters as the presentation direction. It must beat SillyTavern on BOTH
axes: more extensible (real sandboxed code, multi-client) AND easier (most authors never
write JS).

**Non-goals (permanent):** module code touching app chrome (connect screen, settings,
keys — phishing surface); panel↔panel communication (coordination belongs in server-side
hooks); network access from panels (anti-exfiltration); player-uploaded panels (panels
arrive only via packs the keeper enables — the 拆卡 rule extended to UI).

## The three tiers

- **Tier 0 — declarative blocks** (SHIPPED, protocol v1.7): `meter/stat/badge/text/
divider/choices` emitted by hooks via `emitUI`. Every client renders natively, TUI
  included. Grows by adding block kinds, never required to write JS.
- **Tier 1 — declarative panels** (this spec): a pack declares named panels — layouts of
  Tier-0 blocks with live variable bindings — in `ui/panels.yaml`. Pure data; renders on
  every client; the card forge can build them visually.
- **Tier 2 — sandboxed custom views** (this spec): real HTML/JS/CSS in a locked-down
  iframe, for interactive maps / animated draws / bespoke sheets. Rich clients only
  (studio); every Tier-2 panel declares a Tier-0/1 `fallback` for other clients.

## Boundary: slots, not takeover

Panels mount ONLY into the play surface, in fixed slots the client shell owns:

| slot      | studio                                             | TUI                                  |
| --------- | -------------------------------------------------- | ------------------------------------ |
| `sidebar` | right column, stacked, collapsible                 | sidebar sections (Tier 1 / fallback) |
| `tray`    | bottom strip                                       | folded into sidebar                  |
| `modal`   | on-demand overlay (player opens from a panel menu) | folded into sidebar                  |

The player can always collapse/close any panel. The shell never yields the narrative log,
input line, or any chrome.

## Privilege model (one sentence)

**A panel acts as the player viewing it.** Inbound it receives only that viewer's
filtered data; outbound it can send only what that player could type. No new privilege
surface exists; keeper-only actions stay on the command surface.

## Pack format

New optional manifest kind + directory:

```yaml
# pack.yaml
contents:
  panels: [ui/panels.yaml]
```

```yaml
# ui/panels.yaml
panels:
  - id: case-board # slug, unique in pack; wire id = "<packId>/<id>"
    title: { en: Case Board, zh: 案情板 }
    slot: sidebar # sidebar | tray | modal
    audience: all # all | player | keeper — filtered SERVER-side
    blocks: # Tier 1: template blocks (see below)
      - { kind: meter, label: { en: Fear, zh: 恐慌 }, value: { $var: town_fear }, min: 0, max: 10 }
      - repeat:
          prefix: "mvu.线索."
          block: { kind: badge, label: { $leaf: label }, value: { $leaf: value } }
  - id: manor-map
    title: { en: Manor Map, zh: 庄园地图 }
    slot: modal
    audience: all
    entry: ui/manor-map/index.html # Tier 2: presence of `entry` makes it tier 2
    assets: # explicit list; build fails on missing/undeclared
      - ui/manor-map/index.html
      - ui/manor-map/app.js
      - ui/manor-map/map.webp
    fallback: # REQUIRED for tier 2 (or `fallback: null` explicitly)
      - { kind: text, text: { en: "Map available in the rich client.", zh: "地图请在富客户端查看。" } }
```

Build/install validation (`core/pack.py`): schema; slug/slot/audience enums; tier-2
`fallback` present (null allowed but explicit); per-panel `entry`+js+css ≤ **2 MB**;
≤ **16 panels** per pack; every asset listed, existing, sha256'd at build (same pipeline
as pack assets); localized strings via the existing en/zh mapping rule. Trust card gains
`panels: N`.

Implementation clarifications (locked during M15a):

- **Panel assets ride the pack asset pipeline literally:** at build time every path a
  tier-2 panel declares under `assets:` is folded into the built manifest's top-level
  `assets:` block (deduped if the author also listed it), so sha256/mime/size stamping,
  install-time verification, extraction into the pack home, trust `asset_bytes`, and
  hash→blob resolution are all the one existing code path. `panels.yaml` itself stays
  hash-free; the wire manifest joins panel asset paths to the manifest's asset records.
- **A tier-2 panel is a self-contained static root:** its `entry` and every declared
  asset must live under the entry file's directory; the wire `assets[].path` is the
  path RELATIVE to that directory (`app.js`, `img/map.webp`). This keeps the studio's
  per-panel opaque origin a straight directory mapping.
- **Small defensive caps** (same spirit as the pack caps): a `panels.yaml` file ≤ 256 KB;
  ≤ 32 template blocks per panel (a `repeat` construct counts as one); `repeat` does not
  nest; ≤ 8 declared asset files per tier-2 panel beyond the entry.

### Tier-1 template constructs (deliberately tiny, v1)

Base vocabulary = the v1.7 `ui` block kinds. Two template-only additions:

1. **Value binding:** any scalar field may be `{$var: "<variable id>"}` — the CLIENT
   substitutes the current value from its own `state.variables` (ids exactly as they
   appear there: modvar ids, `mvu.`-prefixed leaves). Variable absent/hidden for this
   viewer → the whole block is omitted (fail-closed; a panel can never widen visibility —
   the state wire filter remains the single choke point).
2. **Repeat:** `{repeat: {prefix: "<id prefix>", block: <TemplateBlock>}}` — one instance
   per visible variable whose id starts with the prefix; inside, `{$leaf: id|label|value}`
   substitutes. Cap: 32 instances.

Localized strings in templates: `{en,zh}` maps; client picks its locale (fallback en).

## Room enablement

Install ≠ enable holds. New keeper command **`.panels enable|disable|list <packId>`**
(dual-dialect; keeper-gated like `.skill`), stored at `room_panels.{chat_key}`. The room
manifest = enabled packs' installed `panels.yaml` files, resolved per viewer.

## Protocol v1.8 (all additive)

1. **`ui_manifest`** (server→client; on join after `state`, and after any enable change):

```jsonc
{"type": "ui_manifest", "panels": [
  {"id": "blackmoor/case-board", "title": {"en": "...", "zh": "..."}, "slot": "sidebar",
   "tier": 1, "blocks": [/* template blocks */]},
  {"id": "blackmoor/manor-map", "title": {...}, "slot": "modal", "tier": 2,
   "entry": {"hash": "<sha256>", "size": 1234},
   "assets": [{"path": "app.js", "hash": "...", "size": 999, "mime": "text/javascript"}],
   "fallback": [/* blocks */] }
]}
```

Full-replace semantics: the frame carries this VIEWER's complete panel list (audience
already filtered server-side — `audience` itself never appears on the wire). Empty list =
no panels.

2. **Assets** — content-addressed pull over the EXISTING media byte channel; **no new
   control frame** (the earlier draft's `asset_request` is dropped — a server-initiated
   push would invert the media channel's client-pull direction on both carriers for no
   gain). The client fetches each hash its manifest names with the same `{op:"get",
hash}` request media uses (new bidi stream on Iroh / binary message on WS); the
   server resolves the hash first against the caller's room media, then against
   installed-pack assets of packs enabled in the caller's room (no arbitrary blob
   oracle), and replies with the same `{op:"get", hash, size, mime, name}` header +
   bytes. Client verifies sha256 before caching (disk cache keyed by hash, immutable).

3. **`panel_event`** (server→client): `{"type": "panel_event", "panel": "<wire id>",
"payload": <JSON ≤ 32 KB>}` — produced by the new hook emitter
   **`emitPanel(panelId, payload)`**; delivered only to viewers whose manifest contains
   that panel; ≤ 20 per turn (excess dropped + logged, same style as other hook caps).

4. **`panel_intent`** (client→server): `{"type": "panel_intent", "panel": "<wire id>",
"kind": "choice" | "input" | "roll", "value": "<string ≤ 2000>"}`.
   Server checks the panel is in THAT member's manifest, then routes exactly as if the
   member typed it: `choice` → the existing choice-answer path; `input` → a normal player
   input line; `roll` → a public `.r <value>` as that player (dice engine validates the
   expression). Normal per-member rate limits apply.

`protocol.md` + `protocol.zh.md` document all of the above; `clients/protocol` types bump
to **1.8.0** (npm publish is the USER's interactive step — prepare, don't attempt).

## Tier-2 runtime (studio)

- **Isolation:** `<iframe sandbox="allow-scripts">` — NO `allow-same-origin` (opaque
  origin). CSP: `default-src 'none'; script-src/style-src/img-src/font-src/media-src`
  from the local pack-asset origin only; **no `connect-src`** (panels cannot reach any
  network — they hold room state; exfiltration is structurally off).
- **Serving:** panel assets served from the verified hash cache via a custom
  protocol/blob origin; the entry document gets the host-injected bootstrap + theme CSS
  custom properties.
- **Bridge** (postMessage with a per-panel nonce; typed in `loreweaver-protocol`):

```ts
window.loreweaver = {
  version: "1",
  ready(): Promise<{panel: string, locale: string, theme: Record<string,string>}>,
  onState(cb: (s: {variables: StateVariable[], character?: ..., clock?: ...}) => void),
  onEvent(cb: (payload: unknown) => void),        // panel_event payloads
  send(kind: "choice" | "input" | "roll", value: string): void,  // -> panel_intent
}
```

`onState` delivers the SAME per-viewer-filtered shapes the protocol `state` frame
carries — no second data path.

- **Player consent:** first join to a room with panels shows a one-line notice ("this
  room draws its own interface — N panels, X MB"); a client setting `blocks-only mode`
  renders every Tier-2 panel's fallback instead. Default: render (the sandbox is what
  makes default-on defensible).
- **Framework-agnostic:** packs ship BUILT static assets; authors may use any framework
  (bundled into their own js). The platform pins the bridge, never a framework.

## TUI mapping

Tier 1 renders with the existing block renderer (sidebar; `tray`/`modal` fold into
sidebar sections). Tier 2 renders its `fallback` blocks; `fallback: null` renders one
localized "available in the rich client" line. Image-bearing blocks degrade to their
label/alt line.

## Iron-rule threading (checklist for both implementations)

- Per-viewer data only: manifest audience filter + `$var` binding against the viewer's
  own state — both reuse the existing viewer-role plumbing (state frames are already
  per-member; MVU exposure filter unchanged).
- Keeper-only panels never appear in a player's manifest (structural, not hidden-by-CSS).
- Dice-first: `roll` intents go through the real dice engine as the viewing player.
- Determinism: panels render and collect intent; every judgment stays server-side.
- 拆卡: panels enter a room only via keeper-enabled installed packs.

## Phasing

- **M15a (main repo):** pack schema + validation + `.panels` command + per-viewer
  `ui_manifest` + Tier-1 templates + `emitPanel`/`panel_event` + `panel_intent` routing +
  asset resolution over media machinery + TUI Tier-1/fallback rendering + protocol docs
  (en/zh) + `loreweaver-protocol` 1.8.0 types.
- **S-UI (studio):** Tier-1 renderer in play mode + hash asset cache + Tier-2 iframe
  host/bridge/CSP + consent notice + blocks-only setting. Build against this spec with
  local fixtures until 1.8.0 types land; vendor the frame types from this file if needed.
- **Later (separate batches):** forge visual panel builder + AI panel generation;
  `create-loreweaver-panel` scaffold; more Tier-0 block kinds (image, table, timeline,
  handout/card); canvas/map primitives if demand proves out.
