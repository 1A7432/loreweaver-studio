# Export formats

The studio's card forge exports two flavors per the main repo's M14 draft
("imported cards adapt to us; forged cards are born native and still play
everywhere"). Validation mirrors the engine (`core/modvars.py`,
`core/worldbook.py`): ids `^[a-z0-9_]{1,64}$`, ≤64 variables, enum ≤20 options
of ≤50 chars, labels ≤50 chars, text defaults ≤200 chars, conditions ≤500 chars.

## 1. Loreweaver native bundle — `*.lorecard.json`

Lossless authoring output, `format_version: 1` — the frozen M16 consolidation
shape parsed by the engine's `core/lorecard.py`: typed variable specs exactly
as `core.modvars.build_spec` emits them, worldbook entries exactly as
`LoreEntry.from_dict` accepts them. v1 renamed the ST-copied prose fields
(`opening` / `alternate_openings` / `dialogue_examples` / `author_notes`
replace `first_mes` / `alternate_greetings` / `mes_example` / `creator_notes`)
and made hook scripts the first-class top-level `hooks` list. v0 (the
pre-freeze provisional shape) is deliberately unmigratable engine-side; the
studio still READS v0 for importing its own historical exports, but never
writes it.

```jsonc
{
  "format": "loreweaver.card",
  "format_version": 1,
  "name": "…",
  "description": "…",
  "personality": "…",
  "scenario": "…",
  "opening": "…",
  "dialogue_examples": "…",
  "alternate_openings": ["…"],
  "author_notes": "…",
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
      // Optional STABLE entry id — the cross-pack reference handle
      // (`<pack-id>#<entry-id>`); carried verbatim, collisions warned about.
      "id": "the-well",
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
  // Top-level hook sources; the key is omitted when empty.
  "hooks": ["…hooks.js source…"],
  // The module's claimable investigator cast (`.pc list` / `.pc claim`), at
  // most 8; sheets are built downstream from system defaults + these skill
  // overrides — deterministic, no LLM. Omitted when empty.
  "pregens": [
    {
      "name": "…", // ≤60 chars, required
      "concept": "…", // ≤200 chars, optional
      "notes": "…", // ≤400 chars, optional
      "skills": { "侦查": 60 }, // ≤32 entries, integer values, optional
    },
  ],
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
- **World half**: the ORIGINAL card, verbatim — the pack build DETECTS it as
  `kind: world` (authors never declare kinds; the stamp lands in the built
  manifest) because the keeper's world import reads the full card. The
  studio never rewrites world machinery; it only PROMOTES a copy of the
  InitVar tree into typed VarSpecs (author-confirmed, `buildSpec`-validated)
  and suggests `.var expose <prefix>` lines for the card's install notes.

## 4. `.lwpack` source trees — planned here, built by the engine

`buildPackSourcePlan` lays out `pack.yaml` + `cards/` + `lorebooks/` +
`skills/<slug>/{SKILL.md,hooks.js}` + `rulepacks/*.yaml` (+ optional
`ui/panels.yaml` and its files, and the M19 `ui/presentation.yaml` kit with
its `assets/` media), mirroring `core/pack.py`'s **v2 author
manifest** schema:

- localized `name`/`description` (`{en, zh}`), `authors`, `license`, and an
  `engine: {protocol: "2.0"}` minimum-version block (`protocol`/`server` are
  the only keys the engine accepts; minimum-compare only);
- card entries are bare paths or `{path, notes: {en, zh}}` mappings — authors
  **never declare `kind`** (the engine rejects a declared kind outright).
  Machinery — hooks / `[InitVar]` / EJS / `secret` lore, plus a native
  bundle's typed `variables` specs (`core/pack.py:644-652`) — is DETECTED at
  build time via `core.card_split.detect_world_payloads` and stamped into the
  built manifest; install re-verifies the stamp against the real payload. The
  wizard mirrors the same detection (a specs-only lorecard is `world`), so
  its badges always agree with the engine's stamp;
- no hand-written `trust` or `files` blocks and no `manifest_version` — the
  build generates the trust summary and the complete file inventory
  (`sha256`/`size` per member), and an omitted author-side
  `manifest_version` means "current".

Validation and the byte-deterministic zip are the ENGINE's job — the wizard
shells out to `loreweaver-server --pack <dir> --out <file> --json` (or
`python -m app --pack …`) and shows its output; the studio deliberately
contains no zip writer. With `--json`, stdout carries exactly one machine
object — `{"ok": true, "path", "id", "version", "sha256", "trust"}` on
success, `{"ok": false, "error"}` on failure — while the human lines
(including the localized trust card) stay on stderr. The wizard renders the
trust card natively from that object (content counts, detected world-card
count, hooks/EJS/rules-script flags, Stage Director subjects and the
imagegen veto) and surfaces a failure's `error` prominently.

## 5. Presentation kit — `ui/presentation.yaml` (M19, 演出资料包)

The Stage Director's entire creative brief, authored as data and gated on its
own existence: the Director stages beats **only** for rooms whose module ships
a kit (kit-gating). The wizard's "Presentation" step edits this file as forms;
the schema authority is the engine's `core/presentation.py` and the build
re-parses it (`core/pack.py::_validate_pack_presentation`, at most one kit per
pack, `.yaml` only). `contents.presentation: [ui/presentation.yaml]` declares
it; every ref/cue file lives under `assets/` and MUST sit in the manifest
`assets:` block (`core/pack.py::_enforce_kit_assets` — a ref must sniff as an
image, a cue asset as audio).

```yaml
version: 1 # required, must be 1
generation:
  allow # allow | pack_only — pack_only is the 宁缺毋滥
  # author veto: pack art only, no config overrides
style: # optional; carried on EVERY image request
  keywords: { en: "ink wash, muted indigo", zh: "水墨, 靛青" } # ≤400 chars/locale
  banned: [text overlays, modern clothing] # ≤24 entries, ≤400 chars each
subjects: # ≤64; id is a slug ^[a-z0-9][a-z0-9-]{0,63}$
  - id: gu-wantang
    kind: npc # npc | location | item
    name: { en: Gu Wantang, zh: 顾晚棠 } # ≥1 locale, ≤400 chars each
    ref:
      assets/gu-wantang.png # OPTIONAL per schema — but no ref →
      # no portrait (ref-mandatory doctrine)
    prompt: "a woman in her thirties, plain dark coat, wet hair" # ≤1000 chars
audio: # ≤32 cues; asset is REQUIRED per cue
  - { id: chao-yong, layer: bgm, asset: assets/chao-yong.mp3, title: 潮涌 }
    # layer: bgm | ambience | sfx; title ≤400 chars
```

Doctrine (docs/specs/M19 in the engine repo): **ref-mandatory** — a subject
without `ref` is nameable in captions but never generated; the ref + style
keywords ride every image request. **宁缺毋滥** — `generation: pack_only` is
the author's veto. **慢菜先备** (pre-generation) is a runtime concern; the kit
only has to make subjects nameable. The trust card discloses the subject count
(`trust.presentation`) and whether generation is licensed in practice
(`trust.imagegen` = `allow` AND ≥1 subject ships a ref).
