import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { checkPanelsText } from "./panelsCheck"
import { migratePanelsYaml } from "./panelsMigrate"

describe("migratePanelsYaml", () => {
  it("translates what maps mechanically, and the result is panels 3.0 the checks accept", () => {
    const old = `panels:
  - id: hud
    title: {en: HUD, zh: 状态板}
    slot: sidebar
    audience: keeper
    blocks:
      - {kind: meter, label: Fear, value: {$var: fear}, min: 0, max: 10, visible_when: "day >= 3 && fear > 1"}
      - repeat: {prefix: "clue.", block: {kind: stat, label: {$leaf: id}, value: {$leaf: value}}}
`
    const migrated = migratePanelsYaml(old)
    expect(migrated.legacy).toBe(true)
    expect(migrated.leftover).toBe(false)
    expect(checkPanelsText(migrated.yamlText).problems).toEqual([])
    const panel = (parse(migrated.yamlText) as { panels: Record<string, unknown>[] }).panels[0]
    expect(panel.audience).toBe("admin")
    expect(panel.views).toEqual({ vars: "variables" })
    expect(panel.blocks).toEqual([
      {
        kind: "meter",
        label: "Fear",
        value: { $view: "vars.module.fear.value" },
        min: 0,
        max: 10,
        visible_when: "vars.module.day.value >= 3 && vars.module.fear.value > 1",
      },
      {
        repeat: {
          each: "vars.tree",
          as: "leaf",
          prefix: "clue.",
          block: { kind: "stat", label: { $view: "leaf.path" }, value: { $view: "leaf.value" } },
        },
      },
    ])
  })

  it("leaves what does not map as written, and says so", () => {
    const old = `panels:
  - id: hud
    title: HUD
    slot: sidebar
    blocks:
      - {kind: stat, label: HP, value: {$var: mvu.party.hp}}
      - repeat: {prefix: "clue.", block: {kind: badge, label: {$leaf: label}}}
      - kind: choices
        options: [{id: look, label: Look, input: ".look"}]
`
    const migrated = migratePanelsYaml(old)
    expect(migrated.legacy).toBe(true)
    expect(migrated.leftover).toBe(true)
    expect(migrated.yamlText).toContain("$var: mvu.party.hp")
    expect(migrated.yamlText).toContain("$leaf: label")
    expect(migrated.yamlText).toContain("input: .look")
    expect(checkPanelsText(migrated.yamlText).problems.map((problem) => problem.code)).toContain(
      "replaced_2x",
    )
  })

  it("leaves a 3.0 file, and an unreadable one, alone", () => {
    const current = "panels:\n  - {id: a, title: A, slot: sidebar, blocks: [{kind: divider}]}\n"
    expect(migratePanelsYaml(current)).toEqual({ yamlText: current, legacy: false, leftover: false })
    expect(migratePanelsYaml("panels: [").legacy).toBe(false)
  })
})
