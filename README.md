# Loreweaver Studio

> **Early stage.** Layout, formats, and internals change without notice.

A cross-platform rich client and card-authoring studio for
[Loreweaver](https://github.com/1A7432/loreweaver) — the self-hosted AI gamemaster engine.
Built with Tauri 2 (Rust core + TypeScript/React UI), targeting desktop
(macOS / Windows / Linux) and mobile (iOS / Android).

Two modes, one app:

- **Play** (default): a rich client for the open Loreweaver wire protocol — markdown
  narrative log, color-coded dice, live character/party/variables panels, presence,
  and AI-keeper turn status.
- **Studio**: a local-first card forge — typed module variables, worldbook entries,
  and hooks, exported as a native Loreweaver bundle or a SillyTavern-compatible card.

## Architecture

- **Transport** lives in the Rust core (`crates/transport`): an [iroh](https://iroh.computer)
  QUIC connection speaking the newline-delimited JSON protocol (ALPN `loreweaver/tui/1`)
  defined by the main repo's
  [docs/protocol.md](https://github.com/1A7432/loreweaver/blob/main/docs/protocol.md).
  The WebView never does networking; it consumes typed frames over the Tauri event bridge.
- **Frontend**: React + TypeScript + Vite, `zustand` state, `i18next` (en/zh from day one).
- **Shared frame types** come from
  [`@loreweaver/protocol`](https://github.com/1A7432/loreweaver/tree/main/clients/protocol),
  consumed as a `file:` dependency until that package is published to npm.

## Status

- **Desktop (macOS)**: verified — release build + `.app` bundle succeed (`bun tauri build`;
  the final DMG script needs a GUI session).
- **Windows / Linux**: CI compiles and tests the full workspace on Linux; no bundles built yet.
- **iOS**: `src-tauri/gen/apple` is generated (Tauri 2 + CocoaPods). Compiling for the
  `aarch64-apple-ios` target currently requires accepting the Xcode license
  (`sudo xcodebuild -license accept`) on this machine; signing needs a development team.
- **Android**: blocked on local tooling — the SDK lacks `cmdline-tools` and an NDK
  (`sdkmanager "ndk;…"`); `tauri android init` bails until they exist.
- **Card forge**: local authoring + dual export ([formats](docs/FORMATS.md)); server-side
  forge integration awaits upstream M14.
- Protocol feedback for upstream lives in [PROTOCOL_NOTES.md](PROTOCOL_NOTES.md).

## Development

Prerequisites: Rust stable, [Bun](https://bun.sh), and a sibling checkout of the main
repo — the `file:` protocol dependency resolves to `../trpg_kp/clients/protocol`:

```sh
git clone https://github.com/1A7432/loreweaver.git ../trpg_kp   # sibling path; the name matters
bun install
bun tauri dev
```

Checks (all run in CI):

```sh
bun run lint && bun run format:check && bun run typecheck && bun run test && bun run build
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

## License

[MIT](LICENSE)
