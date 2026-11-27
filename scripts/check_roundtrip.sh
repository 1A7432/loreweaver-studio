#!/usr/bin/env bash
# Cross-repo round-trip gate (studio ↔ engine), against the REAL protocol 3.0 engine (the
# engine repository's `v3` branch: a Bun server). Every stage runs the engine's own code on
# what Studio's own code wrote; a mismatch anywhere fails the gate.
#
#   a. generate   the app's REAL `buildPackSourcePlan` lays out a pack source tree that
#                 exercises every kind Studio writes: cards of both kinds (a native
#                 lorecard, SillyTavern JSON, a PNG-embedded card), a rule-pack patch, a
#                 skill, a module, panels (a `repeat`, a `visible_when`, a picture, a module
#                 view, a choice running a module command, and a page with a fallback), a
#                 presentation kit with a picture and a sound (scripts/gen_roundtrip_pack.ts);
#   b. build      the engine's builder (`pack <dir> --out <file>`): `ok`, the trust card's
#                 code flag and module, its card kinds equal to Studio's own detection, its
#                 rule systems, skills, panels and kit, and nothing in `ignored`;
#   c. install    the engine's installer (`install <file> --yes`) into a temporary data
#                 directory, then `packs`: installed, nothing shadowed, exactly that pack
#                 listed;
#   d. cards      every card shape the forge exports (scripts/gen_studio_export_fixture.ts)
#                 parsed by the engine's own card reader and splitter: its kind and entry
#                 counts equal what Studio's reader says, and no hook script or pregen;
#   e. panels     the generated panels read by the engine's panels reader and wire step and
#                 evaluated with the shared `panelBlocks` over sample view values, compared
#                 with Studio's checks and live preview for the same values;
#   f. live       a REAL 3.0 server (`serve --local`) dialled through the REAL Rust link
#                 (scripts/check_live_connect.sh). LIVE_CONNECT=0 skips it on a machine
#                 without cargo.
#
# The engine always runs from a temporary working directory (Bun loads `.env` from the
# working directory, and the engine checkout's `.env` must not be read) with every `TRPG_*`
# variable of the caller's shell removed. Temporary directories are removed on every exit.
#
# Usage:  bash scripts/check_roundtrip.sh        (or: bun run roundtrip)
# Engine repo: $TRPG_KP_REPO, default ../trpg_kp (sibling checkout, branch v3, with
# `bun install` run at its root).

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
ENTRY="$ENGINE_REPO/server/src/cli/main.ts"
[ -f "$ENTRY" ] || fail "$ENGINE_REPO has no protocol 3.0 engine ($ENTRY missing) — check out the engine's v3 branch"
[ -d "$ENGINE_REPO/node_modules" ] || fail "the engine's dependencies are not installed — run 'bun install' in $ENGINE_REPO"
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lw-roundtrip.XXXXXX")"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$WORK/cwd" "$WORK/data" "$WORK/src" "$WORK/cards"

# One engine command, sandboxed: temporary cwd, no TRPG_* of the caller, TRPG_DATA_DIR set.
# stdout and stderr land in "$WORK/$1.out" / "$WORK/$1.err"; the exit code is returned.
engine() {
  local name="$1"
  shift
  (
    cd "$WORK/cwd"
    for variable in $(env | sed -n 's/^\(TRPG_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$variable"; done
    TRPG_DATA_DIR="$WORK/data" exec bun "$ENTRY" "$@"
  ) >"$WORK/$name.out" 2>"$WORK/$name.err"
}

# A failed command: both streams (its JSON object goes to stderr on a refusal).
show_failure() {
  printf -- '--- stdout ---\n%s\n--- stderr ---\n%s\n' "$(cat "$WORK/$1.out")" "$(cat "$WORK/$1.err")" >&2
}

say "a. generate the pack source tree with the app's real buildPackSourcePlan"
(cd "$STUDIO_ROOT" && bun scripts/gen_roundtrip_pack.ts "$WORK/src")
PACK_DIR="$WORK/src/corridor-apartment"
[ -f "$PACK_DIR/pack.yaml" ] || fail "no pack.yaml was written"
grep -q '^manifest_version: 3$' "$PACK_DIR/pack.yaml" || fail "pack.yaml is not manifest 3"

say "b. build it with the engine's builder"
if ! engine build pack "$PACK_DIR" --out "$WORK/pack.lwpack"; then
  show_failure build
  fail "the engine's builder refused the pack"
fi
cp "$WORK/build.out" "$WORK/build.json"
(cd "$STUDIO_ROOT" && bun scripts/roundtrip_check.ts build "$WORK/build.json" "$WORK/src/expect.json")
[ -s "$WORK/pack.lwpack" ] || fail "the builder reported success but wrote no archive"

say "c. install it with the engine's installer into a temporary data directory"
if ! engine install install "$WORK/pack.lwpack" --yes; then
  show_failure install
  fail "the engine's installer refused the pack"
fi
if ! engine packs packs; then
  show_failure packs
  fail "the engine could not list the installed packs"
fi
(cd "$STUDIO_ROOT" && bun scripts/roundtrip_check.ts install "$WORK/install.out" "$WORK/packs.out" "$WORK/src/expect.json")
[ -f "$WORK/data/packs/corridor-apartment/1.0.0/pack.yaml" ] || fail "the installed pack is not where the engine says it installs"
[ -f "$WORK/data/packs/corridor-apartment/1.0.0/modules/corridor.js" ] || fail "the installed pack carries no bundled module"
[ ! -e "$WORK/data/packs/corridor-apartment/1.0.0/src" ] || fail "the module's source tree was installed"

say "d. parse every card Studio exports with the engine's card reader"
(cd "$STUDIO_ROOT" && bun scripts/gen_studio_export_fixture.ts "$WORK/cards")
(cd "$STUDIO_ROOT" && bun scripts/roundtrip_check.ts cards "$ENGINE_REPO" "$WORK/cards")

say "e. evaluate the panels with the engine's reader and the shared panelBlocks, against Studio's preview"
(cd "$STUDIO_ROOT" && bun scripts/roundtrip_check.ts panels "$ENGINE_REPO" "$PACK_DIR")

say "f. live connect: a real 3.0 server through the real link"
if [ "${LIVE_CONNECT:-1}" = "0" ]; then
  echo "skipped (LIVE_CONNECT=0)"
else
  TRPG_KP_REPO="$ENGINE_REPO" bash "$STUDIO_ROOT/scripts/check_live_connect.sh"
fi

say "round-trip gate: PASS"
