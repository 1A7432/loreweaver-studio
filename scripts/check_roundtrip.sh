#!/usr/bin/env bash
# Cross-repo round-trip gate (studio ↔ engine), the automated half of the
# cross-repo contract:
#
#   1. lorecard v1 byte drift — the REAL `exportNativeBundle` output must stay
#      byte-identical to the engine's pinned tests/fixtures/studio_export.lorecard.json
#   2. pack manifest v2 full-tree build — the REAL `buildPackSourcePlan` tree
#      must build clean through the engine's REAL parsers, with the expected
#      detection results (world card, hooks, presentation kit) in `trust`
#   3. the engine's own conformance suites for the pinned fixtures
#      (studio_export + lorecard + visible_when + panel template golden vectors),
#      and the two vendored vector tables are byte-identical to the engine's
# Prerequisite: the engine's optional `ejs` extra (`uv sync --extra ejs`) — the
# fixture ships a stage-E rules-script rulepack, which compiles through QuickJS
# at pack-build time.
#
#   4. the live-connect smoke gate — a REAL `--serve` engine dialed through the
#      REAL Rust transport (scripts/check_live_connect.sh). The formats above
#      are all static; this is the only stage that proves the two processes can
#      still talk. Set LIVE_CONNECT=0 to skip it on a machine without cargo.
#
# Usage:  bash scripts/check_roundtrip.sh        (or: bun run roundtrip)
# Engine repo: $TRPG_KP_REPO, default ../trpg_kp (sibling checkout).

set -euo pipefail

STUDIO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_REPO="${TRPG_KP_REPO:-$STUDIO_ROOT/../trpg_kp}"
WORK="$STUDIO_ROOT/target/roundtrip"

say() { printf '\n==> %s\n' "$*"; }
fail() {
  printf 'roundtrip: FAIL: %s\n' "$*" >&2
  exit 1
}

[ -d "$ENGINE_REPO" ] || fail "engine repo not found at $ENGINE_REPO (clone https://github.com/1A7432/loreweaver.git or set TRPG_KP_REPO)"
ENGINE_REPO="$(cd "$ENGINE_REPO" && pwd)"
[ -f "$ENGINE_REPO/core/pack.py" ] || fail "$ENGINE_REPO does not look like the loreweaver engine repo (core/pack.py missing)"
command -v bun >/dev/null 2>&1 || fail "bun not found on PATH"
# The fixture ships a stage-E rules-script rulepack so `has_rules_script` is
# actually exercised, and that compiles through QuickJS at pack-BUILD time. The
# engine keeps quickjs behind its optional `ejs` extra, so the gate needs it —
# checked here, by name, rather than surfacing as a confusing PackError later.
(cd "$ENGINE_REPO" && uv run python -c "import sys; from core.ejs_full import quickjs_available; sys.exit(0 if quickjs_available() else 1)" >/dev/null 2>&1) \
  || fail "the engine's optional 'ejs' extra (quickjs) is not installed, and the fixture's rules-script rulepack needs it at build time — run 'uv sync --extra ejs' in $ENGINE_REPO"

rm -rf "$WORK"
mkdir -p "$WORK"

say "1/5 lorecard v1 fixture: regenerate and diff against the engine's pinned copy"
bun "$STUDIO_ROOT/scripts/gen_studio_export_fixture.ts" "$WORK/studio_export.lorecard.json"
FIXTURE="$ENGINE_REPO/tests/fixtures/studio_export.lorecard.json"
[ -f "$FIXTURE" ] || fail "engine fixture missing: $FIXTURE"
if ! cmp -s "$WORK/studio_export.lorecard.json" "$FIXTURE"; then
  diff -u "$FIXTURE" "$WORK/studio_export.lorecard.json" | head -60 || true
  fail "lorecard output drifted from the engine fixture — regenerate it with 'bun scripts/gen_studio_export_fixture.ts' (never hand-edit the engine copy)"
fi
echo "ok: byte-identical to tests/fixtures/studio_export.lorecard.json"

say "2/5 pack source tree: real buildPackSourcePlan emission"
bun "$STUDIO_ROOT/scripts/gen_roundtrip_pack.ts" "$WORK/pack"
TREE="$WORK/pack/corridor-apartment"

say "3/5 engine pack build: python -m app --pack --json + trust assertions"
RESULT="$WORK/pack-result.json"
(
  cd "$ENGINE_REPO"
  uv run python -m app --pack "$TREE" --out "$WORK/corridor-apartment.lwpack" --json >"$RESULT"
)
(
  cd "$ENGINE_REPO"
  uv run python - "$RESULT" <<'PY'
"""Assert the engine accepted the studio's tree AND detected it as expected —
an `ok: true` alone would miss a silent world→character kind drift."""
import json
import sys

result = json.loads(open(sys.argv[1], encoding="utf-8").read())
if not result.get("ok"):
    print(f"engine pack build failed: {result.get('error')}", file=sys.stderr)
    sys.exit(1)
trust = result.get("trust") or {}
# FOUR cards, covering every shape a pack can carry one in: the world lorecard
# (native), a clean ST character card, an ST-flavored WORLD card (hooks +
# [InitVar] + an EJS span, so engine-side world detection is exercised on the
# SillyTavern path too), and the same character embedded in a PNG — the shape a
# community editor hands around, which had never passed through the engine's
# own parser. Plus one skill with hooks; a CoC7 patch and a stage-E
# rules-script rulepack; one lorebook; two panels; one kit
# subject licensing imagegen; seven assets; one prep-phase plan script; one
# keeper-style prompt preset (validated with the engine's real preset parser).
expected = {
    "skills": 1,
    "rulepacks": 2,
    "cards": 4,
    "lorebooks": 1,
    "assets": 7,
    "has_hooks": True,
    "has_ejs": True,
    "has_rules_script": True,
    "world_cards": 2,
    "panels": 2,
    "presentation": 1,
    "imagegen": True,
    "prep_scripts": 1,
    "presets": 1,
}
drift = {key: {"expected": want, "got": trust.get(key)} for key, want in expected.items() if trust.get(key) != want}
if drift:
    print(f"trust drifted: {json.dumps(drift, ensure_ascii=False)}", file=sys.stderr)
    sys.exit(1)
print(f"ok: {result['id']}@{result['version']} sha256={result['sha256']}")
print(f"    trust={json.dumps(trust, sort_keys=True)}")
PY
)

say "4/5 engine conformance suites (fixtures + lorecard + visible_when + panel template vectors)"
(
  cd "$ENGINE_REPO"
  uv run pytest tests/core/test_studio_export_fixture.py tests/core/test_lorecard.py tests/core/test_visible_when_vectors.py tests/core/test_panel_template_vectors.py -q
)
# The two vector tables this repo vendors must be the engine's BYTES — a refresh that was
# forgotten is exactly the drift the tables exist to catch.
for table in visible_when_vectors.json panel_template_vectors.json; do
  if ! cmp -s "$ENGINE_REPO/tests/fixtures/$table" "$STUDIO_ROOT/src/features/play/panels/fixtures/$table"; then
    echo "vendored $table differs from the engine's copy — refresh it: cp $ENGINE_REPO/tests/fixtures/$table src/features/play/panels/fixtures/" >&2
    exit 1
  fi
done

say "5/5 live connect: a real --serve engine through the real transport"
if [ "${LIVE_CONNECT:-1}" = "0" ]; then
  echo "skipped (LIVE_CONNECT=0)"
else
  TRPG_KP_REPO="$ENGINE_REPO" bash "$STUDIO_ROOT/scripts/check_live_connect.sh"
fi

say "round-trip gate: PASS"
