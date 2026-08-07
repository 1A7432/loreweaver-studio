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

describe("protocol 2.1 blocks (image + performance templates)", () => {
  const HASH = "a".repeat(64)

  it("resolves an image block's wire triple with localized caption/alt", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        kind: "image",
        hash: HASH,
        mime: "image/png",
        size: 1234,
        caption: { en: "Lantern manual, torn page", zh: "灯谱残页" },
        alt: { en: "Nine lanterns, one unlit" },
      } as PanelTemplateBlock,
    ]
    expect(resolvePanelBlocks(blocks, VARS, "zh")).toEqual([
      {
        kind: "image",
        hash: HASH,
        mime: "image/png",
        size: 1234,
        caption: "灯谱残页",
        alt: "Nine lanterns, one unlit",
      },
    ])
  })

  it("omits an image/map_pin that only carries the authored src (unaddressable fails closed)", () => {
    // The wire NEVER carries `src` — the pack build rewrites it to the
    // {hash,mime,size} triple. A hand-built fixture without a hash cannot be
    // fetched, so the block is omitted rather than half-rendered.
    const blocks = [
      { kind: "image", src: "ui/dengzhen/canlye.png", caption: { en: "x" } },
      { kind: "map_pin", src: "ui/map.png", label: { en: "dock" }, x: 0.5, y: 0.5 },
      { kind: "divider" },
    ] as unknown as PanelTemplateBlock[]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([{ kind: "divider" }])
  })

  it("resolves letter/clipping/title_card with localized + bound fields", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        kind: "letter",
        body: { en: "Meet at the pier.", zh: "码头见。" },
        from: { en: "K.", zh: "K" },
        date: { $var: "mvu.线索.blood" },
      },
      {
        kind: "clipping",
        headline: { en: "Nine lanterns vanish", zh: "九灯失踪" },
        body: { en: "The tide took them.", zh: "潮水卷走了灯。" },
        source: { en: "Pier Gazette" },
      },
      { kind: "title_card", title: { en: "The Send-Off", zh: "送灯" }, act: { en: "Act III" } },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "zh")).toEqual([
      { kind: "letter", body: "码头见。", from: "K", date: "已发现" },
      { kind: "clipping", headline: "九灯失踪", body: "潮水卷走了灯。", source: "Pier Gazette" },
      { kind: "title_card", title: "送灯", act: "Act III" },
    ])
  })

  it("omits a performance block whose required field binding misses", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "letter", body: { $var: "nope" }, from: { en: "K." } },
      { kind: "title_card", title: { en: "still here" } },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([{ kind: "title_card", title: "still here" }])
  })

  it("resolves a map_pin with bound coordinates, clamped to the image box", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        kind: "map_pin",
        hash: HASH,
        mime: "image/png",
        size: 99,
        label: { en: "Tide mark", zh: "潮位点" },
        x: { $var: "town_fear" }, // 6 → clamps to 1
        y: 0.25,
        note: { en: "where the lantern went out" },
      } as PanelTemplateBlock,
      {
        kind: "map_pin",
        hash: HASH,
        label: { en: "bad pin" },
        x: { $var: "alarm" }, // a bool is not a coordinate
        y: 0.5,
      } as PanelTemplateBlock,
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([
      {
        kind: "map_pin",
        hash: HASH,
        mime: "image/png",
        size: 99,
        label: "Tide mark",
        x: 1,
        y: 0.25,
        note: "where the lantern went out",
      },
    ])
  })
})

describe("visible_when (protocol 2.1)", () => {
  it("renders when the gate passes, omits when it says hide", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "text", text: { en: "late game" }, visible_when: "town_fear >= 5" },
      { kind: "text", text: { en: "too early" }, visible_when: "town_fear > 46" },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([{ kind: "text", text: "late game" }])
  })

  it("fails CLOSED on an unorderable comparison (evaluation error hides)", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "text", text: { en: "x" }, visible_when: "town_fear > 'abc'" },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([])
  })

  it("drops hidden variables before evaluation (a gate can never surface them)", () => {
    // `secret` is hidden for this viewer: the condition sees null, and
    // `null > 5` is an error — fail-closed, exactly like an unresolved $var.
    const blocks: PanelTemplateBlock[] = [
      { kind: "text", text: { en: "x" }, visible_when: "secret > 2" },
      { kind: "text", text: { en: "y" }, visible_when: "secret === null" },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([{ kind: "text", text: "y" }])
  })

  it("fails closed on a malformed (non-string) condition", () => {
    const blocks = [
      { kind: "text", text: { en: "x" }, visible_when: 42 },
      { kind: "text", text: { en: "y" }, visible_when: "   " },
      { kind: "text", text: { en: "z" }, visible_when: "town_fear >= 5 &&" },
    ] as unknown as PanelTemplateBlock[]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([])
  })

  it("evaluates the gate BEFORE bindings: a passing gate still omits a broken block", () => {
    const blocks: PanelTemplateBlock[] = [
      { kind: "stat", label: { en: "S" }, value: { $var: "nope" }, visible_when: "town_fear >= 5" },
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([])
  })

  it("a gate on the repeat suppresses the WHOLE expansion", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        repeat: {
          prefix: "mvu.线索.",
          block: { kind: "badge", label: { $leaf: "label" } },
        },
        visible_when: "town_fear > 46",
      } as PanelTemplateBlock,
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([])

    const shown: PanelTemplateBlock[] = [
      {
        repeat: {
          prefix: "mvu.线索.",
          block: { kind: "badge", label: { $leaf: "label" } },
        },
        visible_when: "town_fear >= 5",
      } as PanelTemplateBlock,
    ]
    expect(resolvePanelBlocks(shown, VARS, "zh")).toHaveLength(2)
  })

  it("a gate on the repeat's inner template suppresses each instance", () => {
    const blocks: PanelTemplateBlock[] = [
      {
        repeat: {
          prefix: "mvu.线索.",
          block: { kind: "badge", label: { $leaf: "label" }, visible_when: "town_fear > 46" },
        },
      } as PanelTemplateBlock,
    ]
    expect(resolvePanelBlocks(blocks, VARS, "en")).toEqual([])
  })
})
