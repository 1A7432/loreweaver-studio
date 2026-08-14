import { describe, expect, it } from "vitest"
import { lintPack, lintSummary, STUB_MARKER } from "./packLint"
import { emptyLintSource, type PackLintSource } from "./model"

function source(patch: Partial<PackLintSource> = {}): PackLintSource {
  return { ...emptyLintSource(), ...patch }
}

function ruleIds(findings: ReturnType<typeof lintPack>): string[] {
  return findings.map((finding) => finding.ruleId)
}

const FEAR = { id: "fear", labelEn: "Fear", labelZh: "恐惧", visibility: "player" as const }
const TRUTH = { id: "truth", labelEn: "Truth", labelZh: "真相", visibility: "keeper" as const }

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
      { code: [{ origin: "hooks", source: "setvar('fear', 1)" }] },
      { panelsYaml: "panels:\n  - id: hud\n    blocks:\n      - {kind: meter, value: {$var: fear}}\n" },
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
      source({ variables: [FEAR], code: [{ origin: "hooks", source: "getvar('fear_of_dark')" }] }),
    )
    expect(ruleIds(findings)).toContain("variableUnused")
  })

  it("counts a repeat prefix as using every variable under it", () => {
    const findings = lintPack(
      source({
        variables: [{ ...FEAR, id: "clue_01" }],
        panelsYaml:
          "panels:\n  - id: board\n    blocks:\n      - {repeat: {prefix: clue_, block: {kind: badge, label: {$leaf: label}}}}\n",
      }),
    )
    expect(ruleIds(findings)).not.toContain("variableUnused")
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
    // `core/panels.py`: a plain string IS the en side of a localized field.
    const findings = lintPack(
      source({
        panelsYaml: "panels:\n  - id: hud\n    title: HUD\n    blocks: []\n",
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
  const PLAYER_PANEL = (body: string) => `panels:\n  - id: hud\n    audience: player\n${body}`

  it("reports a player panel bound to a keeper-only variable", () => {
    // The trap the exposure model creates: hidden variables are dropped before
    // the client evaluates anything, so the block silently renders nothing for
    // every player — while looking right to the author, who is the keeper.
    const findings = lintPack(
      source({
        variables: [TRUTH],
        panelsYaml: PLAYER_PANEL("    blocks:\n      - {kind: meter, value: {$var: truth}}\n"),
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
          '    blocks:\n      - {kind: badge, label: {en: X, zh: X}, visible_when: "truth === 2"}\n',
        ),
      }),
    )
    expect(findings.filter((f) => f.key === "panelConditionHiddenVariable")).toHaveLength(1)
  })

  it("leaves a keeper panel alone — it never reaches a player", () => {
    const findings = lintPack(
      source({
        variables: [TRUTH],
        panelsYaml:
          "panels:\n  - id: kp\n    audience: keeper\n    blocks:\n      - {kind: meter, value: {$var: truth}}\n",
      }),
    )
    expect(ruleIds(findings)).not.toContain("panelBindsHiddenVariable")
  })

  it("reports a binding to a variable the pack never declares", () => {
    const findings = lintPack(
      source({
        variables: [FEAR],
        panelsYaml: PLAYER_PANEL("    blocks:\n      - {kind: meter, value: {$var: dread}}\n"),
      }),
    )
    expect(findings.filter((f) => f.ruleId === "panelBindsUnknownVariable")).toHaveLength(1)
  })

  it("resolves a dotted path against its root variable", () => {
    const findings = lintPack(
      source({
        variables: [{ ...FEAR, id: "mvu" }],
        panelsYaml: PLAYER_PANEL("    blocks:\n      - {kind: text, text: {$var: mvu.状态.压力}}\n"),
      }),
    )
    expect(ruleIds(findings)).not.toContain("panelBindsUnknownVariable")
  })

  it("never reads a quoted literal in a condition as a variable", () => {
    const findings = lintPack(
      source({
        variables: [FEAR],
        panelsYaml: PLAYER_PANEL(
          "    blocks:\n      - {kind: badge, label: {en: X, zh: X}, visible_when: \"fear === 'high'\"}\n",
        ),
      }),
    )
    expect(ruleIds(findings)).not.toContain("panelBindsUnknownVariable")
  })
})

describe("code rules", () => {
  it("reports the wizard's draft stub shipped as-is", () => {
    const findings = lintPack(
      source({ code: [{ origin: "hooks", source: `on('reply_ready', () => {\n  ${STUB_MARKER}\n})` }] }),
    )
    expect(findings.filter((f) => f.ruleId === "stubMarker")).toHaveLength(1)
    expect(findings[0].target).toEqual({ kind: "code", id: "hooks" })
  })

  it("reports getvar/setvar/incvar and variables.<path> on unknown ids", () => {
    const findings = lintPack(
      source({
        variables: [FEAR],
        code: [
          {
            origin: "hooks",
            source: "setvar('dread', 1); incvar(\"panic\", 2); const x = variables.unknown_one",
          },
        ],
      }),
    )
    const ids = findings.filter((f) => f.ruleId === "codeUnknownVariable").map((f) => f.params.id)
    expect(ids).toEqual(["dread", "panic", "unknown_one"])
  })

  it("says nothing about code when the pack declares no variables at all", () => {
    // Nothing to compare against; every id would be "unknown" and the panel
    // would be pure noise.
    const findings = lintPack(source({ code: [{ origin: "hooks", source: "setvar('dread', 1)" }] }))
    expect(ruleIds(findings)).not.toContain("codeUnknownVariable")
  })

  it("reports an unknown variable named by a lore macro or condition", () => {
    const findings = lintPack(
      source({
        variables: [FEAR],
        lore: [{ ...LORE, content: "{{getvar::dread}}", condition: "panic > 1" }],
      }),
    )
    const ids = findings.filter((f) => f.ruleId === "codeUnknownVariable").map((f) => f.params.id)
    expect(ids).toEqual(["dread", "panic"])
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
          "panels:\n  - id: board\n    blocks:\n      - {kind: image, src: ui/handouts/page.png}\n      - {kind: image, src: assets/missing.png}\n",
      }),
    )
    const missing = findings.filter((f) => f.ruleId === "assetMissing")
    expect(missing).toHaveLength(1)
    expect(missing[0].params).toMatchObject({ path: "assets/missing.png", from: "board" })
  })

  it("says nothing about assets when there is no file list to check against", () => {
    const findings = lintPack(
      source({
        panelsYaml: "panels:\n  - id: board\n    blocks:\n      - {kind: image, src: assets/x.png}\n",
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
          "panels:\n  - id: hud\n    audience: player\n    title: {en: HUD, zh: 状态板}\n    blocks:\n      - {kind: meter, label: {en: Fear, zh: 恐惧}, value: {$var: fear}}\n",
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
