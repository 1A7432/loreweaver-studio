import { describe, expect, it } from "vitest"
import { hooksFromUpdateRules, NO_RULES_MARKER, parseUpdateRules } from "./updateRules"

const INITVAR = `理:
  好感度: [0, "对玩家的好感 [0,100]"]
  见过雾: [false, "是否见过港雾"]
`

describe("parseUpdateRules", () => {
  it("reads the shapes authors actually write, full-width punctuation included", () => {
    const rules = parseUpdateRules(
      "好感度: 玩家帮忙 +5\n见过雾：进入雾区 置 true\n信任: 实质帮助 +1;撒谎被识破 -2",
    )
    expect(rules.map((rule) => rule.name)).toEqual(["好感度", "见过雾", "信任"])
    expect(rules[0].clauses).toEqual([{ trigger: "玩家帮忙", op: { kind: "inc", by: 5 } }])
    expect(rules[1].clauses).toEqual([{ trigger: "进入雾区", op: { kind: "set", value: true } }])
    expect(rules[2].clauses).toEqual([
      { trigger: "实质帮助", op: { kind: "inc", by: 1 } },
      { trigger: "撒谎被识破", op: { kind: "inc", by: -2 } },
    ])
  })

  it("resolves a leaf name to its full dotted path when it is unambiguous", () => {
    const [rule] = parseUpdateRules("好感度: 玩家帮忙 +5", INITVAR)
    expect(rule.path).toBe("理.好感度")
  })

  it("leaves an ambiguous or unknown name exactly as written", () => {
    // Writing into the wrong `好感度` would be worse than writing into a name
    // the author can see is wrong.
    const twice = `甲:\n  好感度: 0\n乙:\n  好感度: 0\n`
    expect(parseUpdateRules("好感度: x +1", twice)[0].path).toBe("好感度")
    expect(parseUpdateRules("不存在: x +1", INITVAR)[0].path).toBe("不存在")
  })

  it("types set values instead of quoting everything", () => {
    const rules = parseUpdateRules("a: t 置 true\nb: t 设为 3\nc: t = 风暴\nd: t → 假")
    expect(rules.map((rule) => rule.clauses[0].op)).toEqual([
      { kind: "set", value: true },
      { kind: "set", value: 3 },
      { kind: "set", value: "风暴" },
      { kind: "set", value: false },
    ])
  })

  it("keeps a line it cannot parse rather than dropping the author's words", () => {
    const rules = parseUpdateRules("好感度随剧情自然起伏")
    expect(rules).toHaveLength(1)
    expect(rules[0].clauses).toEqual([])
    expect(rules[0].source).toBe("好感度随剧情自然起伏")
  })
})

describe("hooksFromUpdateRules", () => {
  it("emits real setvar/incvar calls against the resolved paths", () => {
    const code = hooksFromUpdateRules("好感度: 玩家帮忙 +5\n见过雾: 进入雾区置 true", INITVAR)
    expect(code).toContain(`if (said("玩家帮忙")) incvar("理.好感度", 5)`)
    expect(code).toContain(`if (said("进入雾区")) setvar("理.见过雾", true)`)
    // Labelled a draft either way, per the wizard's own promise.
    expect(code).toContain("a DRAFT")
    // …and the source line survives as a comment next to the code it became.
    expect(code).toContain("// 好感度: 玩家帮忙 +5")
  })

  it("emits an unguarded call when the rule names no trigger", () => {
    expect(hooksFromUpdateRules("好感度: +1")).toContain(`  incvar("好感度", 1)`)
  })

  it("is valid JavaScript that runs and moves the variables", () => {
    // The point of the whole change: not a shape that looks like code, code.
    const code = hooksFromUpdateRules("好感度: 玩家帮忙 +5;背叛 -3\n见过雾: 进入雾区置 true", INITVAR)
    const calls: [string, unknown][] = []
    const handlers: Record<string, (event: unknown) => void> = {}
    const sandbox = new Function("on", "setvar", "incvar", code) as (
      on: (event: string, fn: (event: unknown) => void) => void,
      setvar: (id: string, value: unknown) => void,
      incvar: (id: string, by: unknown) => void,
    ) => void
    sandbox(
      (event, fn) => {
        handlers[event] = fn
      },
      (id, value) => calls.push([id, value]),
      (id, by) => calls.push([id, by]),
    )
    handlers.reply_ready({ text: "玩家帮忙拉起了缆绳，随后一行人进入雾区。" })
    expect(calls).toEqual([
      ["理.好感度", 5],
      ["理.见过雾", true],
    ])

    calls.length = 0
    handlers.reply_ready({ text: "他背叛了同伴。" })
    expect(calls).toEqual([["理.好感度", -3]])
  })

  it("survives a handler call with no event at all", () => {
    const code = hooksFromUpdateRules("好感度: 玩家帮忙 +5")
    const handlers: Record<string, (event?: unknown) => void> = {}
    const sandbox = new Function("on", "setvar", "incvar", code) as (
      on: (event: string, fn: (event?: unknown) => void) => void,
      setvar: () => void,
      incvar: () => void,
    ) => void
    sandbox(
      (event, fn) => {
        handlers[event] = fn
      },
      () => {},
      () => {},
    )
    expect(() => handlers.reply_ready()).not.toThrow()
  })

  it("falls back to the stub only when there is nothing to compile", () => {
    expect(hooksFromUpdateRules("")).toContain(NO_RULES_MARKER)
    expect(hooksFromUpdateRules("   \n\n")).toContain(NO_RULES_MARKER)
  })

  it("carries unparseable rules through verbatim instead of silently dropping them", () => {
    const code = hooksFromUpdateRules("好感度随剧情自然起伏\n信任由 keeper 判断")
    expect(code).toContain("// 好感度随剧情自然起伏")
    expect(code).toContain("// 信任由 keeper 判断")
    expect(code).not.toContain(NO_RULES_MARKER)
  })
})
