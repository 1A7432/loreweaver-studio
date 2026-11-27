# Formats Studio writes

Studio keeps **no copy of a format specification**. The formats are the engine's, specified in
its LWF documents (CC BY 4.0) on the `v3` branch:

- [pack.md](https://github.com/1A7432/loreweaver/blob/v3/docs/lwf/formats/pack.md) — the
  `.lwpack` container, manifest 3, every content kind, the trust card;
- [panels.md](https://github.com/1A7432/loreweaver/blob/v3/docs/lwf/formats/panels.md) — panels
  3.0;
- [cards.md](https://github.com/1A7432/loreweaver/blob/v3/docs/lwf/formats/cards.md) — the native
  lorecard and SillyTavern cards (where it and the engine's code disagree, the code wins);
- the module SDK guide: [sdk/README.md](https://github.com/1A7432/loreweaver/blob/v3/sdk/README.md).

What this page records is how Studio maps onto them — which file in this repository writes what —
and what it deliberately no longer writes. That Studio's output is accepted is not claimed here:
it is proven on every CI run by the round-trip gate (`scripts/check_roundtrip.sh`), which builds,
installs and reads Studio's output with the real engine.

## Cards (the forge)

| Export                        | Writer                                 | Notes                                                                                                                                                |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `*.lorecard.json` (format v1) | `exporters.ts` `exportNativeBundle`    | Typed variables, worldbook with `secret` and `condition`, entry `id`s.                                                                               |
| `*.st.json` (chara_card_v3)   | `exporters.ts` `exportSillyTavernCard` | Typed variables become an `[InitVar]` entry, a `condition` an `@@if` line. The safe flavor leaves secret entries out; the release flavor keeps them. |
| `*.png`                       | `pngCard.ts` `embedCardIntoPng`        | The ST card in `chara` (v2 shell) and `ccv3` text chunks.                                                                                            |

**No longer written:** a lorecard's `hooks` and `pregens` sections and an ST card's
`extensions.loreweaver_hooks`. A 3.0 engine counts a card's hook scripts (which makes it a world
card) and never runs them, and it imports no pregenerated cast. A bundle that still carries them
imports into the forge without them, with a warning.

A card's **kind** is detected the way the engine detects it (`split/cardSplit.ts`): variable
declarations, typed variables, secret entries, EJS templates or hook scripts make a world card.

## Packs (the pack bench)

`split/packSource.ts` `buildPackSourcePlan` writes a source tree for the engine's builder:

```
<id>/
├── pack.yaml               manifest_version: 3, engine: {protocol: "3.0"}
├── src/<module>.ts         one entry per module (declared under `modules:`)
├── cards/…                 each declared {path, kind, notes?}
├── skills/<id>/SKILL.md
├── rulepacks/<id>.yaml
├── assets/…                dropped pictures and sounds, and the kit's media
├── ui/panels.yaml          panels 3.0, plus pages (one HTML file each) and pictures under ui/
├── ui/presentation.yaml    the presentation kit (version 2)
└── CHANGELOG.md            serialized packs only; the builder never reads it
```

The builder (`loreweaver pack <dir> --out <file>`) bundles each module and writes the archive;
Studio contains no zip writer.

**No longer written:** `contents.lorebooks` (lore rides inside a world card), `contents.presets`,
`contents.prep`, a rule pack's rules script, `skills/<id>/hooks.js`, the 2.x generated `files` and
`trust` blocks. A stored 2.x draft is migrated on load (`store/pack.ts` `migratePackSession`).

## Panels

`pack/panelsModel.ts` reads and writes `ui/panels.yaml`; `pack/panelsCheck.ts` mirrors the
engine's reader (same problem codes and paths); `pack/panelsPreview.ts` turns a panel into what a
viewer's `panels` view lists and evaluates it with the protocol package's `panelBlocks` — the
evaluation play mode uses. Panels 1.x in a stored draft are converted where the mapping is
mechanical (`pack/panelsMigrate.ts`); the rest is flagged.
