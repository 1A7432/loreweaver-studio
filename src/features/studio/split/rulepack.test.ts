import { describe, expect, it } from "vitest"
import { readRulepack, RULEPACK_SECTIONS } from "./rulepack"

function keys(yamlText: string): string[] {
  return readRulepack(yamlText).issues.map((issue) => issue.key)
}

/** The shape of the engine's own bundled CoC7 pack, trimmed. */
const REAL_PACK = `names: [CoC7, 克苏鲁的呼唤]
set_keys: [coc7, coc]
defaults:
  力量: 50
  体质: 50
  体型: 50
  意志: 50
  理智: 50
alias:
  力量: [STR, str]
derived:
  体力:
    floor_div: {of: 体质, by: 10}
  幸运:
    copy_of: 意志
  伤害加值:
    sum_ranges:
      of: [力量, 体型]
      ranges: [[2, 64, "-2"], [65, 84, "-1"]]
  移动力:
    expr: "if(力量 > 体型, 8, 7)"
resolution:
  version: 1
  roll: 1d100
  target: skill
  compare: "<="
  ranks:
    - {id: crit, when: "roll == 1", success: true, critical: true, tier: 3}
    - {id: regular, when: "roll <= target", success: true, tier: 2}
    - {id: fail, tier: 1}
initiative:
  roll: "1d100 + {敏捷}"
sheet:
  sections: []
`

describe("readRulepack", () => {
  it("accepts a real system pack without complaint", () => {
    // REAL means real: this is `rulepacks/coc7.yaml`'s shape, trimmed — down to
    // the resolution ladder and the `initiative:` mapping. A fixture that
    // invents an easier shape only proves the reader agrees with the fixture.
    const reading = readRulepack(REAL_PACK)
    expect(reading.issues).toEqual([])
    expect(reading.summary).toEqual({
      extends: "",
      stats: 5,
      derived: 4,
      subsystems: 0,
      commands: 0,
      hasResolution: true,
      hasSheet: true,
      scripts: [],
    })
  })

  it("lists the rules scripts the YAML declares, from both places", () => {
    // `core/pack.py::_rulepack_script_files`: resolution.script and every
    // subsystems.*.script, deduped and sorted, each a bare name.
    const reading = readRulepack(
      "resolution:\n  script: grade.js\nsubsystems:\n  chase:\n    script: chase.js\n  duel:\n    script: grade.js\n",
    )
    expect(reading.summary.scripts).toEqual(["chase.js", "grade.js"])
    expect(reading.issues.map((issue) => issue.key)).not.toContain("rulepackScriptBareName")
  })

  it("refuses a script name with a path in it", () => {
    expect(keys("resolution:\n  script: ../grade.js\n")).toContain("rulepackScriptBareName")
    expect(keys("subsystems:\n  chase:\n    script: sub/dir.js\n")).toContain("rulepackScriptBareName")
  })

  it("accepts the patch shape the pack bench has always emitted", () => {
    const reading = readRulepack("extends: coc7\ndefaults:\n  理智: 45\n")
    expect(reading.issues).toEqual([])
    expect(reading.summary.extends).toBe("coc7")
  })

  it("reports YAML syntax with the line the parser objected at", () => {
    const issues = readRulepack("defaults:\n  a: 1\n : : :\n").issues
    expect(issues[0].key).toBe("rulepackYamlAt")
    expect(issues[0].params?.line).toBeGreaterThan(0)
  })

  it("refuses anchors the way the engine's loader does", () => {
    expect(keys("a: &x 1\nb: *x\n")).toEqual(["rulepackAlias"])
  })

  it("flags an unknown top-level section as the typo it usually is", () => {
    // The engine IGNORES unknown sections rather than failing, which is exactly
    // why a typo here is invisible until the rule silently does nothing.
    expect(keys("extends: coc7\ndefualts:\n  理智: 45\n")).toContain("rulepackUnknownSection")
  })

  it("knows every section the engine reads", () => {
    const all = RULEPACK_SECTIONS.map((section) => `${section}: {}`).join("\n")
    expect(keys(all)).not.toContain("rulepackUnknownSection")
  })

  it("checks each section's container type", () => {
    expect(keys("defaults: [1, 2]\n")).toContain("rulepackSectionMapping")
    expect(keys("names: {a: 1}\n")).toContain("rulepackSectionList")
    expect(keys("extends: [coc7]\n")).toContain("rulepackExtendsType")
    expect(keys("alias:\n  力量: STR\n")).toContain("rulepackAliasList")
    expect(keys("defaults:\n  力量: {a: 1}\n")).toContain("rulepackDefaultScalar")
  })

  describe("initiative", () => {
    it("requires the mapping the engine requires, and accepts nothing else", () => {
      // `_parse_initiative_section` raises unless this is a Mapping whose
      // `roll` is a non-empty string. Reading it the other way round — which
      // this once did — reddens the only valid form and greens every invalid
      // one, which is worse than not checking at all.
      expect(keys("initiative:\n  roll: 1d20+DEX\n")).not.toContain("rulepackInitiativeRoll")
      expect(keys("initiative: 1d20+DEX\n")).toContain("rulepackInitiativeRoll")
      expect(keys("initiative: {}\n")).toContain("rulepackInitiativeRoll")
      expect(keys("initiative:\n  roll: '  '\n")).toContain("rulepackInitiativeRoll")
      expect(keys("initiative:\n  roll: 12\n")).toContain("rulepackInitiativeRoll")
    })

    it("says nothing when the section is absent", () => {
      expect(keys("extends: coc7\n")).not.toContain("rulepackInitiativeRoll")
    })
  })

  describe("derived specs", () => {
    it("requires a spec to name one of the engine's operations", () => {
      expect(keys("defaults: {a: 1}\nderived:\n  x:\n    doubled_of: a\n")).toContain("rulepackDerivedOp")
      expect(keys("defaults: {a: 1}\nderived:\n  x: 5\n")).toContain("rulepackDerivedMapping")
    })

    it("warns that computer/computer_group need code the engine does not ship", () => {
      expect(keys("defaults: {a: 1}\nderived:\n  x:\n    computer: my_thing\n")).toContain(
        "rulepackDerivedComputer",
      )
      expect(keys("derived:\n  x:\n    computer_group: my_group\n")).toContain("rulepackDerivedComputer")
    })

    it("checks the two-parameter primitives", () => {
      expect(keys("defaults: {a: 1}\nderived:\n  x:\n    floor_div: {of: a}\n")).toContain(
        "rulepackDerivedFloorDiv",
      )
      expect(keys("defaults: {a: 1}\nderived:\n  x:\n    sum_ranges: {of: [a]}\n")).toContain(
        "rulepackDerivedSumRanges",
      )
    })

    it("checks an expr spec's keys and its text", () => {
      const bad = keys('defaults: {a: 1}\nderived:\n  x:\n    expr: ""\n    fmt: "{}"\n')
      expect(bad).toContain("rulepackDerivedExprKeys")
      expect(bad).toContain("rulepackDerivedExprText")
      expect(keys('defaults: {a: 1}\nderived:\n  x:\n    expr: "a * 2"\n    format: "{}"\n')).toEqual([])
    })

    it("names a stat the pack never declares — the engine silently reads it as 0", () => {
      const issues = readRulepack("defaults: {力量: 50}\nderived:\n  x:\n    copy_of: 意志\n").issues
      expect(issues.map((issue) => issue.key)).toContain("rulepackDerivedUnknownStat")
      expect(issues[0].params).toMatchObject({ stat: "x", of: "意志" })
    })
  })

  it("checks turn_checks rows against the engine's key set", () => {
    const issues = keys("turn_checks:\n  - when: san_low\n    instructoin: {en: x}\n  - {id: a}\n")
    expect(issues).toContain("rulepackTurnCheckKey")
    expect(issues).toContain("rulepackTurnCheckWhen")
  })

  it("says so when a pack neither extends nor defines anything", () => {
    expect(keys("names: [Mine]\n")).toContain("rulepackThin")
    expect(keys("")).toEqual([])
  })
})
