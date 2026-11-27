# Loreweaver Studio

The desktop client for [Loreweaver](https://github.com/1A7432/loreweaver) — the self-hosted AI
gamemaster engine — and its pack-authoring studio. Built with Tauri 2 (Rust core +
TypeScript/React UI), targeting desktop (macOS / Windows / Linux) and, later, mobile.

> **This branch (`v3`) targets the engine's 3.0 rewrite** (its `v3` branch: a Bun server,
> wire protocol 3.0, pack manifest 3, panels 3.0). It speaks protocol 3.0 only — it does not
> connect to a 2.x server, and the packs it writes do not install on one. `main` is the 2.x
> client.

## Install

Grab an installer from the [latest release](https://github.com/1A7432/loreweaver-studio/releases/latest):

- **macOS** — `.dmg` (separate Apple-silicon and Intel builds). The builds are not
  yet notarized, so the first launch needs one extra step: right-click the app →
  **Open** (or `xattr -cr "/Applications/Loreweaver Studio.app"` once).
- **Windows** — the NSIS `-setup.exe`. Unsigned for now: if SmartScreen interjects,
  choose **More info → Run anyway**.
- **Linux** — `.AppImage` (`chmod +x` and run) or `.deb`.

Or build from source with Rust stable and [Bun](https://bun.sh):

```sh
git clone https://github.com/1A7432/loreweaver-studio && cd loreweaver-studio
bun install
bun tauri build          # a .app / bundle for your platform
bun tauri dev            # or run it unbundled, with hot reload
```

Then open the app and, on the connect screen, paste the **ticket** and **invite key** your room
admin sent you. (**Host locally & play** — the one-click local server — is not on 3.0 yet:
to play, connect to a running 3.0 server.)

Two modes, one app:

- **Play** (default), on protocol 3.0: the narrative log with dice drawn from the event's own
  fields, streaming drafts, character / party / scene / variables cards fed by views, the
  claimable characters, a pack's template panels (evaluated by the protocol package's
  `panelBlocks`, the one evaluation every client shares), media, audio, the session report and
  the admin screens (access keys, models, content and packs, the room). **Not yet on 3.0:**
  running page panels (a page panel shows its fallback) and hosting a server locally.
- **Studio**: a local-first authoring bench:
  - **Forge** — typed module variables and worldbook entries, exported as a native
    `*.lorecard.json` or a SillyTavern card (JSON or PNG). Hook scripts and a pregenerated
    cast are gone: a 3.0 engine runs no card hooks and imports no pregens.
  - **Card split (拆卡)** — open any ST card and see it decomposed the way the engine imports
    it: character half | world half, with the MVU `[InitVar]` tree promoted to typed
    variables (author confirms every row).
  - **Pack** — cards, a rule-pack patch, skills, **modules** (the pack's code: TypeScript
    against the engine's module SDK — Studio writes and declares the source; it does not
    type-check or run it), panels 3.0 with a live preview, and a presentation kit → a pack
    source tree (manifest 3). The ENGINE builds it (`loreweaver pack`, which bundles the
    modules) and Studio verifies the result with the engine's own installer in a scratch data
    directory, then shows the trust card and the exact commands an operator and a room admin
    type. Studio contains no zip writer on purpose: validation has one source of truth.
    Lorebooks as a pack kind, prompt presets, prep scripts, rules scripts and `hooks.js` are
    not part of 3.0 and are gone; a 2.x draft is migrated on load, and the author is told
    what was dropped.
  - **AI drafting** throughout is gated by deterministic code: every model output goes
    through the same validation as hand-typed content or it never lands. Bring your own
    provider (OpenAI-compatible or Anthropic); requests leave from the Rust side.

The formats themselves are the engine's, specified in its
[docs/lwf](https://github.com/1A7432/loreweaver/tree/v3/docs/lwf) (pack, panels, cards) — see
[docs/FORMATS.md](docs/FORMATS.md) for how Studio maps onto them.

## Architecture

- **Transport** lives in the Rust core (`crates/transport`): an [iroh](https://iroh.computer)
  QUIC link (ALPN `loreweaver/3`) that frames lines and carries bytes as protocol 3.0 defines
  them. The protocol itself — hello, resume, frames, views — is the protocol package's
  `Session`; one connection owner in TypeScript drives it. The WebView never does networking.
- **Frontend**: React + TypeScript + Vite, `zustand` state, `i18next` (en/zh).
- **Protocol 3.0 library**: `loreweaver-protocol` (`/v3`), taken from the engine checkout's
  `clients/protocol` by path until 3.0.0 is on npm.
- **Engine command line** (`src-tauri/src/engine.rs`): a `loreweaver` executable on PATH, or an
  engine checkout run as `bun <dir>/server/src/cli/main.ts`, always from a temporary working
  directory and with the caller's `TRPG_*` variables removed. Each command prints one JSON
  object (on stdout when it succeeds, on stderr when it refuses).

## Status

- **Play mode**: on protocol 3.0, except page panels and local hosting (above).
- **Studio**: writes 3.0 packs; the round-trip gate builds and installs one with the real
  engine on every CI run.
- **Desktop (macOS)**: release build + `.app` bundle verified. **Windows / Linux**: CI compiles
  and tests the full workspace on Linux.
- **Mobile**: not yet.
- Open asks of the engine live in [UPSTREAM_TODO.md](UPSTREAM_TODO.md) and
  [PROTOCOL_NOTES.md](PROTOCOL_NOTES.md).

## Development

Prerequisites: Rust stable and [Bun](https://bun.sh):

```sh
bun install
bun tauri dev
```

Checks (all run in CI):

```sh
bun run lint && bun run i18n:lint && bun run format:check && bun run typecheck && bun run test && bun run build
cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo test --workspace
```

### Cross-repo round-trip gate

`bun run roundtrip` (`scripts/check_roundtrip.sh`) runs the engine's own code on what Studio's
own code writes, and fails on any mismatch:

- **a. generate** — the app's real `buildPackSourcePlan` lays out a pack exercising every kind
  Studio writes: a native lorecard world card, an ST character card, an ST-flavored world card
  (`[InitVar]`, EJS, a 2.x hook — counted, never run), a PNG-embedded card, a rule-pack patch, a
  skill, a module, panels (a `repeat`, a `visible_when`, a picture, a module view, a choice
  running a module command, a page with a fallback) and a presentation kit with a picture and a
  sound (`scripts/gen_roundtrip_pack.ts`);
- **b. build** — `pack <dir> --out <file>`: `ok`, the trust card's code flag and module, card
  kinds equal to Studio's own detection, rule systems, skills, panels, kit, nothing ignored;
- **c. install** — `install <file> --yes` into a temporary data directory, then `packs`;
- **d. cards** — every card the forge exports parsed by the engine's card reader: kinds and
  entry counts equal Studio's reading, no hook script, no pregen
  (`scripts/gen_studio_export_fixture.ts`);
- **e. panels** — the panels read by the engine's panels reader and wire step and evaluated with
  `panelBlocks` over sample views, compared with Studio's checks and preview
  (`scripts/roundtrip_check.ts`);
- **f. live connect** — a real 3.0 server (`serve --local`) dialled through the real Rust link
  (`scripts/check_live_connect.sh`; `LIVE_CONNECT=0` skips it).

It needs the engine checkout (default `../trpg_kp`, override with `TRPG_KP_REPO`), on its `v3`
branch, with `bun install` run at its root:

```sh
git clone --branch v3 https://github.com/1A7432/loreweaver.git ../trpg_kp   # once
(cd ../trpg_kp && bun install)                                             # once
bun run roundtrip
```

The engine runs from a temporary working directory (its `.env` is never read); temporary
directories are removed on every exit.

## License

[MIT](LICENSE)
