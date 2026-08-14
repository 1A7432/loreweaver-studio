# Upstream asks from the studio's split-era forge

Sibling of [PROTOCOL_NOTES.md](PROTOCOL_NOTES.md) (which stays wire-protocol-only): every
engine/tooling interface the card-split + AI-forge + auto-pack work wanted but did not
find. Studio-side we did NOT work around any of these with hacks — the features ship
without them and get better when they land.

**2026-08-08 re-audit against the landed M14–M19 line** (engine specs
`docs/specs/M16`–`M19`; audit evidence in git history): items 1–8.5 are fully settled
— landed upstream AND consumed here during the studio's 2.x catch-up (protocol
2.1.0, lorecard v1 exporter, pack manifest v2, panels 2.1, presentation kit,
round-trip gate). They are closed out below in one block. Items 9–11 remain open,
refreshed with post-consolidation evidence. Two NEW asks (12, 13) came out of the
catch-up itself.

## Settled (kept for the record; no action left on either side)

1. **Machine-readable `--pack --json`** — consumed: the pack wizard builds through
   `python -m app --pack --json` and renders the trust card natively from the JSON
   trust object (phase ③).
2. **`--version` probe** — landed upstream. The studio's `probe_engine_cli` does not
   call it yet (candidate display could); that is a studio-side nicety, not an
   upstream ask.
3. **`ModuleVariable.hidden?: boolean`** — typed since 1.9.0, still typed at 2.1.0;
   the local casts are gone (`StatePanel.tsx` reads it directly; the templates
   filter uses the typed field).
4. **M14 native-bundle importer** — consumed, and now load-bearing: the studio emits
   lorecard **format v1** (the frozen M16 shape) and nothing else, and as of the
   2026-08-08 audit no longer READS v0 either — one format, the same one the
   engine parses.
5. **Pregen roster on the wire** — `state.pregens` rides the tier-2 bridge
   (`PanelStateSnapshot.pregens`); the forge authors the cast as lorecard v1
   `pregens[]`. Rendering a claim UI in play mode remains a studio-side idea, not an
   upstream ask.
6. **Pack-relative `.import`** — engine-side; nothing for the studio to consume.
7. **`StateVariable` phantom type** — `ModuleVariable` everywhere.
   8.5. **Native bundles as first-class pack cards — including the residual nuance**:
   upstream DECIDED typed `variables` specs alone force `kind: world`
   (`core/pack.py:644-652`, `docs/plugins.md:580`, commit `7036df6`); the studio
   mirrors it (`countVariableSpecs` folds spec counts into pack-bench detection).

> **2026-08-15 — items 9–12 all landed upstream, mid-overhaul.** The engine lane
> shipped `96c7228` (`.var set/add`), `fbcd08c` (`contents.presets`), `fd6613a`
> (presentation kit **v2**) and `884fe51` (world-card prose → keeper module brief)
> while the studio overhaul (`docs/OVERHAUL-2026-08.md`) was in flight. Item 12 is
> **consumed** here already — kit v2 is a hard break (`KIT_VERSION = 2`, v1 files
> rejected outright), so the studio emits v2 and gained the promised template/palette
> UI in the same commit; the round-trip gate exercises both. Items 9–11 are landed but
> not yet consumed studio-side; each notes what remains here.

## Closed on both sides (kept for the record)

9. ~~**Keeper-style prompt presets as pack assets**~~ — **LANDED upstream `fbcd08c`
   and CONSUMED here (2026-08-15).** `contents.presets` rides the pack source model,
   the manifest and the tree; the pack bench ships a preset straight from the studio's
   own library (`presetToStJson` reassembles the imported document losslessly, sampling
   knobs included, preview overrides excluded); validation mirrors the engine's
   structural refusals plus the sanitized-id collision that would otherwise overwrite
   silently in the shared store; the round-trip fixture builds one through the engine's
   real preset parser. Original ask, kept for context — HALF landed and unchanged by the
   consolidation: `core/preset.py` parser + `core/preset_store.py` + the keeper
   `.preset` surface + the bounded v0 style-fold in `agent/prompt_builder.py:360-383`
   all exist. Still missing: a `contents.presets` pack-asset convention (install →
   `data_dir/presets/`, and `.preset import` understanding the pack-relative
   `packId/path` resolver from item 6 — **that half landed too**: `cmd_preset`
   (`gateway/commands.py:1178`) now resolves a pack-relative ref through
   `resolve_installed_path` before falling back to a literal server path
   (`:1212–1215`). What remains open is only the finer marker→section mapping
   contract — prompt_builder's own comment still calls the single-fold policy v0.

10. **A world card's PROSE has nowhere to go.** **LANDED upstream `884fe51`** — the
    prose now seeds a keeper-only module brief at import. Studio-side: nothing is
    required, but the forge could stop warning authors that world-card prose is inert.
    Original ask below. Still true post-M17/M18:
    `import_world_card` (`agent/kp_tools_charcard.py:288-418`) uses prose only for
    the persona check and the pregen-sheet build; `description` / `personality` /
    `scenario` / openings seed no document. Lorecard v1 made it no better —
    `opening` / `alternate_openings` map onto the same `CharacterCard` fields and
    `Lorecard.alternate_greetings` has no consumer outside tests. The ask stands:
    seed a module brief from the world card's prose at import (or document the
    constant-entry rule loudly in `docs/cards.md` + the card-forge templates).

11. ~~**`.var` has no keeper-side write.**~~ **LANDED upstream `96c7228` and CONSUMED
    here (2026-08-15).** Keeper-gated `.var set` / `.var add`, over `core.modvars`
    validation. The studio's state panel gained the write control (off by default,
    routed through the ordinary command path so the permission gate, the spec
    validation and the state push are the engine's own).
    Original ask below. It read `list|expose|hide` only when this was written
    (`cmd_var` is at `gateway/commands.py:2033-2128` today, and its docstring
    now names set/add); the validated primitives
    (`core/modvars.set_modvar`/`adjust_modvar`) exist and are called from agent-side
    code, only the command surface is missing. Narrowed by M15: `panel_intent`
    already routes panel input through the real command engine, so the ask is now
    exactly one keeper-gated `.var set <id> <value>` / `.var add <id> <delta>` (or a
    panel-writable var op) over `core.modvars` validation.

### The one half still genuinely open

Item 9's finer marker→section mapping contract: `prompt_builder`'s own comment
still calls the single-fold policy v0. Nothing studio-side is blocked on it —
the studio ships the preset document; how the engine folds it is the engine's.

## New asks from the 2.x catch-up

12. ~~**The M19 presentation schema never shipped the spec's template list + palette.**~~
    **RESOLVED upstream `fd6613a`, consumed here the same day.** The engine extended the
    kit schema rather than striking the promise, and took the clean break: kit version
    2, a `templates` allowlist (empty = every shape), `style.palette` (≤8 entries, ≤80
    chars), and v1 files are rejected — no dual-schema reader. The studio emits v2 only,
    the kit wizard gained the 模板/配色 UI, `validatePackDraft` mirrors the new caps, and
    `gen_roundtrip_pack.ts` exercises both fields through the engine's real parser. The
    original ask, for the record:
    `docs/specs/M19-stage-director.md` promises the kit carries "allowed template
    list + palette", but `core/presentation.py` is strict — unknown keys are build
    errors — and defines only `version` / `generation` / `style.{keywords,banned}` /
    `subjects` / `audio`. The studio's kit wizard therefore has no 模板配色 UI (style
    keywords carry palette/medium today). Decide upstream: either extend the kit
    schema (versioned bump) or strike the promise from the spec; the studio ships
    whichever lands.

13. ~~**Pack asset MIME was guessed by the build machine's mimetypes db.**~~ **FIXED
    upstream, same day.** `core/pack.py` had used `mimetypes.guess_type`, which on a
    stock python returns `audio/x-wav` / `audio/x-flac` / `audio/mp4a-latm` /
    `audio/x-aac` — none in `AUDIO_MIMES` — so four of the six documented audio
    formats were unbuildable and the result depended on where you built. The engine
    now owns an extension→MIME table (`_ASSET_MIME_BY_SUFFIX`), pinned per extension
    by `tests/core/test_pack_asset_mime.py`. The wizard's audio hint is back to the
    full documented list.

## Engine-side landings, 2026-08-15 (the parallel lane §9 of docs/OVERHAUL-2026-08.md)

Every open item above closed upstream today, plus the promised author-DX work. What
the studio must react to (R) or may now surface (S):

- **Item 9 CLOSED** — `contents.presets` is a real pack kind: ST completion-preset
  `.json`, validated at build with the engine's preset parser, installed into the
  shared `data_dir/presets/` store (sanitized filename stem; id collisions fail the
  build). `.preset import` also resolves pack-relative refs now. (R: pack bench may
  offer a presets section; trust mirror below.) **Second half also CLOSED same day**:
  the fold honors preset geometry via a four-band split (`core.preset.style_bands`) —
  text before any marker → the stable style layer; `worldInfoBefore/After` text
  brackets the world-lore section; post-`chatHistory` text lands late in the per-turn
  state message (faithful post-history, owner-decided; the other five ST anchors only
  advance the split — no fake 8-way mapping). Marker-less presets fold exactly as
  before. (S: the preset manager could preview which band each block lands in.)
- **Item 10 CLOSED** — `.import … world` seeds a keeper-only `module_brief` document
  from the card's prose (description/scenario/openings…), read back via the new
  keeper-only `module_brief` tool. No studio action.
- **Item 11 CLOSED** — `.var set <id> <value>` / `.var add <id> <delta>` exist,
  keeper-gated, over `core.modvars` validation, with a state push on change. (S: a
  keeper panel could offer tracker writes through the command path.)
- **Item 12 CLOSED — BREAKING** — presentation kit **schema v2** (owner: no
  backcompat; v1 files are REJECTED). New: `templates:` allowlist over
  `image/title_card/letter/clipping/text` (intersection across packs) and
  `style.palette:` (≤8 strings ≤80 chars, union across packs, rides every imagegen
  prompt). (R: bump `buildPresentationYaml`/`validatePresentationDraft` and the
  round-trip fixture to `version: 2`; S: the kit wizard's 模板配色 UI is now real —
  mirror `core/presentation.py`.)
- **Trust card grew two fields** — `presets: int` and `prep_scripts: int` (R: extend
  the `PackTrust` mirror in `buildResult.ts` and the trust display; both also ride
  `--pack --json`).
- **Prep scripts are shippable + documented** — `contents.prep` (`.js`, ≤20 000
  chars, statically checked at build), invoked by reference via
  `run_prep_plan(script_ref="<packId>/prep/x.js")` with free preview; author docs at
  `docs/plugins.md` §C.3. (S: unblocks the OVERHAUL Batch 3.2 editor — the feature
  flag can turn on.)
- **Dev rooms LANDED** — keeper `.dev mount <src-dir>` live-reloads a pack source
  tree into a room (lore replaces by provenance, values survive, skills/rulepacks/
  panels reload; watcher polls saves). Confined under `TRPG_DEV__SOURCE_ROOT`, off
  unless set. (S: the OVERHAUL §3a "mount source dir" mode is now real — host-local
  can set the env var when spawning and `.dev mount` instead of install+import;
  `docs/authoring.md` §8 has the flow.)
- **Worldbook provenance** — `import_entries` now stamps each lore document's
  `meta.source`; a re-import surface can replace exactly what a file wrote last
  time. `{{random}}/{{pick}}` turn-seeding is documented for authors
  (`docs/cards.md`).
