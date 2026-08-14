import { describe, expect, it } from "vitest"
import { newLoreEntry, newProject, newVariable } from "../model"
import { lintPack } from "./packLint"
import { lintSourceFromPackBench, lintSourceFromProject, loreFromJson } from "./sources"
import type { PackItem } from "../../../store/pack"

describe("lintSourceFromProject", () => {
  it("carries the forge's variables, lore and hooks, and no pack rules", () => {
    const project = newProject("Corridor")
    project.variables = [{ ...newVariable(), id: "Fear Level", labelEn: "Fear", labelZh: "" }]
    project.lorebook = [{ ...newLoreEntry(), title: "Rain", keys: "" }]
    project.hooks = "on('turn_start', () => setvar('fear_level', 1))"

    const source = lintSourceFromProject(project)
    // Ids are normalized the way the engine will see them.
    expect(source.variables[0].id).toBe("fear_level")
    expect(source.meta).toBeNull()
    expect(source.code).toEqual([{ origin: "hooks", source: project.hooks }])

    const findings = lintPack(source)
    // The dead lore entry and the half-translated label; NOT the unused
    // variable (the hooks name it) and no pack-metadata noise.
    expect(findings.map((f) => f.ruleId).sort()).toEqual(["bilingualGap", "loreNeverActivates"])
  })
})

describe("loreFromJson", () => {
  it("reads a SillyTavern world-info export (entries as a map)", () => {
    const entries = loreFromJson(
      JSON.stringify({
        entries: {
          "0": { comment: "Rain", content: "It rains.", key: ["rain", "storm"], constant: false },
          "1": { comment: "Off", content: "…", key: [], disable: true },
        },
      }),
      "rain.json",
    )
    expect(entries).toEqual([
      {
        id: "rain.json#1",
        title: "Rain",
        content: "It rains.",
        keys: "rain, storm",
        condition: "",
        constant: false,
        enabled: true,
      },
      {
        id: "rain.json#2",
        title: "Off",
        content: "…",
        keys: "",
        condition: "",
        constant: false,
        enabled: false,
      },
    ])
  })

  it("digs a card's embedded character_book out from under data", () => {
    const entries = loreFromJson(
      JSON.stringify({ data: { character_book: { entries: [{ comment: "A", content: "a" }] } } }),
      "keeper.json",
    )
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe("A")
  })

  it("contributes nothing rather than a finding for junk", () => {
    expect(loreFromJson("not json", "x.json")).toEqual([])
    expect(loreFromJson("[1,2,3]", "x.json")).toEqual([])
  })
})

function cardItem(patch: Partial<PackItem>): PackItem {
  return {
    uid: "u",
    fileName: "keeper.json",
    sourceName: "keeper.json",
    kind: "card",
    base64: "",
    jsonText: null,
    card: null,
    payloads: null,
    cardKind: "world",
    hooks: [],
    leaves: [],
    leavesTruncated: false,
    drafts: [],
    extractSkill: false,
    notesEn: "",
    notesZh: "",
    entryCount: 0,
    ...patch,
  }
}

describe("lintSourceFromPackBench", () => {
  it("collects variables from included promotion drafts only", () => {
    const include = {
      uid: "d1",
      include: true,
      mvuPath: "理.恐惧",
      rawValue: 0,
      description: "",
      variable: { ...newVariable(), id: "fear", labelEn: "Fear", labelZh: "恐惧" },
      notes: [],
    }
    const skip = { ...include, uid: "d2", include: false, variable: { ...newVariable(), id: "dropped" } }
    const source = lintSourceFromPackBench({
      items: [cardItem({ drafts: [include, skip] })],
      metadata: {
        id: "corridor",
        version: "1.0.0",
        nameEn: "Corridor",
        nameZh: "走廊",
        descriptionEn: "A corridor.",
        descriptionZh: "一条走廊。",
        authors: "Nyx",
        license: "CC-BY-4.0",
        rulepackPatch: "",
        rulepackId: "",
      },
      panels: null,
      manualSkills: [],
      presentation: null,
    })
    expect(source.variables.map((v) => v.id)).toEqual(["fear"])
    expect(source.meta?.license).toBe("CC-BY-4.0")
  })

  it("ships panel files and kit media as one pack-relative file list", () => {
    const source = lintSourceFromPackBench({
      items: [cardItem({ kind: "asset", fileName: "cover.png", uid: "a1" })],
      metadata: {
        id: "corridor",
        version: "1.0.0",
        nameEn: "C",
        nameZh: "走",
        descriptionEn: "d",
        descriptionZh: "描",
        authors: "Nyx",
        license: "MIT",
        rulepackPatch: "",
        rulepackId: "",
      },
      panels: { yamlText: "panels: []", files: [{ path: "ui/handouts/page.png", base64: "" }] },
      manualSkills: [],
      presentation: {
        generation: "allow",
        templates: [],
        keywordsEn: "",
        keywordsZh: "",
        bannedText: "",
        paletteText: "",
        subjects: [
          {
            uid: "s",
            id: "wen",
            kind: "npc",
            nameEn: "Wen",
            nameZh: "温",
            refFileName: "wen.png",
            refBase64: "x",
            prompt: "",
          },
        ],
        audio: [
          { uid: "c", id: "rain", layer: "bgm", assetFileName: "rain.mp3", assetBase64: "y", title: "" },
        ],
      },
    })
    expect(source.shippedFiles).toEqual([
      "assets/cover.png",
      "ui/handouts/page.png",
      "assets/wen.png",
      "assets/rain.mp3",
    ])
    expect(source.assetRefs).toEqual([
      { path: "assets/wen.png", from: "wen" },
      { path: "assets/rain.mp3", from: "rain" },
    ])
  })
})
