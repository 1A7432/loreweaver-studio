// Native-bundle reader tests: the exporter→importer round trip must be
// lossless for everything the forge can author, and the pack-side card view
// must classify machinery exactly like the engine (hooks / secret / InitVar).

import { describe, expect, it } from "vitest"
import { exportNativeBundle } from "../exporters"
import { newLoreEntry, newProject, newVariable, validateProject } from "../model"
import { splitCard } from "./cardSplit"
import { looksLikeLorecard, lorecardToCard, lorecardToProject } from "./lorecard"

function sampleProject() {
  const project = newProject("白鹭")
  project.description = "东京，2029。"
  project.personality = "冷而不硬。"
  project.scenario = "听证会前七天。"
  project.firstMes = "雨点敲着新宿的霓虹。"
  project.mesExample = "<START>调查从一杯冷咖啡开始。"
  project.alternateGreetings = ["序章：三年前的最后一夜。", "冷开场：内调的茶。"]
  project.creatorNotes = "keeper first"
  project.tags = "noir, tokyo"
  project.hooks = "on('turn_start', () => { /* pulse */ })"

  const heat = newVariable()
  heat.id = "视线"
  heat.kind = "number"
  heat.visibility = "player"
  heat.labelEn = "Heat"
  heat.labelZh = "视线"
  heat.minimum = "0"
  heat.maximum = "10"
  heat.defaultValue = "1"
  const erosion = newVariable()
  erosion.id = "真相侵蚀度"
  erosion.kind = "number"
  erosion.visibility = "keeper"
  erosion.labelZh = "真相侵蚀度"
  erosion.defaultValue = "46"
  const style = newVariable()
  style.id = "行动风格"
  style.kind = "enum"
  style.visibility = "player"
  style.labelZh = "行动风格"
  style.options = "硬派\n潜行\n社交\n数据"
  style.defaultValue = "社交"
  project.variables = [heat, erosion, style]

  const open = newLoreEntry()
  open.title = "晴海第II街区"
  open.content = "填海地上，白鹭群落。"
  open.keys = "晴海, 填海地"
  open.secondaryKeys = "地价, 鉴定"
  open.selectiveLogic = "and_any"
  open.probability = 90
  open.sticky = 2
  const truth = newLoreEntry()
  truth.title = "真相层：手帐"
  truth.content = "句帐夹在 2020 年 11 月号的装订样里。"
  truth.secret = true
  truth.constant = true
  truth.condition = "证据链完整度 >= 6"
  project.lorebook = [open, truth]
  return project
}

describe("lorecard round trip", () => {
  it("export → import preserves prose, variables, lore flags and hooks", () => {
    const project = sampleProject()
    const specs = validateProject(project).specs
    expect(specs).toHaveLength(3)
    const bundle = exportNativeBundle(project, specs)
    expect(looksLikeLorecard(bundle)).toBe(true)

    const { project: back, warnings } = lorecardToProject(bundle as Record<string, unknown>)
    expect(warnings).toEqual([])
    expect(back.name).toBe("白鹭")
    expect(back.alternateGreetings).toEqual(project.alternateGreetings)
    expect(back.mesExample).toBe(project.mesExample)
    expect(back.hooks).toBe(project.hooks)
    expect(back.tags).toBe("noir, tokyo")

    expect(back.variables).toHaveLength(3)
    const byId = new Map(back.variables.map((v) => [v.id, v]))
    expect(byId.get("视线")?.visibility).toBe("player")
    expect(byId.get("视线")?.minimum).toBe("0")
    expect(byId.get("视线")?.maximum).toBe("10")
    expect(byId.get("真相侵蚀度")?.visibility).toBe("keeper")
    expect(byId.get("行动风格")?.options.split("\n")).toEqual(["硬派", "潜行", "社交", "数据"])
    expect(byId.get("行动风格")?.defaultValue).toBe("社交")

    expect(back.lorebook).toHaveLength(2)
    const reTruth = back.lorebook.find((entry) => entry.secret)
    expect(reTruth?.condition).toBe("证据链完整度 >= 6")
    expect(reTruth?.constant).toBe(true)
    const reOpen = back.lorebook.find((entry) => !entry.secret)
    expect(reOpen?.keys).toBe("晴海, 填海地")
    expect(reOpen?.secondaryKeys).toBe("地价, 鉴定")
    expect(reOpen?.probability).toBe(90)
    expect(reOpen?.sticky).toBe(2)

    // The round-tripped specs are identical — the bundle is the source of truth.
    expect(validateProject(back).specs).toEqual(specs)
  })

  it("refuses a wrong format tag and an unsupported version", () => {
    expect(looksLikeLorecard({ format: "someone.else" })).toBe(false)
    expect(() => lorecardToProject({ format: "loreweaver.card", format_version: 99 })).toThrow(
      /format_version/,
    )
  })
})

describe("lorecard as a pack card (engine-aligned classification)", () => {
  it("secret lore and hooks count as world machinery and leave the character half", () => {
    const project = sampleProject()
    const specs = validateProject(project).specs
    const bundle = exportNativeBundle(project, specs) as Record<string, unknown>
    const { card, warnings } = lorecardToCard(bundle)
    expect(warnings).toEqual([])

    const split = splitCard(card)
    expect(split.payloads.hooks).toBe(1)
    expect(split.payloads.secretEntries).toBe(1)
    // The typed condition rides as an @@if decorator, exactly as the engine's
    // importer-shaped entries carry it.
    const kept = split.character.characterBook
    expect(kept).toHaveLength(1)
    expect(kept.some((entry) => entry.secret === true)).toBe(false)

    const truthEntry = card.characterBook.find((entry) => entry.secret === true)
    expect(String(truthEntry?.content)).toMatch(/^@@if 证据链完整度 >= 6\n/)
  })

  it("skips junk rows with warnings instead of failing the bundle", () => {
    const { card, warnings } = lorecardToCard({
      format: "loreweaver.card",
      format_version: 0,
      name: "X",
      worldbook: [{ title: "empty" }, "not-an-object", { title: "ok", content: "fine" }],
    })
    expect(card.characterBook).toHaveLength(1)
    expect(warnings).toHaveLength(2)
  })
})
