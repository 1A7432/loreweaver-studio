import { describe, expect, it } from "vitest"
import type { ModuleVariable, PanelTemplateBlock } from "@loreweaver/protocol"
import { pickText, resolvePanelBlocks, visibleVariables } from "./templates"

const VARS: ModuleVariable[] = [
  { id: "town_fear", label: "恐慌", kind: "number", value: 6, min: 0, max: 10 },
  { id: "alarm", label: "警报", kind: "bool", value: true },
  { id: "mvu.线索.blood", label: "血迹", kind: "text", value: "已发现" },
  { id: "mvu.线索.letter", label: "信件", kind: "text", value: "未读" },
  { id: "secret", label: "暗线", kind: "number", value: 3, hidden: true } as ModuleVariable,
]

describe("pickText", () => {
  it("picks the locale with en fallback", () => {
    const text = { en: "Case Board", zh: "案情板" }
    expect(pickText(text, "zh")).toBe("案情板")
    expect(pickText(text, "zh-CN")).toBe("案情板")
    expect(pickText(text, "en")).toBe("Case Board")
    expect(pickText({ en: "Only" }, "zh")).toBe("Only")
    expect(pickText({ zh: "只有中文" }, "en")).toBe("只有中文")
    expect(pickText("plain", "zh")).toBe("plain")
    expect(pickText(undefined, "en")).toBeUndefined()
  })
})

describe("visibleVariables", () => {
  it("strips keeper-only hidden variables", () => {
    expect(visibleVariables(VARS).map((v) => v.id)).not.toContain("secret")
  })
})

describe("resolvePanelBlocks", () => {
  it("substitutes $var bindings into blocks", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        kind: "meter",
        label: { en: "Fear", zh: "恐慌" },
        value: { $var: "town_fear" },
        min: 0,
        max: 10,
      },
      { kind: "stat", label: { en: "Alarm" }, value: { $var: "alarm" } },
    ]
    const out = resolvePanelBlocks(blocks, VARS, "zh")
    expect(out).toEqual([
      { kind: "meter", label: "恐慌", value: 6, min: 0, max: 10 },
      { kind: "stat", label: "Alarm", value: true },
    ])
  })

  it("omits the whole block when a variable is absent (fail-closed)", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "meter", label: { en: "Missing" }, value: { $var: "nope" }, min: 0, max: 10 },
      { kind: "text", text: { en: "still here" } },
    ]
    const out = resolvePanelBlocks(blocks, VARS, "en")
    expect(out).toEqual([{ kind: "text", text: "still here" }])
  })

  it("omits blocks bound to hidden variables (fail-closed)", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "stat", label: { en: "Secret" }, value: { $var: "secret" } },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([])
  })

  it("omits blocks whose binding has the wrong type", () => {
    const blocks: PanelTemplateBlock[] = [
      // `alarm` is a bool — a meter cannot hold it.
      { kind: "meter", label: { en: "Alarm" }, value: { $var: "alarm" }, min: 0, max: 1 },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([])
  })

  it("expands repeat over the prefix with $leaf bindings", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        repeat: {
          prefix: "mvu.线索.",
          block: { kind: "badge", label: { $leaf: "label" } },
        },
      },
    ]
    const out = resolvePanelBlocks(blocks, VARS, "zh")
    expect(out).toEqual([
      { kind: "badge", label: "血迹" },
      { kind: "badge", label: "信件" },
    ])
  })

  it("caps repeat expansion at 32 instances and skips hidden leaves", () => {
    const many: ModuleVariable[] = Array.from({ length: 40 }, (_, i) => ({
      id: `mvu.item.${String(i).padStart(2, "0")}`,
      label: `item ${i}`,
      kind: "number" as const,
      value: i,
    }))
    const blocks: PanelTemplateBlock[] = [
      {
        repeat: {
          prefix: "mvu.item.",
          block: { kind: "stat", label: { $leaf: "id" }, value: { $leaf: "value" } },
        },
      },
    ]
    expect(resolvePanelBlocks(blocks, many, "en")).toHaveLength(32)

    const hidden = [{ ...many[0], hidden: true } as ModuleVariable, many[1]]
    expect(resolvePanelBlocks(blocks, hidden, "en")).toHaveLength(1)
  })

  it("does not nest repeat", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        repeat: {
          prefix: "mvu.线索.",
          block: {
            repeat: { prefix: "mvu.线索.", block: { kind: "divider" } },
          } as unknown as PanelTemplateBlock,
        },
      },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([])
  })

  it("resolves choices with localized labels (intent value untouched)", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        kind: "choices",
        prompt: { en: "Act?", zh: "行动?" },
        options: [{ id: "go", label: { en: "Go", zh: "前进" }, input: "向北走" }],
      },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "zh")).toEqual([
      { kind: "choices", prompt: "行动?", options: [{ id: "go", label: "前进", input: "向北走" }] },
    ])
  })

  it("caps a panel at 32 template blocks", () => {
    const blocks: PanelTemplateBlock[] = Array.from({ length: 40 }, () => ({
      kind: "divider" as const,
    }))
    expect(resolvePanelBlocks(blocks, VARS, "en")).toHaveLength(32)
  })

  it("skips unknown template kinds (additive protocol)", () => {
    const blocks = [
      { kind: "hologram", label: "?" } as unknown as PanelTemplateBlock,
      { kind: "divider" } as PanelTemplateBlock,
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([{ kind: "divider" }])
  })
})
