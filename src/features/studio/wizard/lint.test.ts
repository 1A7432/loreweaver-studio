import { describe, expect, it } from "vitest"
import { lintFields, lintProblems, lintProse, type LintRuleId } from "./lint"

/** The acceptance rule for the anti-pattern list: canned slop MUST hit, plain
 * concrete prose MUST pass. Each case names the rule it exercises. */
const SLOP: { rule: LintRuleId; text: string }[] = [
  { rule: "vagueWord", text: "她似乎有些犹豫。" },
  { rule: "vagueWord", text: "夜色仿佛一张网。" },
  { rule: "vagueWord", text: "灯影宛如水面。" },
  { rule: "cheapMetaphor", text: "她像受惊的小兽一样缩了回去。" },
  { rule: "cheapMetaphor", text: "他的心湖漾起一圈涟漪。" },
  { rule: "cheapMetaphor", text: "指尖相触,触电般收回。" },
  { rule: "microExpression", text: "他嘴角微微上扬。" },
  { rule: "microExpression", text: "她眼中闪过一丝慌乱。" },
  { rule: "microExpression", text: "他攥紧了拳,指节泛白。" },
  { rule: "microExpression", text: "瞳孔骤缩。" },
  { rule: "microExpression", text: "他喉结滚动了一下。" },
  { rule: "notButPattern", text: "这不是愤怒,而是恐惧。" },
  { rule: "innerMonologue", text: "她心想:他到底知道多少?" },
  { rule: "innerMonologue", text: "他心中暗道不好。" },
  { rule: "innerMonologue", text: "大段内心OS铺在段落里。" },
  { rule: "enFiller", text: "Her voice was barely above a whisper." },
  { rule: "enFiller", text: "A shiver ran down his spine." },
  { rule: "enFiller", text: "She felt a mix of fear and excitement." },
  { rule: "genericLooks", text: "她有一张精致的脸蛋。" },
  { rule: "genericLooks", text: "白皙的皮肤,乌黑的长发。" },
  { rule: "genericLooks", text: "水汪汪的大眼睛望着你。" },
]

/** Concrete, observable prose — the style the lint is trying to protect. */
const CLEAN: string[] = [
  "她把杯子放回桌上,杯底压住了那张字条。",
  "“第三次了。”他数着窗外的钟声,把外套搭在椅背上。",
  "金发在码头的风里打结,她用鱼线随手扎住。",
  "He counted the bolts on the door twice, then slid the chair under the handle.",
  "疤从左眉一直切到颧骨,笑的时候会歪一下。",
]

describe("lintProse", () => {
  for (const { rule, text } of SLOP) {
    it(`flags ${rule}: ${text.slice(0, 12)}…`, () => {
      const hits = lintProse(text)
      expect(hits.map((h) => h.rule)).toContain(rule)
    })
  }

  for (const text of CLEAN) {
    it(`passes clean prose: ${text.slice(0, 12)}…`, () => {
      expect(lintProse(text)).toEqual([])
    })
  }

  it("returns hits in document order with context excerpts", () => {
    const text = "他嘴角微微上扬,这不是高兴,而是挑衅。"
    const hits = lintProse(text)
    expect(hits.length).toBe(2)
    expect(hits[0].rule).toBe("microExpression")
    expect(hits[1].rule).toBe("notButPattern")
    expect(hits[0].index).toBeLessThan(hits[1].index)
    expect(hits[0].excerpt).toContain("嘴角微微上扬")
  })

  it("separates antipattern hits from generic-descriptor hits", () => {
    const hits = lintProse("精致的五官,眼底掠过一抹冷意。")
    expect(hits.find((h) => h.rule === "genericLooks")?.kind).toBe("generic")
    expect(hits.find((h) => h.rule === "microExpression")?.kind).toBe("antipattern")
  })
})

describe("lintFields", () => {
  it("maps only fields that hit, skipping blanks", () => {
    const out = lintFields({ a: "他似乎懂了。", b: "他点头,合上账本。", c: "  " })
    expect([...out.keys()]).toEqual(["a"])
  })
})

describe("lintProblems", () => {
  it("renders retry problems with the field scope and the matched span", () => {
    const problems = lintProblems(lintProse("她似乎有一张精致的脸蛋。"), "description")
    expect(problems.length).toBe(2)
    expect(problems[0]).toContain("description: ")
    expect(problems[0]).toContain("似乎")
    expect(problems.some((p) => p.includes("generic template descriptor"))).toBe(true)
  })
})
