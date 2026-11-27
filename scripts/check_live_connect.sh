#!/usr/bin/env bash
# Live-connect smoke gate (studio ↔ engine), the half no fixture can cover:
# start a REAL protocol 3.0 server from the engine checkout (its Bun server,
# `serve --local`), dial it through the REAL Rust link crate, and walk the
# start of a session by hand: `hello` → `welcome`, a ping → `pong`, and a
# byte-channel GET of a hash nobody holds → the coded `media_not_found`.
#
# Why it exists: the loopback tests write their own server, so they agree with
# whatever the client believes. Only a real server catches an ALPN, framing or
# byte-channel drift between the two repositories.
#
# With LIVE_PAGE_PACK (a built .lwpack), LIVE_PAGE_PANEL (one of its page panels,
# <pack>/<panel>) and LIVE_PAGE_HTML (the page file Studio wrote), the session goes on: the
# room admin installs the pack, subscribes `panels`, and GETs the page by the hash the view
# gives — the hash must be the file's sha256 and the bytes the file's (check_roundtrip.sh f).
#
# Usage:  bash scripts/check_live_connect.sh   (also the live stage of check_roundtrip.sh)
# Engine repo: $TRPG_KP_REPO, default ../trpg_kp (sibling checkout, branch v3,
# with `bun install` run at its root).
#
# The server runs sandboxed, so nothing touches the operator's own data or
# settings:
#   - from a TEMPORARY working directory: Bun loads `.env` from the working
#     directory, and the engine's root `.env` (model keys) must not be read;
#   - with a temporary data directory (`TRPG_DATA_DIR`): a fresh one, so the
#     server mints the room `main`'s first admin key and prints it;
#   - with every `TRPG_*` variable of the operator's shell scrubbed first;
#   - `--local`: loopback only, no relays, no network at all.
# With no model configured the server still starts and welcomes (it says
# `model_not_configured` in its notes); this gate never asks the Keeper anything.
#
# The script stops the server it started on every exit path (success, failure,
# Ctrl-C): SIGTERM, which the server handles by closing cleanly, then SIGKILL.

set -euo pipefail

STUDIO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_REPO="${TRPG_KP_REPO:-$STUDIO_ROOT/../trpg_kp}"
# How long the server gets to open its store and endpoint and print its ready line.
BOOT_TIMEOUT="${LIVE_CONNECT_BOOT_TIMEOUT:-60}"

say() { printf '\n==> %s\n' "$*"; }
fail() {
  printf 'live-connect: FAIL: %s\n' "$*" >&2
  exit 1
}

[ -d "$ENGINE_REPO" ] || fail "engine repo not found at $ENGINE_REPO (set TRPG_KP_REPO)"
ENGINE_REPO="$(cd "$ENGINE_REPO" && pwd)"
ENTRY="$ENGINE_REPO/server/src/cli/main.ts"
[ -f "$ENTRY" ] || fail "$ENGINE_REPO has no protocol 3.0 server ($ENTRY missing) — check out the engine's v3 branch"
[ -d "$ENGINE_REPO/node_modules" ] || fail "the engine's dependencies are not installed — run 'bun install' in $ENGINE_REPO"
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH"
command -v cargo >/dev/null 2>&1 || fail "cargo not found on PATH"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/lw-live-connect.XXXXXX")"
SERVER_PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -f "$SANDBOX/server.err" ]; then
    printf '\n--- server stderr (tail) ---\n' >&2
    tail -40 "$SANDBOX/server.err" >&2 || true
  fi
  rm -rf "$SANDBOX"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$SANDBOX/cwd" "$SANDBOX/data"

say "1/3 start the 3.0 server (serve --local) in a sandbox"
(
  cd "$SANDBOX/cwd"
  # Drop the operator's own server settings: anything left exported would
  # configure this server (a model key, another data directory).
  for name in $(env | sed -n 's/^\(TRPG_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
  TRPG_DATA_DIR="$SANDBOX/data" exec bun "$ENTRY" serve --local >"$SANDBOX/server.out" 2>"$SANDBOX/server.err"
) &
SERVER_PID=$!

# The server prints ONE JSON line on stdout when it is ready:
# {"ok":true,"version":…,"ticket":"endpoint…","notes":[…],"first_key":{"room":"main","key":…}}
READY=""
for _ in $(seq 1 "$((BOOT_TIMEOUT * 2))"); do
  READY="$(grep -m1 '"ticket"' "$SANDBOX/server.out" 2>/dev/null || true)"
  [ -n "$READY" ] && break
  kill -0 "$SERVER_PID" 2>/dev/null || fail "the server exited before it was ready ($(cat "$SANDBOX/server.out" 2>/dev/null))"
  sleep 0.5
done
[ -n "$READY" ] || fail "no ready line after ${BOOT_TIMEOUT}s"

field() {
  READY_LINE="$READY" bun -e '
    const ready = JSON.parse(process.env.READY_LINE)
    const value = process.argv[1] === "key" ? ready.first_key?.key : ready[process.argv[1]]
    if (typeof value !== "string" || value === "") process.exit(1)
    console.log(value)
  ' "$1"
}
TICKET="$(field ticket)" || fail "the ready line carries no ticket: $READY"
KEY="$(field key)" || fail "the ready line carries no first admin key (is the data directory fresh?): $READY"
echo "ok: server pid $SERVER_PID, ticket ${TICKET:0:24}…"

say "2/3 dial it through the real link crate: hello, welcome, ping, a refused GET"
PAGE_ENV=()
if [ -n "${LIVE_PAGE_PACK:-}" ]; then
  [ -f "$LIVE_PAGE_PACK" ] || fail "LIVE_PAGE_PACK is not a file: $LIVE_PAGE_PACK"
  [ -f "${LIVE_PAGE_HTML:-}" ] || fail "LIVE_PAGE_HTML is not a file: ${LIVE_PAGE_HTML:-}"
  [ -n "${LIVE_PAGE_PANEL:-}" ] || fail "LIVE_PAGE_PANEL must name the page panel"
  PAGE_SHA="$(shasum -a 256 "$LIVE_PAGE_HTML" | cut -d' ' -f1)"
  PAGE_ENV=(
    "LOREWEAVER_LIVE_PACK=$LIVE_PAGE_PACK"
    "LOREWEAVER_LIVE_PAGE=$LIVE_PAGE_HTML"
    "LOREWEAVER_LIVE_PAGE_PANEL=$LIVE_PAGE_PANEL"
    "LOREWEAVER_LIVE_PAGE_SHA256=$PAGE_SHA"
  )
  echo "and then: install the pack, read panels, GET page $LIVE_PAGE_PANEL (sha256 ${PAGE_SHA:0:16}…)"
fi
CARGO_LOG="$SANDBOX/cargo.log"
(
  cd "$STUDIO_ROOT"
  env ${PAGE_ENV[@]+"${PAGE_ENV[@]}"} \
  LOREWEAVER_LIVE_TICKET="$TICKET" \
  LOREWEAVER_LIVE_KEY="$KEY" \
  LOREWEAVER_LIVE_NETWORK=local \
    cargo test -p loreweaver-transport --test live_connect -- --ignored --nocapture 2>&1 | tee "$CARGO_LOG"
)
# `cargo test` exits 0 when a filter matches NOTHING, so the exit code alone
# would let this gate pass vacuously. Assert that a test actually passed.
grep -Eq '^test result: ok\. [1-9][0-9]* passed' "$CARGO_LOG" \
  || fail "the live-connect test did not actually run (a filter that matches no test still exits 0) — check the test name and its #[ignore] attribute"
if [ -n "${LIVE_PAGE_PACK:-}" ]; then
  grep -q "as the studio wrote it" "$CARGO_LOG" || fail "the page stage did not run"
fi

say "3/3 the server survived the session"
kill -0 "$SERVER_PID" 2>/dev/null || fail "the server died during the session"

say "live-connect gate: PASS"
