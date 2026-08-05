# Upstream asks from the studio's split-era forge

Sibling of [PROTOCOL_NOTES.md](PROTOCOL_NOTES.md) (which stays wire-protocol-only): every
engine/tooling interface the card-split + AI-forge + auto-pack work wanted but did not
find. Studio-side we did NOT work around any of these with hacks — the features ship
without them and get better when they land.

**2026-08-05 status: items 1–7 have LANDED upstream** (engine commits `b72def7`,
`67be7b6`, `761d0c7`). The shapes below are what actually shipped — wire the studio to
them and delete each entry as it's consumed. Item 8 remains the one open ask.

1. ✅ **Machine-readable `--pack` output** — `--pack <dir> [--out <file>] --json` emits
   exactly ONE JSON object on stdout: `{"ok": true, "path", "id", "version", "sha256",
"trust": {...}}` on success, `{"ok": false, "error"}` on failure (exit 1). Human
   lines (including the trust card) stay on stderr. The pack wizard can render the
   trust card natively now.

2. ✅ **`--version` probe** — `loreweaver-server --version` / `python -m app --version`
   prints a bare semver on stdout, no side effects, no locale variance.
   (`probe_engine_cli` should start consuming it.)

3. ✅ **`ModuleVariable.hidden?: boolean`** — typed in `loreweaver-protocol` 1.9.0
   (servers have sent it to keeper connections since v1.7). Drop the local cast in the
   variables panel. npm publish of 1.9.0 pending (maintainer's interactive 2FA).

4. ✅ **M14 native-bundle importer** — the engine parses `*.lorecard.json`
   (`core/lorecard.py`) through the same `.import` command: player imports strip
   machinery structurally (typed specs, secret lore — the split now also counts
   `secret_entries`), keeper `world` imports land typed specs as real `core.modvars`
   trackers (CJK ids like `理智` are now first-class engine-side). Round-tripping is
   no longer forced through the lossy ST shape.

5. ✅ **Pregen roster on the wire** — `state.pregens?: [{name, claimed_by}]` (protocol
   v1.9, omitted when no roster exists, public to every viewer). The play mode can
   render "claimable characters" right after `--install` + world import.

6. ✅ **Pack-relative `.import`** — the shipped syntax is `.import <packId>/<relative
path>` (no `pack:` prefix): resolves against the newest installed
   `data_dir/packs/<id>@<version>/`, traversal-confined, falling through to the
   literal path when not pack-shaped.

7. ✅ **`StateVariable` phantom type** — the canonical spec already reads
   `ModuleVariable`; refresh the studio's M15 snapshot from canonical if it still
   shows the old name.

8. **Keeper-style prompt presets as pack assets** — HALF landed: the engine now has the
   authoritative preset parser (`core/preset.py`, matrix/marker/macro semantics matching
   `src/features/studio/ai/stPreset.ts`), disk store (`data_dir/presets/`), the keeper
   `.preset list|import|enable|disable|show` surface, and a bounded style-layer fold in
   the prompt builder (markers are boundaries-only in v0; sampling params are reported,
   not applied). Still needed before a client can advertise "preset-aware" play:
   a pack-asset convention (path + manifest flag) so a pack can SHIP a preset through
   `--install`, and the finer marker→section mapping contract if v0's single-fold
   proves too coarse in play.
