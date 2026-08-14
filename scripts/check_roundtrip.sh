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
#      (studio_export + lorecard + visible_when golden vectors)
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
# One world lorecard (hooks + typed specs + secret entry) + one clean ST
# character card; one skill with hooks; one CoC7 patch; one lorebook; two
# panels; one kit subject licensing imagegen; seven assets (cover, 2 panel
# images, tier-2 entry+js, kit ref, kit cue).
expected = {
    "skills": 1,
    "rulepacks": 1,
    "cards": 2,
    "lorebooks": 1,
    "assets": 7,
    "has_hooks": True,
    "has_ejs": False,
    "has_rules_script": False,
    "world_cards": 1,
    "panels": 2,
    "presentation": 1,
    "imagegen": True,
}
drift = {key: {"expected": want, "got": trust.get(key)} for key, want in expected.items() if trust.get(key) != want}
if drift:
    print(f"trust drifted: {json.dumps(drift, ensure_ascii=False)}", file=sys.stderr)
    sys.exit(1)
print(f"ok: {result['id']}@{result['version']} sha256={result['sha256']}")
print(f"    trust={json.dumps(trust, sort_keys=True)}")
PY
)

say "4/5 engine conformance suites (fixtures + lorecard + visible_when vectors)"
(
  cd "$ENGINE_REPO"
  uv run pytest tests/core/test_studio_export_fixture.py tests/core/test_lorecard.py tests/core/test_visible_when_vectors.py -q
)

say "5/5 live connect: a real --serve engine through the real transport"
if [ "${LIVE_CONNECT:-1}" = "0" ]; then
  echo "skipped (LIVE_CONNECT=0)"
else
  TRPG_KP_REPO="$ENGINE_REPO" bash "$STUDIO_ROOT/scripts/check_live_connect.sh"
fi

say "round-trip gate: PASS"
