import { describe, expect, it } from "vitest"
import { flattenLeaves, isInitvarEntry, isValueWithDesc, leafValue, parseInitvar } from "./mvu"

describe("isInitvarEntry", () => {
  it("matches the case-insensitive substring, decorated titles included", () => {
    expect(isInitvarEntry("[InitVar]")).toBe(true)
    expect(isInitvarEntry("「[initvar]变量初始化」")).toBe(true)
    expect(isInitvarEntry("INITVAR seed")).toBe(true)
    expect(isInitvarEntry("world lore")).toBe(false)
    expect(isInitvarEntry(42)).toBe(false)
  })
})

describe("parseInitvar (JSON5-lite)", () => {
  it("parses strict JSON with CJK keys", () => {
    expect(parseInitvar('{"理": {"好感度": [10, "0..100"]}}')).toEqual({
      理: { 好感度: [10, "0..100"] },
    })
  })

  it("tolerates comments, trailing commas, single quotes, and bare keys", () => {
    const text = `{
      // a line comment
      mood: 'calm', /* block */
      "url": 'https://example.com//path',
      nested: { a: 1, },
    }`
    expect(parseInitvar(text)).toEqual({
      mood: "calm",
      url: "https://example.com//path",
      nested: { a: 1 },
    })
  })

  it("re-escapes quotes when converting single-quoted strings", () => {
    expect(parseInitvar(`{a: 'say "hi" and \\'bye\\''}`)).toEqual({ a: `say "hi" and 'bye'` })
  })

  it("degrades to null on unrecoverable input or a non-object top level", () => {
    expect(parseInitvar("not json at all {{{")).toBeNull()
    expect(parseInitvar("[1, 2]")).toBeNull()
    expect(parseInitvar("   ")).toBeNull()
    expect(parseInitvar("/* unterminated")).toBeNull()
  })
})

describe("ValueWithDescription", () => {
  it("recognizes exactly the two-element [value, string] shape", () => {
    expect(isValueWithDesc([1, "desc"])).toBe(true)
    expect(isValueWithDesc(["a", "b"])).toBe(true)
    expect(isValueWithDesc([1, 2])).toBe(false)
    expect(isValueWithDesc([1, "d", 3])).toBe(false)
    expect(leafValue([5, "x"])).toBe(5)
    expect(leafValue("plain")).toBe("plain")
  })
})

describe("flattenLeaves", () => {
  it("walks depth-first keeping descriptions, scalar lists as one leaf", () => {
    const { leaves, truncated } = flattenLeaves({
      理: {
        情绪: { pleasure: [0.1, "[-1,1] updates on emotion change"] },
        标签: ["a", "b", "c"],
      },
      flag: true,
    })
    expect(truncated).toBe(false)
    expect(leaves).toEqual([
      { path: "理.情绪.pleasure", value: 0.1, description: "[-1,1] updates on emotion change" },
      { path: "理.标签", value: ["a", "b", "c"], description: "" },
      { path: "flag", value: true, description: "" },
    ])
  })

  it("treats a two-string list as ValueWithDescription — upstream's own ambiguity", () => {
    // ["a", "b"] is indistinguishable from the wrapped form by construction;
    // the engine resolves it as value "a" + description "b", and so do we.
    const { leaves } = flattenLeaves({ 标签: ["a", "b"] })
    expect(leaves).toEqual([{ path: "标签", value: "a", description: "b" }])
  })

  it("recurses into lists that hold containers with numeric segments", () => {
    const { leaves } = flattenLeaves({ npcs: [{ hp: 3 }, { hp: 5 }] })
    expect(leaves).toEqual([
      { path: "npcs.0.hp", value: 3, description: "" },
      { path: "npcs.1.hp", value: 5, description: "" },
    ])
  })

  it("stops at the cap and reports truncation", () => {
    const tree: Record<string, unknown> = {}
    for (let i = 0; i < 10; i++) tree[`k${i}`] = i
    const { leaves, truncated } = flattenLeaves(tree, 3)
    expect(leaves).toHaveLength(3)
    expect(truncated).toBe(true)
  })
})
