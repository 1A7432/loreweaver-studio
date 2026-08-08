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
   lorecard **format v1** (the frozen M16 shape) and nothing else; the engine's v0
   refusal no longer bites because the studio never writes v0 (it still READS its
   own historical v0 exports).
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

## Still open

9. **Keeper-style prompt presets as pack assets** — HALF landed and unchanged by the
   consolidation: `core/preset.py` parser + `core/preset_store.py` + the keeper
   `.preset` surface + the bounded v0 style-fold in `agent/prompt_builder.py:360-383`
   all exist. Still missing: a `contents.presets` pack-asset convention (install →
   `data_dir/presets/`, and `.preset import` understanding the pack-relative
   `packId/path` resolver from item 6 — it reads literal server paths only,
   `gateway/commands.py:984`), and the finer marker→section mapping contract
   (prompt_builder's own comment still calls the single-fold policy v0).

10. **A world card's PROSE has nowhere to go.** Still true post-M17/M18:
    `import_world_card` (`agent/kp_tools_charcard.py:288-418`) uses prose only for
    the persona check and the pregen-sheet build; `description` / `personality` /
    `scenario` / openings seed no document. Lorecard v1 made it no better —
    `opening` / `alternate_openings` map onto the same `CharacterCard` fields and
    `Lorecard.alternate_greetings` has no consumer outside tests. The ask stands:
    seed a module brief from the world card's prose at import (or document the
    constant-entry rule loudly in `docs/cards.md` + the card-forge templates).

11. **`.var` has no keeper-side write.** Still `list|expose|hide` only
    (`gateway/commands.py:1801-1859`); the validated primitives
    (`core/modvars.set_modvar`/`adjust_modvar`) exist and are called from agent-side
    code, only the command surface is missing. Narrowed by M15: `panel_intent`
    already routes panel input through the real command engine, so the ask is now
    exactly one keeper-gated `.var set <id> <value>` / `.var add <id> <delta>` (or a
    panel-writable var op) over `core.modvars` validation.

## New asks from the 2.x catch-up

12. **The M19 presentation schema never shipped the spec's template list + palette.**
    `docs/specs/M19-stage-director.md` promises the kit carries "allowed template
    list + palette", but `core/presentation.py` is strict — unknown keys are build
    errors — and defines only `version` / `generation` / `style.{keywords,banned}` /
    `subjects` / `audio`. The studio's kit wizard therefore has no 模板配色 UI (style
    keywords carry palette/medium today). Decide upstream: either extend the kit
    schema (versioned bump) or strike the promise from the spec; the studio ships
    whichever lands.

13. **Pack asset MIME is guessed by file EXTENSION, not sniffed.**
    `core/pack.py:981` uses `mimetypes.guess_type(path)`, so `_enforce_kit_assets`
    accepts only extensions the build machine's mimetypes db maps into
    `UI_IMAGE_MIMES`/`AUDIO_MIMES` — on a stock python, `.wav` → `audio/x-wav`,
    `.flac` → `audio/x-flac`, `.m4a`/` `.aac`similarly miss`AUDIO_MIMES`, and the
result is platform-dependent. The studio's wizard now steers authors to mp3/ogg
only. Ask: sniff magic bytes (or normalize the `x-`variants) so the documented
audio list in`docs/protocol.md` is actually buildable, and pin it with a
    per-extension pack-build test.
