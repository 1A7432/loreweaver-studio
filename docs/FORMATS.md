# Export formats

The studio's card forge exports two flavors per the main repo's M14 draft
("imported cards adapt to us; forged cards are born native and still play
everywhere"). Validation mirrors the engine (`core/modvars.py`,
`core/worldbook.py`): ids `^[a-z0-9_]{1,64}$`, ≤64 variables, enum ≤20 options
of ≤50 chars, labels ≤50 chars, text defaults ≤200 chars, conditions ≤500 chars.

## 1. Loreweaver native bundle — `*.lorecard.json`

Lossless authoring output. **Provisional** (`format_version: 0`): the upstream
native-bundle importer is the not-yet-started M14 milestone, so this shape is
our proposal — typed variable specs exactly as `core.modvars.build_spec` emits
them, worldbook entries exactly as `LoreEntry.from_dict` accepts them.

```jsonc
{
  "format": "loreweaver.card",
  "format_version": 0,
  "name": "…",
  "description": "…",
  "personality": "…",
  "scenario": "…",
  "first_mes": "…",
  "mes_example": "…",
  "creator_notes": "…",
  "tags": ["…"],
  "variables": [
    {
      "id": "suspicion",
      "kind": "number",
      "visibility": "player",
      "labels": { "en": "Suspicion", "zh": "怀疑度" },
      "default": 0,
      "minimum": 0,
      "maximum": 10,
    },
  ],
  "worldbook": [
    {
      "title": "…",
      "content": "…",
      "keys": ["…"],
      "category": "lore",
      "secret": false,
      "constant": false,
      "priority": 0,
      "enabled": true,
      "condition": "suspicion >= 5",
      "secondary_keys": [],
      "selective_logic": "and_any",
      "probability": 100,
      "case_sensitive": false,
      "match_whole_words": false,
      "scan_depth": 0,
      "position": "",
      "sticky": 0,
      "cooldown": 0,
      "delay": 0,
    },
  ],
  "extensions": { "loreweaver_hooks": ["…hooks.js source…"] },
}
```

Keeper-only variables and `secret` entries are kept — this file is the
round-trippable source of truth.

## 2. SillyTavern V3 card — `*.st.json`

`{ spec: "chara_card_v3", spec_version: "3.0", data: { … } }` with every
required V3 `data` field. Runs in stock SillyTavern _and_ imports back into
Loreweaver through its ST importer (M12/M13):

- **`[InitVar]` entry** (MVU community convention): a constant, keyless entry
  whose content is `{ "<id>": [<initial>, "<label; range/options>"] }` for every
  **player-visible** typed variable. Bounds/options ride in the description
  string; Loreweaver re-imports these as `mvu.*` variables.
- **`@@if` decorator**: an entry `condition` becomes a leading `@@if <expr>`
  line on the content (ST-Prompt-Template convention; Loreweaver's importer
  maps it back onto the typed `condition` field, fail-closed).
- **ST trigger fields**: `secondary_keys` (+`selective`), `insertion_order`,
  `position` (`before_char`/`after_char`), and `extensions` carrying numeric
  `selectiveLogic` (0 and_any / 1 not_all / 2 not_any / 3 and_all — stock ST's
  own mapping, confirmed against Loreweaver's `_SELECTIVE_LOGIC_INTS`),
  `probability`/`useProbability`, `case_sensitive`, `match_whole_words`,
  `scan_depth`, `sticky`, `cooldown`, `delay`.
- **Hooks** ride `data.extensions.loreweaver_hooks` (stock ST ignores them;
  Loreweaver installs them on import).
- **Excluded on purpose**: keeper-only variables and `secret` entries — an ST
  card is entirely player-visible, so they have no safe representation there.

Not yet implemented (planned): PNG embedding (`chara` tEXt for V2 + `ccv3`
tEXt for V3 written together), alternate greetings, and a token-count readout —
the table-stakes features of community editors (AICharED, Chub, RisuAI).

## 3. Card split (拆卡) — what the studio detects and emits

The split view and the pack wizard mirror the engine's `core/card_split.py`
detection exactly (same regexes, same entry test, same stripping):

- **World payloads** = `extensions.loreweaver_hooks` scripts + variable
  declaration entries (`[InitVar]` / `[InitialVariables]` titles, or an
  `@@initial_variables` decorator) + `<% … %>` EJS spans (a dangling `<%`
  strips to end-of-text, fail closed).
- **Character half** (player-safe): prose fields EJS-stripped, declaration
  entries removed, hooks extension dropped. Exported as `*.clean.st.json`
  (the original envelope with cleaned fields written back) or as a native
  bundle / forge project.
- **World half**: the ORIGINAL card, verbatim, declared `kind: world` in
  `pack.yaml` — because the keeper's world import reads the full card. The
  studio never rewrites world machinery; it only PROMOTES a copy of the
  InitVar tree into typed VarSpecs (author-confirmed, `buildSpec`-validated)
  and suggests `.var expose <prefix>` lines for the card's install notes.

## 4. `.lwpack` source trees — planned here, built by the engine

`buildPackSourcePlan` lays out `pack.yaml` + `cards/` + `lorebooks/` +
`skills/<slug>/{SKILL.md,hooks.js}` + `rulepacks/*.yaml`, mirroring
`core/pack.py`'s manifest schema (localized `name`/`description`, card
entries as bare paths or `{path, kind, notes}` mappings, no hand-written
`trust` block). Validation and the byte-deterministic zip are the ENGINE's
job — the wizard shells out to `loreweaver-server --pack <dir> --out <file>`
(or `python -m app --pack …`) and shows its output; the studio deliberately
contains no zip writer. Card `kind` labels are enforced against structural
detection on BOTH sides: the wizard locks machinery-carrying cards to
`kind: world` before the engine re-checks the same rule at build and install.
