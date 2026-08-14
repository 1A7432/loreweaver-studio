#!/usr/bin/env bash
# Live-connect smoke gate (studio ↔ engine), the half no fixture can cover:
# spawn a REAL `python -m app --serve` engine from the sibling checkout, dial it
# through the REAL Rust transport crate, and assert the join handshake completes
# with a `welcome` on the event channel.
#
# Why it exists: the transport used to close the connection on any welcome that
# did not announce protocol major 1. The engine had been on 2.x for weeks and
# nothing caught it, because no test in either repo ever connected to a real
# server — the loopback tests write their own welcome, so they agreed with
# whatever the client believed. This gate fails if the Rust layer ever again
# refuses a welcome the frontend (`src/store/connection.ts`) would accept.
#
# Usage:  bash scripts/check_live_connect.sh   (also stage 5 of check_roundtrip.sh)
# Engine repo: $TRPG_KP_REPO, default ../trpg_kp (sibling checkout).
#
# The engine runs fully sandboxed: its own keystore, data dir and env file under
# a temp directory, so nothing touches the operator's campaign data, and with no
# LLM configured it falls back to the offline demo Keeper (no external calls).

set -euo pipefail

STUDIO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_REPO="${TRPG_KP_REPO:-$STUDIO_ROOT/../trpg_kp}"
# How long the engine gets to bind an endpoint and print its ticket. The relay
# handshake dominates; the engine's own startup timeout is 45s.
BOOT_TIMEOUT="${LIVE_CONNECT_BOOT_TIMEOUT:-60}"

say() { printf '\n==> %s\n' "$*"; }
fail() {
  printf 'live-connect: FAIL: %s\n' "$*" >&2
  exit 1
}

[ -d "$ENGINE_REPO" ] || fail "engine repo not found at $ENGINE_REPO (set TRPG_KP_REPO)"
ENGINE_REPO="$(cd "$ENGINE_REPO" && pwd)"
[ -f "$ENGINE_REPO/app.py" ] || fail "$ENGINE_REPO does not look like the loreweaver engine repo (app.py missing)"
command -v cargo >/dev/null 2>&1 || fail "cargo not found on PATH"
command -v uv >/dev/null 2>&1 || fail "uv not found on PATH (the engine runs under 'uv run')"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/lw-live-connect.XXXXXX")"
ENGINE_PID=""

cleanup() {
  local status=$?
  if [ -n "$ENGINE_PID" ] && kill -0 "$ENGINE_PID" 2>/dev/null; then
    # SIGTERM is the engine's documented graceful stop (it cancels the serve
    # task and closes the endpoint); SIGKILL only if it ignores us.
    kill -TERM "$ENGINE_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$ENGINE_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$ENGINE_PID" 2>/dev/null || true
    wait "$ENGINE_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$SANDBOX/engine.log" ]; then
    printf '\n--- engine log (tail) ---\n' >&2
    tail -40 "$SANDBOX/engine.log" >&2 || true
  fi
  rm -rf "$SANDBOX"
  return $status
}
trap cleanup EXIT

KEYS="$SANDBOX/keys.toml"
TICKET_FILE="$SANDBOX/iroh-ticket.txt"
KEY_FILE="$SANDBOX/keeper-key.txt"

say "1/3 spawn the engine (--serve) in a sandboxed data dir"
# An empty env file keeps the operator's real .env (LLM keys, custom data dir)
# out of the run; the engine then falls back to the offline demo Keeper.
: >"$SANDBOX/env"
(
  cd "$ENGINE_REPO"
  TRPG_ENV_FILE="$SANDBOX/env" \
  TRPG_DATA_DIR="$SANDBOX/data" \
  TRPG_BOOTSTRAP_ROOM="live-connect" \
    uv run python -m app --serve --keys "$KEYS" >"$SANDBOX/engine.log" 2>&1 &
  echo $! >"$SANDBOX/engine.pid"
)
ENGINE_PID="$(cat "$SANDBOX/engine.pid")"

# The engine writes both sidecars next to --keys: keeper-key.txt at bootstrap,
# iroh-ticket.txt once the endpoint is online. Wait for the ticket (the later of
# the two) rather than sleeping a fixed amount.
for _ in $(seq 1 "$((BOOT_TIMEOUT * 2))"); do
  [ -s "$TICKET_FILE" ] && break
  kill -0 "$ENGINE_PID" 2>/dev/null || fail "the engine exited before printing a ticket"
  sleep 0.5
done
[ -s "$TICKET_FILE" ] || fail "no ticket after ${BOOT_TIMEOUT}s — the endpoint never came online"
[ -s "$KEY_FILE" ] || fail "the engine printed a ticket but minted no keeper key at $KEY_FILE"

# `ticket=endpoint…` / `key=…` sidecar lines; take the value after the first `=`.
TICKET="$(sed -n 's/^ticket=//p' "$TICKET_FILE" | head -1)"
KEY="$(sed -n 's/^key=//p' "$KEY_FILE" | head -1)"
[ -n "$TICKET" ] || fail "could not read a ticket out of $TICKET_FILE"
[ -n "$KEY" ] || fail "could not read a key out of $KEY_FILE"
echo "ok: engine pid $ENGINE_PID serving ticket ${TICKET:0:24}…"

say "2/3 dial it through the real transport crate"
(
  cd "$STUDIO_ROOT"
  LOREWEAVER_LIVE_TICKET="$TICKET" \
  LOREWEAVER_LIVE_KEY="$KEY" \
    cargo test -p loreweaver-transport --test live_connect -- --ignored --nocapture
)

say "3/3 the engine survived the session"
kill -0 "$ENGINE_PID" 2>/dev/null || fail "the engine died during the handshake (see log above)"

say "live-connect gate: PASS"
