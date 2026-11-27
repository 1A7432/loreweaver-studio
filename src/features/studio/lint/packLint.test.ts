import { describe, expect, it } from "vitest"
import { lintPack, lintSummary } from "./packLint"
import { emptyLintSource, type PackLintSource } from "./model"

function source(patch: Partial<PackLintSource> = {}): PackLintSource {
  return { ...emptyLintSource(), ...patch }
}

function ruleIds(findings: ReturnType<typeof lintPack>): string[] {
  return findings.map((finding) => finding.ruleId)
}

const FEAR = { id: "fear", labelEn: "Fear", labelZh: "恐惧", visibility: "player" as const }
const TRUTH = { id: "truth", labelEn: "Truth", labelZh: "真相", visibility: "keeper" as const }

/** A panels 3.0 file: one panel that reads the pack's variables through the `variables` view. */
function panelsFile(body: string, head = ""): string {
  return `panels:\n  - id: hud\n    slot: sidebar\n${head}    views: {vars: variables}\n    blocks:\n${body}`
}

const FEAR_METER =
  "      - {kind: meter, label: {en: Fear, zh: 恐惧}, value: {$view: vars.module.fear.value}, min: 0, max: 10}\n"

const LORE = {
  id: "e1",
  title: "Rain",
  content: "It rains.",
  keys: "rain",
  condition: "",
  constant: false,
  enabled: true,
}

describe("variableUnused", () => {
  it("stays quiet when anything at all names the variable", () => {
    const mentions = [
      { lore: [{ ...LORE, content: "Your {{var:fear}} rises." }] },
      { lore: [{ ...LORE, content: "…", condition: "fear > 3" }] },
      { panelsYaml: panelsFile(FEAR_METER) },
    ]
    for (const patch of mentions) {
      expect(ruleIds(lintPack(source({ variables: [FEAR], ...patch })))).not.toContain("variableUnused")
    }
  })

  it("reports a variable nothing mentions", () => {
    const findings = lintPack(source({ variables: [FEAR], lore: [LORE] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      ruleId: "variableUnused",
      severity: "info",
      params: { id: "fear" },
      target: { kind: "variable", id: "fear" },
    })
  })

  it("does not mistake a longer id for a mention of a shorter one", () => {
    // `fear_of_dark` contains `fear`, but naming one is not naming the other.
    const findings = lintPack(
      source({ variables: [FEAR], lore: [{ ...LORE, content: "The {{var:fear_of_dark}} rises." }] }),
    )
    expect(ruleIds(findings)).toContain("variableUnused")
  })

  it("counts a repeat over the variable tree as using every variable under its prefix", () => {
    const findings = lintPack(
      source({
        variables: [{ ...FEAR, id: "clue_01" }],
        panelsYaml: panelsFile(
          "      - repeat: {each: vars.tree, as: leaf, prefix: clue_, block: {kind: badge, label: {$view: leaf.label}}}\n",
        ),
      }),
    )
    expect(ruleIds(findings)).not.toContain("variableUnused")
  })

  it("does not count a repeat over anything but the variable tree", () => {
    const findings = lintPack(
      source({
        variables: [{ ...FEAR, id: "clue_01" }],
        panelsYaml:
          "panels:\n  - id: board\n    slot: sidebar\n    views: {me: me, vars: variables}\n    blocks:\n" +
          "      - repeat: {each: me.character.resources, as: r, prefix: clue_, block: {kind: badge, label: {$view: r.label}}}\n",
      }),
    )
    expect(ruleIds(findings)).toContain("variableUnused")
  })
})

describe("loreNeverActivates", () => {
  it("reports an entry with no keys, no constant and no condition", () => {
    const findings = lintPack(source({ lore: [{ ...LORE, keys: "  ,  " }] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ ruleId: "loreNeverActivates", severity: "warn" })
  })

  it("accepts any one of the three ways to fire", () => {
    const alive = [
      { ...LORE, keys: "rain" },
      { ...LORE, keys: "", constant: true },
      { ...LORE, keys: "", condition: "day > 3" },
    ]
    for (const entry of alive) {
      expect(ruleIds(lintPack(source({ lore: [entry] })))).not.toContain("loreNeverActivates")
    }
  })

  it("ignores a disabled entry — it was switched off on purpose", () => {
    const findings = lintPack(source({ lore: [{ ...LORE, keys: "", enabled: false }] }))
    expect(ruleIds(findings)).not.toContain("loreNeverActivates")
  })
})

describe("bilingualGap", () => {
  it("reports one filled side and one empty, never two empty", () => {
    const half = lintPack(source({ variables: [{ ...FEAR, labelZh: "" }], lore: [] }))
    expect(half.filter((f) => f.ruleId === "bilingualGap")).toHaveLength(1)
    expect(half.find((f) => f.ruleId === "bilingualGap")?.params.missing).toBe("zh")

    const none = lintPack(source({ variables: [{ ...FEAR, labelEn: "", labelZh: "" }] }))
    expect(ruleIds(none)).not.toContain("bilingualGap")
  })

  it("reads a plain-string panel label as an en-only one", () => {
    // A plain string IS the en side of a localized field (panels.md §5).
    const findings = lintPack(
      source({
        panelsYaml: "panels:\n  - id: hud\n    title: HUD\n    slot: sidebar\n    blocks: []\n",
      }),
    )
    expect(findings.filter((f) => f.ruleId === "bilingualGap")).toHaveLength(1)
    expect(findings[0].params).toMatchObject({ panel: "hud", field: "title", missing: "zh" })
  })

  it("reports a pack name or description with one side missing", () => {
    const findings = lintPack(
      source({
        meta: {
          id: "deep-pier",
          nameEn: "Deep Pier",
          nameZh: "",
          descriptionEn: "A pier.",
          descriptionZh: "一座码头。",
          license: "CC-BY-4.0",
        },
      }),
    )
    expect(findings.filter((f) => f.ruleId === "bilingualGap")).toHaveLength(1)
    expect(findings[0].params).toMatchObject({ field: "name", missing: "zh" })
  })
})

describe("panel bindings", () => {
  const PLAYER_PANEL = (body: string) => panelsFile(body, "    audience: player\n")

  it("reports a player panel bound to a keeper-only variable", () => {
    // The trap the exposure model creates: a hidden variable is absent from a
    // player's `variables` view, so the block silently renders nothing for
    // every player — while looking right to the author, who is the room admin.
    const findings = lintPack(
      source({
        variables: [TRUTH],
        panelsYaml: PLAYER_PANEL(
          "      - {kind: meter, label: {en: T, zh: T}, value: {$view: vars.module.truth.value}, min: 0, max: 3}\n",
        ),
      }),
    )
    expect(findings.filter((f) => f.ruleId === "panelBindsHiddenVariable")).toHaveLength(1)
    expect(findings.find((f) => f.ruleId === "panelBindsHiddenVariable")?.params).toMatchObject({
      panel: "hud",
      id: "truth",
    })
  })

  it("reports a keeper-only variable named in a player panel's visible_when", () => {
    // Worse than a dead binding: the condition string ships with the pack, so
    // the variable's NAME (and the compared literal) leak to every viewer.
    const findings = lintPack(
      source({
        variables: [TRUTH],
        panelsYaml: PLAYER_PANEL(
          '      - {kind: badge, label: {en: X, zh: X}, visible_when: "vars.module.truth.value == 2"}\n',
        ),
      }),
    )
    expect(findings.filter((f) => f.key === "panelConditionHiddenVariable")).toHaveLength(1)
  })

  it("leaves an admin panel alone — it never reaches a player", () => {
    const findings = lintPack(
      source({
        variables: [TRUTH],
        panelsYaml: panelsFile(
          "      - {kind: meter, label: {en: T, zh: T}, value: {$view: vars.module.truth.value}, min: 0, max: 3}\n",
          "    audience: admin\n",
        ),
      }),
    )
    expect(ruleIds(findings)).not.toContain("panelBindsHiddenVariable")
  })

  it("reports a binding to a variable the pack never declares", () => {
    const findings = lintPack(
      source({
        variables: [FEAR],
        panelsYaml: PLAYER_PANEL(
          "      - {kind: meter, label: {en: D, zh: D}, value: {$view: vars.module.dread.value}, min: 0, max: 3}\n",
        ),
      }),
    )
    expect(findings.filter((f) => f.ruleId === "panelBindsUnknownVariable")).toHaveLength(1)
  })

  it("reads the pack's variables through a `variables` view handle and no other", () => {
    // `me.module.dread` is the `me` view's own business, not a pack variable;
    // a renamed handle bound to `variables` is read just the same.
    const other = lintPack(
      source({
        variables: [FEAR],
        panelsYaml:
          "panels:\n  - id: hud\n    slot: sidebar\n    views: {me: me}\n    blocks:\n" +
          "      - {kind: text, text: {$view: me.module.dread.value}}\n",
      }),
    )
    expect(ruleIds(other)).not.toContain("panelBindsUnknownVariable")

    const renamed = lintPack(
      source({
        variables: [FEAR],
        panelsYaml:
          "panels:\n  - id: hud\n    slot: sidebar\n    views: {state: variables}\n    blocks:\n" +
          "      - {kind: text, text: {$view: state.module.dread.value}}\n",
      }),
    )
    expect(renamed.filter((f) => f.ruleId === "panelBindsUnknownVariable")).toHaveLength(1)
  })

  it("never reads a quoted literal in a condition as a variable", () => {
    const findings = lintPack(
      source({
        variables: [FEAR],
        panelsYaml: PLAYER_PANEL(
          "      - {kind: badge, label: {en: X, zh: X}, visible_when: \"vars.module.fear.value == 'vars.module.dread.value'\"}\n",
        ),
      }),
    )
    expect(ruleIds(findings)).not.toContain("panelBindsUnknownVariable")
  })
})

describe("panelLegacy", () => {
  const legacyFields = (findings: ReturnType<typeof lintPack>) =>
    findings.filter((f) => f.ruleId === "panelLegacy").map((f) => f.params.fields)

  it("reports panels 1.x bindings the migration left for the author", () => {
    const findings = lintPack(
      source({
        variables: [FEAR],
        panelsYaml:
          "panels:\n  - id: hud\n    slot: sidebar\n    blocks:\n" +
          "      - {kind: meter, label: {en: Fear, zh: 恐惧}, value: {$var: fear}}\n" +
          "      - repeat: {prefix: clue_, block: {kind: badge, label: {$leaf: label}}}\n",
      }),
    )
    // One finding per panel, naming every legacy field it still carries.
    expect(findings.filter((f) => f.ruleId === "panelLegacy")).toHaveLength(1)
    expect(findings.find((f) => f.ruleId === "panelLegacy")).toMatchObject({
      severity: "warn",
      params: { panel: "hud" },
      target: { kind: "panel", id: "hud" },
    })
    expect(legacyFields(findings)).toEqual(["$var, $leaf"])
  })

  it("reports a choice's `input` and a page's `assets`", () => {
    const findings = lintPack(
      source({
        panelsYaml:
          "panels:\n  - id: hud\n    slot: modal\n    assets: [ui/a.png]\n    blocks:\n" +
          "      - {kind: choices, options: [{id: a, label: A, command: help, input: text}]}\n",
      }),
    )
    expect(legacyFields(findings)).toEqual(["assets, input"])
  })

  it("reports `audience: keeper` and reads that panel as an admin one", () => {
    const findings = lintPack(
      source({
        variables: [TRUTH],
        panelsYaml: panelsFile(
          "      - {kind: meter, label: {en: T, zh: T}, value: {$view: vars.module.truth.value}, min: 0, max: 3}\n",
          "    audience: keeper\n",
        ),
      }),
    )
    expect(legacyFields(findings)).toEqual(["audience: keeper"])
    expect(ruleIds(findings)).not.toContain("panelBindsHiddenVariable")
  })

  it("says nothing about a panels 3.0 file", () => {
    const findings = lintPack(source({ variables: [FEAR], panelsYaml: panelsFile(FEAR_METER) }))
    expect(ruleIds(findings)).not.toContain("panelLegacy")
  })
})

describe("lore variable rules", () => {
  it("reports an unknown variable named by a lore macro or condition", () => {
    const findings = lintPack(
      source({
        variables: [FEAR],
        lore: [{ ...LORE, content: "{{getvar::dread}}", condition: "panic > 1" }],
      }),
    )
    const found = findings.filter((f) => f.ruleId === "codeUnknownVariable")
    expect(found.map((f) => f.params.id)).toEqual(["dread", "panic"])
    expect(found[0].key).toBe("loreUnknownVariable")
  })

  it("resolves a dotted path against its root variable", () => {
    const findings = lintPack(
      source({
        variables: [{ ...FEAR, id: "mvu" }],
        lore: [{ ...LORE, content: "{{var:mvu}}", condition: "mvu.状态.压力 > 1" }],
      }),
    )
    expect(ruleIds(findings)).not.toContain("codeUnknownVariable")
  })

  it("says nothing when the pack declares no variables at all", () => {
    // Nothing to compare against; every id would be "unknown" and the panel
    // would be pure noise.
    const findings = lintPack(
      source({ lore: [{ ...LORE, content: "{{getvar::dread}}", condition: "panic > 1" }] }),
    )
    expect(ruleIds(findings)).not.toContain("codeUnknownVariable")
  })
})

describe("pack metadata and assets", () => {
  const META = {
    id: "deep-pier",
    nameEn: "Deep Pier",
    nameZh: "深水码头",
    descriptionEn: "",
    descriptionZh: "",
    license: "",
  }

  it("reports a missing description and a missing license", () => {
    const findings = lintPack(source({ meta: META }))
    expect(findings.map((f) => f.key)).toEqual(["packDescriptionMissing", "packLicenseMissing"])
    expect(findings.every((f) => f.ruleId === "packMetadataThin")).toBe(true)
  })

  it("reports a panel picture the pack does not ship, under either root", () => {
    const findings = lintPack(
      source({
        shippedFiles: ["ui/handouts/page.png"],
        panelsYaml:
          "panels:\n  - id: board\n    slot: modal\n    blocks:\n      - {kind: image, src: ui/handouts/page.png}\n      - {kind: image, src: assets/missing.png}\n",
      }),
    )
    const missing = findings.filter((f) => f.ruleId === "assetMissing")
    expect(missing).toHaveLength(1)
    expect(missing[0].params).toMatchObject({ path: "assets/missing.png", from: "board" })
  })

  it("says nothing about assets when there is no file list to check against", () => {
    const findings = lintPack(
      source({
        panelsYaml:
          "panels:\n  - id: board\n    slot: modal\n    blocks:\n      - {kind: image, src: assets/x.png}\n",
      }),
    )
    expect(ruleIds(findings)).not.toContain("assetMissing")
  })
})

describe("lintSummary", () => {
  it("splits the counts the toolbar badge shows", () => {
    const findings = lintPack(source({ variables: [FEAR], lore: [{ ...LORE, keys: "" }] }))
    expect(lintSummary(findings)).toEqual({ warn: 1, info: 1 })
  })

  it("is empty for a clean pack", () => {
    const findings = lintPack(
      source({
        meta: {
          id: "deep-pier",
          nameEn: "Deep Pier",
          nameZh: "深水码头",
          descriptionEn: "A pier.",
          descriptionZh: "一座码头。",
          license: "CC-BY-4.0",
        },
        variables: [FEAR, TRUTH],
        lore: [{ ...LORE, content: "The {{var:fear}} rises; {{var:truth}} waits." }],
        panelsYaml:
          "panels:\n  - id: hud\n    audience: player\n    title: {en: HUD, zh: 状态板}\n    slot: sidebar\n    views: {vars: variables}\n    blocks:\n" +
          FEAR_METER,
      }),
    )
    expect(findings).toEqual([])
  })
})

describe("serialized-module rules", () => {
  const EPISODES = [
    { id: "ep1", ordinal: 1, title: "雨夜", releaseNotes: "首次发布。" },
    { id: "ep2", ordinal: 2, title: "第五层", releaseNotes: "" },
  ]

  it("says nothing at all about an ordinary one-shot pack", () => {
    // A pack that does not use the feature must not grow findings about it.
    const findings = lintPack(source({ lore: [LORE] }))
    expect(findings.map((f) => f.ruleId).filter((id) => id.startsWith("episode"))).toEqual([])
  })

  it("reports content tagged to an episode nothing declares", () => {
    // The BUILD includes it (a typo must not cut an author's work), so this
    // finding is the only thing that will tell them.
    const findings = lintPack(
      source({ episodes: EPISODES, buildUpTo: 2, lore: [{ ...LORE, episode: "ep9" }] }),
    )
    const unknown = findings.filter((f) => f.ruleId === "episodeUnknown")
    expect(unknown).toHaveLength(1)
    expect(unknown[0].params).toMatchObject({ tag: "ep9" })
  })

  it("catches the same typo on a FILE, which has no entries to surface it", () => {
    // An asset carries no lore entries, so the entry loop above never sees its
    // tag; a PNG card is the same. The build includes an unknown tag on
    // purpose, which means nothing else would ever mention it.
    const findings = lintPack(
      source({
        episodes: EPISODES,
        buildUpTo: 2,
        taggedFiles: [
          { path: "assets/chapter-two-map.png", episode: "ep9" },
          { path: "assets/cover.png", episode: "ep1" },
        ],
      }),
    )
    const unknown = findings.filter((f) => f.ruleId === "episodeUnknown")
    expect(unknown).toHaveLength(1)
    expect(unknown[0].params).toMatchObject({ tag: "ep9", title: "assets/chapter-two-map.png" })
    expect(unknown[0].target).toEqual({ kind: "asset", id: "assets/chapter-two-map.png" })
  })

  it("reports an episode that will ship with no release notes", () => {
    const findings = lintPack(source({ episodes: EPISODES, buildUpTo: 2 }))
    const missing = findings.filter((f) => f.ruleId === "episodeNoNotes")
    expect(missing).toHaveLength(1)
    expect(missing[0].params).toMatchObject({ ordinal: 2 })
  })

  it("ignores a later episode's missing notes when this build stops short of it", () => {
    const findings = lintPack(source({ episodes: EPISODES, buildUpTo: 1 }))
    expect(findings.map((f) => f.ruleId)).not.toContain("episodeNoNotes")
  })

  it("reports an earlier entry naming what a later episode introduces", () => {
    // Cumulatively the reference resolves; in the release that ships episode 1
    // — the one someone is reading now — it dangles.
    const findings = lintPack(
      source({
        episodes: EPISODES,
        buildUpTo: 2,
        lore: [{ ...LORE, episode: "ep1", content: "楼梯通向第五层。" }],
      }),
    )
    const forward = findings.filter((f) => f.ruleId === "episodeForwardReference")
    expect(forward).toHaveLength(1)
    expect(forward[0].params).toMatchObject({ ordinal: 1, ahead: 2, name: "第五层" })
  })

  it("does not flag a LATER entry naming an earlier episode", () => {
    const findings = lintPack(
      source({
        episodes: EPISODES,
        buildUpTo: 2,
        lore: [{ ...LORE, episode: "ep2", content: "那个雨夜之后。" }],
      }),
    )
    expect(findings.map((f) => f.ruleId)).not.toContain("episodeForwardReference")
  })
})
