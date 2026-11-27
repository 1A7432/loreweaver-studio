#!/usr/bin/env bash
# Cross-repo round-trip gate (studio ↔ engine).
#
# The engine is being rewritten as protocol 3.0 (its `v3` branch: a Bun server,
# no compatibility with 2.x — wire, database, pack and card formats). Studio
# moves to it step by step, and this gate runs only what is meaningful against
# that engine today:
#
#   RUNS    the live-connect stage — a REAL 3.0 server (`serve --local`) dialled
#           through the REAL Rust link: hello → welcome, ping → pong, and a
#           byte-channel GET refused with its code (scripts/check_live_connect.sh).
#           Set LIVE_CONNECT=0 to skip it on a machine without cargo.
#
#   PARKED  the four static stages of the 2.x gate. Each one drives the FROZEN
#           Python tree (`python -m app --pack`, `uv run pytest tests/core/…`,
#           `tests/fixtures/*`), which the 3.0 engine replaces and will delete,
#           and checks formats 3.0 does not keep as they were:
#             1. lorecard v1 byte drift against tests/fixtures/studio_export.lorecard.json
#             2. pack manifest v2 full-tree emission (buildPackSourcePlan)
#             3. the engine's pack build + trust assertions on that tree
#             4. the engine's conformance suites + the two vendored vector tables
#           They come back, rewritten against the 3.0 pack/card formats and the
#           3.0 server's own `pack` command, when Studio's authoring side moves
#           (a later step than the connection). The 2.x version of this script
#           is in git history (before the 3.0 connection step).
#
# Usage:  bash scripts/check_roundtrip.sh        (or: bun run roundtrip)
# Engine repo: $TRPG_KP_REPO, default ../trpg_kp (sibling checkout, branch v3).

set -euo pipefail

STUDIO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_REPO="${TRPG_KP_REPO:-$STUDIO_ROOT/../trpg_kp}"

say() { printf '\n==> %s\n' "$*"; }
fail() {
  printf 'roundtrip: FAIL: %s\n' "$*" >&2
  exit 1
}

[ -d "$ENGINE_REPO" ] || fail "engine repo not found at $ENGINE_REPO (clone https://github.com/1A7432/loreweaver.git, branch v3, or set TRPG_KP_REPO)"
ENGINE_REPO="$(cd "$ENGINE_REPO" && pwd)"

say "stages 1-4 (lorecard, pack tree, pack build, conformance): PARKED until Studio's authoring side moves to 3.0"

say "live connect: a real 3.0 server through the real link"
if [ "${LIVE_CONNECT:-1}" = "0" ]; then
  echo "skipped (LIVE_CONNECT=0)"
else
  TRPG_KP_REPO="$ENGINE_REPO" bash "$STUDIO_ROOT/scripts/check_live_connect.sh"
fi

say "round-trip gate: PASS (live stage only; four stages parked)"
