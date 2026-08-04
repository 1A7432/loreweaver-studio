import { describe, expect, it } from "vitest"
import { carryManualSlots, gateGuidance, stageGate, type StageGateContext } from "./schemas"
import type { StageDraft } from "./stages"

const ctx: StageGateContext = { path: "large", characterName: "阿理" }

describe("stageGate: worldview", () => {
  it("accepts entries, defaults the layer from keys, keeps the UI-chosen path", () => {
    const result = stageGate("worldview", { ...ctx, path: "small" })({
      entries: [
        { title: "港镇", content: "雾不散。", keys: [] },
        { title: "灯塔", content: "只亮半边。", keys: ["灯塔", "lighthouse"], secret: true },
      ],
    })
    expect(result.problems).toEqual([])
    const value = result.value as Extract<StageDraft, { stage: "worldview" }>
    expect(value.path).toBe("small")
    expect(value.entries[0].layer).toBe("constant")
    expect(value.entries[1].layer).toBe("triggered")
    expect(value.entries[1].secret).toBe(true)
    expect(value.entries[0].slot).toBe("wv:0")
    expect(value.entries[0].sourceLabel).toBe("worldview")
  })

  it("rejects a triggered entry without keys and a large world without a constant core", () => {
    const result = stageGate(
      "worldview",
      ctx,
    )({
      entries: [{ title: "碎片", content: "内容", layer: "triggered", keys: [] }],
    })
    expect(result.value).toBeNull()
    expect(result.problems.some((p) => p.includes("trigger keyword"))).toBe(true)
    expect(result.problems.some((p) => p.includes("constant core"))).toBe(true)
  })
})

describe("stageGate: palette (mandatory-manual defense)", () => {
  it("DISCARDS any model-written derivation — the handwritten slot stays empty", () => {
    const result = stageGate(
      "palette",
      ctx,
    )({
      base: { name: "自卑", detail: "从不先开口。", derivation: "模型代写的衍生,必须被丢弃" },
      mains: [{ name: "好胜", detail: "输了会加练。", derivation: "模型代写,必须被丢弃" }],
      accent: null,
    })
    expect(result.problems).toEqual([])
    const value = result.value as Extract<StageDraft, { stage: "palette" }>
    expect(value.base.derivation).toBe("")
    expect(value.mains[0].derivation).toBe("")
  })

  it("rejects zero or three main colors", () => {
    expect(stageGate("palette", ctx)({ base: { name: "b" }, mains: [] }).value).toBeNull()
    expect(
      stageGate("palette", ctx)({ base: { name: "b" }, mains: [{ name: "1" }, { name: "2" }, { name: "3" }] })
        .value,
    ).toBeNull()
  })
})

describe("stageGate: nsfw (mandatory-manual defense)", () => {
  it("DISCARDS any model-written motivation and forces entries secret at apply time", () => {
    const result = stageGate(
      "nsfw",
      ctx,
    )({
      motivation: "模型代写的动机,必须被丢弃",
      entries: [{ title: "边界", content: "永远不在船上。", keys: ["船"] }],
    })
    expect(result.problems).toEqual([])
    const value = result.value as Extract<StageDraft, { stage: "nsfw" }>
    expect(value.motivation).toBe("")
    expect(value.entries[0].layer).toBe("triggered")
  })
})

describe("stageGate: npcs / wardrobe empty-is-valid", () => {
  it("accepts an empty npc list and defaults keys to the npc name", () => {
    expect(stageGate("npcs", ctx)({ npcs: [] }).value).not.toBeNull()
    const result = stageGate("npcs", ctx)({ npcs: [{ name: "老陈", role: "船工", content: "欠了钱。" }] })
    const value = result.value as Extract<StageDraft, { stage: "npcs" }>
    expect(value.npcs[0].keys).toEqual(["老陈"])
  })

  it("rejects duplicate npc names", () => {
    const result = stageGate(
      "npcs",
      ctx,
    )({
      npcs: [
        { name: "老陈", content: "a" },
        { name: "老陈", content: "b" },
      ],
    })
    expect(result.value).toBeNull()
    expect(result.problems.some((p) => p.includes("duplicate"))).toBe(true)
  })

  it("labels wardrobe entries with the character name", () => {
    const result = stageGate(
      "wardrobe",
      ctx,
    )({
      entries: [{ title: "工装", content: "袖口磨破。", keys: ["工装", "阿理"] }],
    })
    const value = result.value as Extract<StageDraft, { stage: "wardrobe" }>
    expect(value.entries[0].sourceLabel).toBe("阿理")
  })
})

describe("stageGate: opening", () => {
  it("reads mes_example and caps alternate greetings at three", () => {
    const result = stageGate(
      "opening",
      ctx,
    )({
      first_mes: "钟敲了四下。",
      mes_example: "<START>\nuser: 谁?\nchar: “挪开。”",
      alternate_greetings: ["一", "二", "", "三", "四"],
    })
    expect(result.problems).toEqual([])
    const value = result.value as Extract<StageDraft, { stage: "opening" }>
    expect(value.mesExample).toContain("<START>")
    expect(value.alternateGreetings).toEqual(["一", "二", "三"])
  })

  it("still requires first_mes", () => {
    expect(stageGate("opening", ctx)({ mes_example: "x" }).value).toBeNull()
  })
})

describe("stageGate: variables", () => {
  it("accepts parseable InitVar YAML with promotable leaves", () => {
    const result = stageGate(
      "variables",
      ctx,
    )({
      initvar_yaml: "理:\n  好感度: [0, '好感 [0,100]']\n  阶段: [平静, '可选值: 平静|风暴']\n",
      update_rules: "好感度:玩家帮忙 +5",
    })
    expect(result.problems).toEqual([])
    const value = result.value as Extract<StageDraft, { stage: "variables" }>
    expect(value.updateRules).toContain("好感度")
  })

  it("rejects unparseable YAML and scalar-free trees", () => {
    expect(stageGate("variables", ctx)({ initvar_yaml: "a: [unclosed" }).value).toBeNull()
    // Scalar lists stay in the MVU tree (include:false) and null leaves are
    // dropped — a tree made only of those has nothing to promote.
    const empty = stageGate("variables", ctx)({ initvar_yaml: "a:\n  b: [x, y]\n  c: null\n" })
    expect(empty.value).toBeNull()
  })
})

describe("stageGate: exegesis has no AI pass", () => {
  it("always refuses — the stage is handwritten-only", () => {
    expect(stageGate("exegesis", ctx)({ text: "任何内容" }).value).toBeNull()
  })
})

describe("gateGuidance", () => {
  it("accepts questions plus one example, rejects empty question lists", () => {
    const ok = gateGuidance({ questions: ["她最怕谁看见她哭?", "输给谁她会笑?"], example: "另一角色示例" })
    expect(ok.value?.questions).toHaveLength(2)
    expect(gateGuidance({ questions: [] }).value).toBeNull()
  })
})

describe("carryManualSlots", () => {
  it("re-attaches palette derivations by color name across a re-structuring", () => {
    const prev: StageDraft = {
      stage: "palette",
      base: { name: "自卑", detail: "", derivation: "" },
      mains: [
        { name: "好胜", detail: "旧描述", derivation: "手写衍生A" },
        { name: "护短", detail: "旧", derivation: "手写衍生B" },
      ],
      accent: null,
    }
    const next: StageDraft = {
      stage: "palette",
      base: { name: "自卑", detail: "新", derivation: "" },
      mains: [
        { name: "护短", detail: "新描述", derivation: "" },
        { name: "好胜", detail: "新描述", derivation: "" },
      ],
      accent: null,
    }
    const merged = carryManualSlots(prev, next) as Extract<StageDraft, { stage: "palette" }>
    expect(merged.mains[0]).toMatchObject({ name: "护短", derivation: "手写衍生B" })
    expect(merged.mains[1]).toMatchObject({ name: "好胜", derivation: "手写衍生A" })
  })

  it("carries the nsfw motivation verbatim", () => {
    const prev: StageDraft = { stage: "nsfw", motivation: "作者手写的为什么", entries: [] }
    const next: StageDraft = { stage: "nsfw", motivation: "", entries: [] }
    expect((carryManualSlots(prev, next) as Extract<StageDraft, { stage: "nsfw" }>).motivation).toBe(
      "作者手写的为什么",
    )
  })
})
