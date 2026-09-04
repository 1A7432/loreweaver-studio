#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for Loreweaver Studio (Tauri 2: Rust + Bun/Vite).
# Safe to re-run: every step is guarded and converges on the same state.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"
export CARGO_HOME="${CARGO_HOME:-/usr/local/cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-/usr/local/rustup}"

# --- Tauri system libraries (WebKitGTK + friends). The Rust core links against
# these, so `cargo build/clippy/test` need them present. apt-get install is
# naturally idempotent, so a re-run is a fast no-op once they are installed. ---
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  sudo apt-get update
  sudo apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
fi

# Expose a $HOME-installed binary on the system PATH so *every* shell sees it —
# interactive or not, login or not. Ubuntu's default .bashrc returns early for
# non-interactive shells, so a PATH line there would not reach `bun run ...`.
link_into_path() {
  local target="$1" name="$2"
  [ -x "$target" ] || return 0
  sudo ln -sfn "$target" "/usr/local/bin/$name"
}

# --- Bun (JS runtime + package manager the repo pins) ---
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
link_into_path "$BUN_INSTALL/bin/bun" bun
link_into_path "$BUN_INSTALL/bin/bunx" bunx

# --- uv (drives the engine's Python for the cross-repo round-trip gate) ---
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
link_into_path "$HOME/.local/bin/uv" uv
link_into_path "$HOME/.local/bin/uvx" uvx

# --- Rust: the workspace pulls edition-2024 crates, so it needs rustc >= 1.85.
# The base image may default to an older pinned toolchain; make stable the default. ---
rustup toolchain install stable --profile minimal --component rustfmt --component clippy
rustup default stable

# --- JavaScript dependencies ---
bun install --frozen-lockfile

# --- Cross-repo round-trip gate: the engine checkout + its optional `ejs` extra
# (the fixture's rules-script rulepack compiles through QuickJS at pack-build time). ---
ENGINE_REPO="$HOME/trpg_kp"
if [ ! -d "$ENGINE_REPO/.git" ]; then
  git clone --depth 1 https://github.com/1A7432/loreweaver.git "$ENGINE_REPO"
else
  git -C "$ENGINE_REPO" pull --ff-only || true
fi
( cd "$ENGINE_REPO" && uv sync --extra ejs )

# check_roundtrip.sh / check_live_connect.sh default to the sibling path
# ../trpg_kp, i.e. /trpg_kp from /workspace. `/` is not writable by the agent
# user but sudo is, so expose the $HOME checkout there. This makes
# `bun run roundtrip` work in any shell without needing an env override.
sudo ln -sfn "$ENGINE_REPO" /trpg_kp

echo "loreweaver-studio: install complete"
