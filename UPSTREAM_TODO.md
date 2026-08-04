# Upstream asks from the studio's split-era forge

Sibling of [PROTOCOL_NOTES.md](PROTOCOL_NOTES.md) (which stays wire-protocol-only): every
engine/tooling interface the card-split + AI-forge + auto-pack work wanted but did not
find. Studio-side we did NOT work around any of these with hacks — the features ship
without them and get better when they land.

1. **Machine-readable `--pack` / `--install` output.** The pack wizard shells out to
   `loreweaver-server --pack <dir> --out <file>` (or `python -m app …`) and today can
   only show raw stdout/stderr. A `--json` flag emitting the built pack's path, id,
   version, sha256 and trust block on success (an error object on failure) would let
   the wizard render the trust card natively (counts, hooks/EJS flags, world_cards)
   instead of as terminal text.

2. **A stable `--version` for probing.** `probe_engine_cli` currently only checks that a
   `loreweaver-server` binary exists on PATH / that `app.py` exists in the configured
   checkout. A cheap, side-effect-free `--version` (semver on stdout) would let the
   studio display the engine version and pre-check pack `engine.server` minimums before
   a build instead of after.

3. **`ModuleVariable.hidden` missing from `loreweaver-protocol` types.** The server
   already sends `hidden:true` to keeper connections for unexposed variables (v1.7
   additive), and the studio now renders those rows dimmed + locked — but through a
   local cast, because `clients/protocol/src/types.ts` hasn't added the optional field.
   One-line type addition (`hidden?: boolean`) + a changelog note.

4. **M14 native-bundle importer.** The forge and the splitter both export
   `*.lorecard.json` (`format: "loreweaver.card", format_version: 0` — shape documented
   in [docs/FORMATS.md](docs/FORMATS.md)); typed VarSpecs and secret/keeper-only fields
   survive only in that flavor. Until the engine can import it, round-tripping goes
   through the lossy ST shape ([InitVar] + player-visible only).

5. **Pregen roster visibility on the wire.** After a world import lands the claimable
   cast (`core.pregen_roster`), a client has no frame to render the roster (`.pc list`
   is chat-only). A `state`-adjacent frame (or a documented `ui` convention) listing
   `{name, claimed_by}` would let the studio's play mode show "claimable characters"
   right after the pack-wizard's `--install` closes the loop.

6. **`.import` accepting a pack-relative card path.** Installed packs land cards under
   `data_dir/packs/<id>@<version>/`; the keeper still types the full server-side path to
   world-import one. A `.import pack:<id>/<card>` shorthand would make the
   "install → world import → claim" demo one obvious step shorter.

7. **M15 bridge doc says `StateVariable`; the package type is `ModuleVariable`.** The
   Tier-2 bridge signature in `docs/specs/M15-ui-panels.md` (and the studio snapshot)
   types `onState` as `(s: {variables: StateVariable[], …})`, but no such export exists
   in `loreweaver-protocol` — the state-frame variable list is `ModuleVariable[]`, and
   that is what the studio's bridge forwards. One-word spec amendment keeps the next
   panel author from hunting for a phantom type.

8. **Keeper-style prompt presets as pack assets.** The studio now imports SillyTavern
   completion presets as local assets (prompt pool + two-layer enable matrix + sampling
   - inert `extensions`, zero-loss) and can export the normalized JSON for distribution
     inside a pack. The engine's single-prompt architecture (6 sections) is the iron rule,
     so the studio deliberately makes NO injection promises for play: whether/how a shipped
     preset maps into those sections (and which ST macros, if any, get expanded) is an
     engine-side decision. Needed from upstream: a documented pack-asset convention (path +
     manifest flag) and a section-mapping contract before any client can advertise
     "preset-aware" play.
