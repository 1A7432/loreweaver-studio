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

## Still open

9. **Keeper-style prompt presets as pack assets** — **LANDED upstream `fbcd08c`**
   (`contents.presets`, install → `data_dir/presets/`, disclosed on the trust card).
   Studio-side consumption is outstanding: the preset manager can export a preset into
   a pack's source tree. Original ask, kept for context — HALF landed and unchanged by the
   consolidation: `core/preset.py` parser + `core/preset_store.py` + the keeper
   `.preset` surface + the bounded v0 style-fold in `agent/prompt_builder.py:360-383`
   all exist. Still missing: a `contents.presets` pack-asset convention (install →
   `data_dir/presets/`, and `.preset import` understanding the pack-relative
   `packId/path` resolver from item 6 — it reads literal server paths only,
   `gateway/commands.py:984`), and the finer marker→section mapping contract
   (prompt_builder's own comment still calls the single-fold policy v0).

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

11. **`.var` has no keeper-side write.** **LANDED upstream `96c7228`** — keeper-gated
    `.var set` / `.var add`, over `core.modvars` validation.
    Studio-side consumption (a keeper write control on the state panel) is outstanding.
    Original ask below. Still `list|expose|hide` only
    (`gateway/commands.py:1801-1859`); the validated primitives
    (`core/modvars.set_modvar`/`adjust_modvar`) exist and are called from agent-side
    code, only the command surface is missing. Narrowed by M15: `panel_intent`
    already routes panel input through the real command engine, so the ask is now
    exactly one keeper-gated `.var set <id> <value>` / `.var add <id> <delta>` (or a
    panel-writable var op) over `core.modvars` validation.

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
