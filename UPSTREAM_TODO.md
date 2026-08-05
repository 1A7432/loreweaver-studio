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

8.5. ✅ **Native bundles as first-class pack cards** — landed ENGINE-side in-session
(2026-08-06, user-directed): `core/pack.py::_validate_card_bytes` dispatches
`looks_like_lorecard` → `parse_lorecard_bytes`, so `cards/*.lorecard.json` gets honest
machinery detection (hooks / `secret` lore / declaration entries) and the same
`kind: world` enforcement + trust counts as ST cards. Studio consumed it the same day
(pack bench classifies native bundles; forge imports them). Remaining nuance, noted
deliberately: `detect_world_payloads` does NOT count typed `variables` — a bundle whose
ONLY machinery is typed specs still passes as `character` (both sides mirror this;
player import strips specs anyway, so nothing leaks — but trust's `world_cards` can
undercount that edge). Decide upstream whether typed specs alone should force world.

9. **Keeper-style prompt presets as pack assets** — HALF landed: the engine now has the
   authoritative preset parser (`core/preset.py`, matrix/marker/macro semantics matching
   `src/features/studio/ai/stPreset.ts`), disk store (`data_dir/presets/`), the keeper
   `.preset list|import|enable|disable|show` surface, and a bounded style-layer fold in
   the prompt builder (markers are boundaries-only in v0; sampling params are reported,
   not applied). Still needed before a client can advertise "preset-aware" play:
   a pack-asset convention (path + manifest flag) so a pack can SHIP a preset through
   `--install`, and the finer marker→section mapping contract if v0's single-fold
   proves too coarse in play.

10. **A world card's PROSE has nowhere to go.** `.import <card> world`
    (`agent/kp_tools_charcard.py::import_world_card`) consumes the worldbook, the
    typed specs, the hooks and the persona-derived pregen sheet — and drops
    `description` / `personality` / `scenario` / `first_mes` / `alternate_greetings`
    on the floor. For a MODULE card those four fields are the pitch, the keeper's
    voice, the opening situation and the alternate openings; authors are forced to
    duplicate all of it into `constant: true` worldbook entries (found the hard way:
    without that duplication the KP told players "模组文档还没有上传到这场游戏里").
    Ask: seed a module brief from the world card's prose at import (or document the
    rule loudly in `docs/cards.md` + the card-forge templates).

11. **`.var` has no keeper-side write.** The surface is `list|expose|hide`, so a
    keeper cannot move a module variable without asking the KP to call its tool.
    That makes module-shipped keeper UI (M15 `audience: keeper` panels) unable to
    offer deterministic state controls — panel `choices` have to send prose the
    model may or may not honor. Ask: a keeper-gated `.var set <id> <value>` /
    `.var add <id> <delta>` going through the same `core.modvars` validation the
    tool path uses.
