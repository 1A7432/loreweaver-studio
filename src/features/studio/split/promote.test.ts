import { describe, expect, it } from "vitest"
import { buildSpec } from "../model"
import type { MvuLeaf } from "./mvu"
import { promoteLeaves, suggestExposePrefixes } from "./promote"

function leaf(path: string, value: unknown, description = ""): MvuLeaf {
  return { path, value, description }
}

describe("promoteLeaves — kind inference", () => {
  it("types booleans, integers, floats (rounded), and strings", () => {
    const drafts = promoteLeaves([
      leaf("alerted", true),
      leaf("好感度", 30, "范围 0-100"),
      leaf("pleasure", 0.1, "[-1,1] range"),
      leaf("mood", "calm"),
    ])

    expect(drafts[0].variable.kind).toBe("bool")
    expect(drafts[0].variable.defaultValue).toBe("true")

    expect(drafts[1].variable.kind).toBe("number")
    expect(drafts[1].variable.minimum).toBe("0")
    expect(drafts[1].variable.maximum).toBe("100")
    expect(drafts[1].notes).toContain("boundsGuessed")

    expect(drafts[2].variable.kind).toBe("number")
    expect(drafts[2].variable.defaultValue).toBe("0")
    expect(drafts[2].variable.minimum).toBe("-1")
    expect(drafts[2].variable.maximum).toBe("1")
    expect(drafts[2].notes).toContain("floatRounded")

    expect(drafts[3].variable.kind).toBe("text")
    expect(drafts[3].variable.defaultValue).toBe("calm")
  })

  it("guesses enum when the description lists options containing the value", () => {
    const [draft] = promoteLeaves([leaf("stage", "calm", "one of: calm | alerted | hunting")])
    expect(draft.variable.kind).toBe("enum")
    expect(draft.variable.options.split("\n")).toEqual(["calm", "alerted", "hunting"])
    expect(draft.notes).toContain("enumGuessed")
  })

  it("keeps untypeable leaves in the MVU tree (include:false)", () => {
    const drafts = promoteLeaves([
      leaf("tags", ["a", "b"]),
      leaf("nothing", null),
      leaf("blob", { nested: 1 }),
    ])
    expect(drafts.map((d) => d.include)).toEqual([false, false, false])
    expect(drafts[0].notes).toContain("listKept")
    expect(drafts[1].notes).toContain("nullKept")
    expect(drafts[2].notes).toContain("containerKept")
  })

  it("every included draft passes the same buildSpec validation as hand-typed vars", () => {
    const drafts = promoteLeaves([
      leaf("好感度", 30, "范围 0-100"),
      leaf("alerted", true),
      leaf("stage", "calm", "one of: calm | alerted"),
    ])
    for (const draft of drafts.filter((d) => d.include)) {
      const { spec, errors } = buildSpec(draft.variable)
      expect(errors).toEqual([])
      expect(spec).not.toBeNull()
    }
  })
})

describe("promoteLeaves — ids, labels, visibility", () => {
  it("slugs ASCII paths and assigns placeholders to pure-CJK ones", () => {
    const drafts = promoteLeaves([leaf("理.情绪状态.pleasure", 1), leaf("理.好感度", 2)])
    expect(drafts[0].variable.id).toBe("pleasure")
    expect(drafts[0].notes).not.toContain("idGenerated")
    expect(drafts[1].variable.id).toBe("var_2")
    expect(drafts[1].notes).toContain("idGenerated")
  })

  it("deduplicates colliding ids deterministically", () => {
    const drafts = promoteLeaves([leaf("a.hp", 1), leaf("b.hp", 2)])
    expect(drafts[0].variable.id).toBe("a_hp")
    expect(drafts[1].variable.id).toBe("b_hp")
    const same = promoteLeaves([leaf("hp", 1), leaf("hp", 2)])
    expect(same[1].variable.id).toBe("hp_2")
  })

  it("fills the matching bilingual label from the last path segment", () => {
    const drafts = promoteLeaves([leaf("理.好感度", 1), leaf("world.alert_level", 2)])
    expect(drafts[0].variable.labelZh).toBe("好感度")
    expect(drafts[0].variable.labelEn).toBe("")
    expect(drafts[1].variable.labelEn).toBe("alert level")
  })

  it("guesses keeper visibility from secrecy words in path or description", () => {
    const drafts = promoteLeaves([leaf("剧情.hidden_flag", 1), leaf("好感度", 2, "player-facing affection")])
    expect(drafts[0].variable.visibility).toBe("keeper")
    expect(drafts[1].variable.visibility).toBe("player")
  })
})

describe("suggestExposePrefixes", () => {
  it("collects top-level segments of player paths, deduplicated in order", () => {
    const drafts = promoteLeaves([
      leaf("理.好感度", 1),
      leaf("理.情绪", 2),
      leaf("世界.天气", "sunny"),
      leaf("秘密.hidden_flag", true),
    ])
    expect(suggestExposePrefixes(drafts)).toEqual(["理", "世界"])
  })
})
