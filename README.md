# Loreweaver Studio

> **Early stage.** Layout, formats, and internals change without notice.

A cross-platform rich client and card-authoring studio for
[Loreweaver](https://github.com/1A7432/loreweaver) — the self-hosted AI gamemaster engine.
Built with Tauri 2 (Rust core + TypeScript/React UI), targeting desktop
(macOS / Windows / Linux) and mobile (iOS / Android).

Two modes, one app:

- **Play** (default): a rich client for the open Loreweaver wire protocol — markdown
  narrative log, color-coded dice, live character/party/variables panels (keeper view
  shows unexposed variables dimmed + locked), presence, and AI-keeper turn status.
- **Studio**: a local-first card forge with three benches:
  - **Forge** — typed module variables, worldbook entries, and hooks, exported as a
    native Loreweaver bundle or a SillyTavern-compatible card;
  - **Card split (拆卡)** — open any ST card (JSON/PNG) and see it decomposed the way
    the engine imports it: character half | world half, with the MVU `[InitVar]` tree
    promoted to typed, validated variables (author confirms every row) and suggested
    `.var expose` lines generated for the pack notes;
  - **Pack** — drop cards/lorebooks/assets, get an installable `.lwpack`: deterministic
    classification and splitting, AI-drafted (human-confirmed) bilingual metadata, a
    generated source tree, then the ENGINE CLI builds and optionally installs it — the
    studio contains no zip writer on purpose; validation has one source of truth.
  - **AI drafting** throughout is gated by deterministic code: every model output goes
    through the same schema validation as hand-typed content or it never lands. Bring
    your own provider (OpenAI-compatible or Anthropic); the key lives in the OS
    credential store and requests leave from the Rust side, never the WebView.

## Architecture

- **Transport** lives in the Rust core (`crates/transport`): an [iroh](https://iroh.computer)
  QUIC connection speaking the newline-delimited JSON protocol (ALPN `loreweaver/tui/1`)
  defined by the main repo's
  [docs/protocol.md](https://github.com/1A7432/loreweaver/blob/main/docs/protocol.md).
  The WebView never does networking; it consumes typed frames over the Tauri event bridge.
- **Frontend**: React + TypeScript + Vite, `zustand` state, `i18next` (en/zh from day one).
- **Shared frame types** come from
  [`@loreweaver/protocol`](https://github.com/1A7432/loreweaver/tree/main/clients/protocol),
  consumed as the published `loreweaver-protocol` npm package.

## Status

- **Desktop (macOS)**: verified — release build + `.app` bundle succeed (`bun tauri build`;
  the final DMG script needs a GUI session).
- **Windows / Linux**: CI compiles and tests the full workspace on Linux; no bundles built yet.
- **iOS**: `src-tauri/gen/apple` is generated (Tauri 2 + CocoaPods). Compiling for the
  `aarch64-apple-ios` target currently requires accepting the Xcode license
  (`sudo xcodebuild -license accept`) on this machine; signing needs a development team.
- **Android**: blocked on local tooling — the SDK lacks `cmdline-tools` and an NDK
  (`sdkmanager "ndk;…"`); `tauri android init` bails until they exist.
- **Card forge**: local authoring + dual export, card splitting, MVU→VarSpec promotion,
  AI drafting, and the pack pipeline ([formats](docs/FORMATS.md)); native-bundle import
  awaits upstream M14.
- Protocol feedback for upstream lives in [PROTOCOL_NOTES.md](PROTOCOL_NOTES.md);
  engine/tooling asks from the forge work live in [UPSTREAM_TODO.md](UPSTREAM_TODO.md).

## Development

Prerequisites: Rust stable and [Bun](https://bun.sh):

```sh
bun install
bun tauri dev
```

Checks (all run in CI):

```sh
bun run lint && bun run format:check && bun run typecheck && bun run test && bun run build
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

### Cross-repo round-trip gate

`bun run roundtrip` (`scripts/check_roundtrip.sh`) fails when the studio's real
output and the engine's real parsers drift apart. It pins four things:

- **lorecard v1 byte drift** — the real `exportNativeBundle` output, regenerated
  on the spot, must stay byte-identical to the engine's pinned
  `tests/fixtures/studio_export.lorecard.json`;
- **pack manifest v2 full-tree build** — a full-surface module pack (world
  lorecard, ST character card, lorebook, skill, rulepack patch, tier-1/2
  panels, presentation kit, assets) is laid out by the real
  `buildPackSourcePlan` (`scripts/gen_roundtrip_pack.ts`) and must build clean
  through the engine's `python -m app --pack --json`, with the expected
  detection results in the returned `trust` object;
- **the engine's conformance suites** for the pinned fixtures
  (`test_studio_export_fixture`, `test_lorecard`, `test_visible_when_vectors`);
- **the live-connect smoke gate** (`scripts/check_live_connect.sh`) — the three
  above are all static formats, so they cannot notice that the two _processes_
  stopped talking. This stage spawns a real `python -m app --serve` engine in a
  sandboxed data dir and dials it through the real Rust transport crate
  (`crates/transport/tests/live_connect.rs`, `#[ignore]`d for a normal
  `cargo test`), asserting the join handshake ends in a `welcome`. Skip it with
  `LIVE_CONNECT=0` on a machine without cargo.

It needs a checkout of the engine repo (default `../trpg_kp`, override with
`TRPG_KP_REPO`) with `uv` available:

```sh
git clone https://github.com/1A7432/loreweaver.git ../trpg_kp   # once
bun run roundtrip
```

Generated trees land in the gitignored `target/roundtrip/` for inspection.

## License

[MIT](LICENSE)
