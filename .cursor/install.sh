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

# --- Bun (JS runtime + package manager the repo pins) ---
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi

# --- uv (drives the engine's Python for the cross-repo round-trip gate) ---
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi

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

# --- Make bun/uv discoverable and point `bun run roundtrip` at the engine checkout
# in future interactive shells (guarded so re-runs don't duplicate the block). ---
MARKER="# >>> loreweaver-studio env >>>"
if ! grep -qF "$MARKER" "$HOME/.bashrc" 2>/dev/null; then
  cat >> "$HOME/.bashrc" <<'EOF'
# >>> loreweaver-studio env >>>
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$HOME/.local/bin:$PATH"
export TRPG_KP_REPO="$HOME/trpg_kp"
# <<< loreweaver-studio env <<<
EOF
fi

echo "loreweaver-studio: install complete"
