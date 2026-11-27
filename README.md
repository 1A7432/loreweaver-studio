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
admin sent you — or press **Host locally & play** to run a server on this computer and sit down
at it as its room admin.

### Host locally & play

One press starts a protocol 3.0 server on this machine (`serve --local`: loopback only, no
relay, no network needed) and connects you to it as the room admin; you are also the operator
of that server. Leaving the table, pressing **Stop the server**, or quitting the app stops it —
and so does the app crashing or being killed: the server is started with
`--until-stdin-closes` and stops when the app's end of its input goes away. A folder another
live server holds (a terminal client's, say) is refused, in so many words.

What it needs — there is **no published 3.0 server to download yet**, so the app does not
download one:

- a `loreweaver` executable (3.x) on your PATH, **or**
- [Bun](https://bun.sh) and a checkout of the [engine](https://github.com/1A7432/loreweaver)
  on its `v3` branch with `bun install` run at its root, set as **Engine checkout** in the
  studio's _AI & engine settings_ (the same setting the pack builder uses).

Where things live: the server's folder is the one you pick on the connect screen, or by
default `local-server` in the app's data folder — `~/Library/Application Support/dev.loreweaver.studio/`
on macOS, `%APPDATA%\dev.loreweaver.studio\` on Windows, `~/.local/share/dev.loreweaver.studio/`
on Linux. Its data (database, keys, installed packs) is in `data/` inside it. The first start
prints the room admin's key; the app keeps it in `local-server-keys.json` in its data folder
(readable by you alone) and uses it every time after. If that key is lost, the next start makes
a new admin key with the server's own `key` command and says so.

The model: the server starts **without** one (it says so on the menu). Set it on the **Models**
screen as the room admin — no restart; the server keeps it in its own database. None of the
app's AI-drafting settings and none of your shell's `TRPG_*` variables reach it.

Two modes, one app:

- **Play** (default), on protocol 3.0: the narrative log with dice drawn from the event's own
  fields, streaming drafts, character / party / scene / variables cards fed by views, the
  claimable characters, a pack's template panels (evaluated by the protocol package's
  `panelBlocks`, the one evaluation every client shares) and page panels (one HTML file each,
  run in a sandboxed frame with no network, through the page bridge —
  [docs/PAGE-BRIDGE.md](docs/PAGE-BRIDGE.md)), media, audio, the session report and the admin
  screens (access keys, models, content and packs, the room), and hosting a server locally.
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
  object (on stdout when it succeeds, on stderr when it refuses). The pack builder and local
  hosting (`src-tauri/src/host_local.rs`) find it the same way.

## Status

- **Play mode**: on protocol 3.0, page panels included ([docs/PAGE-BRIDGE.md](docs/PAGE-BRIDGE.md)
  — read its list of what the WebView cannot stop, and the Windows IPC check still to make).
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
  (`scripts/check_live_connect.sh`); the room admin installs the pack of a. (`pack install`),
  subscribes `panels`, and fetches the page panel's HTML over the byte channel by the hash the
  view gives: it must be the sha256 of, and byte for byte, the file Studio wrote;
- **g. host locally** — the app's own host-local code (`src-tauri/tests/host_local_live.rs`)
  finds the engine checkout with the app's probe and starts the real server three times over
  one data directory (its first key, the key the app kept, a key made after the app lost it),
  each time connecting through the real link as the room admin, stopping it and checking the
  process is gone; then a second instance over the same folder is refused with
  `data_dir_in_use`, and the first is dropped without being stopped — its server must stop by
  itself when its input pipe ends (`--until-stdin-closes`); a `TRPG_*` model setting the server
  would refuse is exported to prove none reaches it. `LIVE_CONNECT=0` skips f and g.

It needs the engine checkout (default `../trpg_kp`, override with `TRPG_KP_REPO`), on its `v3`
branch, with `bun install` run at its root:

```sh
git clone --branch v3 https://github.com/1A7432/loreweaver.git ../trpg_kp   # once
(cd ../trpg_kp && bun install)                                             # once
bun run roundtrip
```

The engine runs from a temporary working directory (its `.env` is never read); temporary
directories are removed, and any server a stage started is stopped, on every exit.

## License

[MIT](LICENSE)
