import { describe, expect, it } from "vitest"
import {
  buildSpec,
  MAX_OPTIONS,
  MAX_TEXT_LEN,
  MAX_VARS,
  newLoreEntry,
  newProject,
  newVariable,
  normalizeVarId,
  validateProject,
  type ForgeVariable,
} from "./model"

function variable(patch: Partial<ForgeVariable>): ForgeVariable {
  return { ...newVariable(), ...patch }
}

describe("normalizeVarId", () => {
  it("mirrors the engine: spaces/hyphens to underscores, lowercased", () => {
    expect(normalizeVarId("  Town Fear ")).toBe("town_fear")
    expect(normalizeVarId("doom-clock")).toBe("doom_clock")
  })
})

describe("buildSpec", () => {
  it("builds an engine-shaped spec for a bounded number", () => {
    const { spec, errors } = buildSpec(
      variable({
        id: "Suspicion",
        kind: "number",
        labelEn: "Suspicion",
        labelZh: "怀疑度",
        minimum: "0",
        maximum: "10",
      }),
    )
    expect(errors).toHaveLength(0)
    expect(spec).toEqual({
      id: "suspicion",
      kind: "number",
      visibility: "player",
      labels: { en: "Suspicion", zh: "怀疑度" },
      default: 0,
      minimum: 0,
      maximum: 10,
    })
  })

  it("clamps an out-of-bounds default into range", () => {
    const { spec } = buildSpec(
      variable({ id: "fear", kind: "number", minimum: "0", maximum: "10", defaultValue: "99" }),
    )
    expect(spec?.default).toBe(10)
  })

  it("accepts non-ASCII ids the engine accepts (CJK/Cyrillic are first-class since M14)", () => {
    // Ground truth: core.modvars.normalize_id('почему') == 'почему', '视线' == '视线'.
    expect(buildSpec(variable({ id: "почему" })).errors).toEqual([])
    expect(buildSpec(variable({ id: "视线", minimum: "0", maximum: "10" })).spec?.id).toBe("视线")
  })

  it("rejects bad ids, reversed bounds, and non-integer bounds", () => {
    // Zero-width space is category Cf — the engine's _valid_id refuses Z*/C*.
    expect(buildSpec(variable({ id: "​zero" })).errors).toContainEqual({ key: "idInvalid" })
    expect(buildSpec(variable({ id: "x".repeat(65) })).errors).toContainEqual({ key: "idInvalid" })
    expect(buildSpec(variable({ id: "x", minimum: "5", maximum: "1" })).errors).toContainEqual({
      key: "boundsOrder",
    })
    expect(buildSpec(variable({ id: "x", minimum: "1.5" })).errors).toContainEqual({
      key: "boundNotInt",
    })
  })

  it("dedups enum options case-insensitively, caps them, defaults to the first", () => {
    const { spec, errors } = buildSpec(
      variable({ id: "phase", kind: "enum", options: "Calm\ncalm\nAlerted" }),
    )
    expect(errors).toHaveLength(0)
    expect(spec?.options).toEqual(["Calm", "Alerted"])
    expect(spec?.default).toBe("Calm")

    const many = Array.from({ length: MAX_OPTIONS + 5 }, (_, i) => `opt${i}`).join("\n")
    expect(buildSpec(variable({ id: "big", kind: "enum", options: many })).spec?.options).toHaveLength(
      MAX_OPTIONS,
    )
    expect(buildSpec(variable({ id: "none", kind: "enum", options: " " })).errors).toContainEqual({
      key: "optionsRequired",
    })
  })

  it("matches enum defaults case-insensitively to the canonical option", () => {
    const { spec } = buildSpec(
      variable({ id: "phase", kind: "enum", options: "Calm\nAlerted", defaultValue: "alerted" }),
    )
    expect(spec?.default).toBe("Alerted")
  })

  it("coerces bool defaults and truncates text defaults", () => {
    expect(buildSpec(variable({ id: "b", kind: "bool", defaultValue: "yes" })).spec?.default).toBe(true)
    expect(buildSpec(variable({ id: "b", kind: "bool", defaultValue: "maybe" })).errors).toContainEqual({
      key: "defaultInvalid",
    })
    const long = "x".repeat(MAX_TEXT_LEN + 50)
    expect(
      (buildSpec(variable({ id: "t", kind: "text", defaultValue: long })).spec?.default as string).length,
    ).toBe(MAX_TEXT_LEN)
  })
})

describe("validateProject", () => {
  it("flags duplicate ids, missing names, and the variable cap", () => {
    const project = newProject("")
    project.variables = [
      variable({ id: "fear" }),
      variable({ id: "Fear" }), // normalizes to the same id
    ]
    const result = validateProject(project)
    expect(result.project).toContainEqual({ key: "nameRequired" })
    expect([...result.variables.values()].flat()).toContainEqual({
      key: "idDuplicate",
      params: { id: "fear" },
    })
    expect(result.specs).toHaveLength(1)

    const crowded = newProject("x")
    crowded.variables = Array.from({ length: MAX_VARS + 1 }, (_, i) => variable({ id: `v${i}` }))
    expect(validateProject(crowded).project).toContainEqual({
      key: "tooManyVariables",
      params: { max: MAX_VARS },
    })
  })

  it("flags empty entries and over-long conditions", () => {
    const project = newProject("x")
    const empty = newLoreEntry()
    const long = { ...newLoreEntry(), title: "ok", condition: "x".repeat(501) }
    project.lorebook = [empty, long]
    const result = validateProject(project)
    expect(result.lorebook.get(empty.uid)).toContainEqual({ key: "entryEmpty" })
    expect(result.lorebook.get(long.uid)).toContainEqual({
      key: "conditionTooLong",
      params: { max: 500 },
    })
  })
})
