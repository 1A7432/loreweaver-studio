import { describe, expect, it } from "vitest"
import type { ModuleVariable } from "@loreweaver/protocol"
import { addVarCommand, isWritable, setVarCommand, stepFor } from "./varCommands"

function variable(patch: Partial<ModuleVariable>): ModuleVariable {
  return { id: "fear", label: "Fear", kind: "number", value: 3, ...patch }
}

describe("setVarCommand", () => {
  it("builds the line the engine's own parser reads", () => {
    expect(setVarCommand("fear", 7)).toBe(".var set fear 7")
    expect(setVarCommand("真相进度", 2)).toBe(".var set 真相进度 2")
    expect(setVarCommand("seen", true)).toBe(".var set seen true")
    expect(setVarCommand("seen", false)).toBe(".var set seen false")
  })

  it("passes a text value through — the SERVER validates it against the spec", () => {
    // `set_modvar` knows the variable's kind, bounds and enum options; a second
    // opinion here could only ever be a wronger one.
    expect(setVarCommand("stage", "  风暴  ")).toBe(".var set stage 风暴")
    expect(setVarCommand("stage", "not an option")).toBe(".var set stage not an option")
  })
})

describe("addVarCommand", () => {
  it("emits integer deltas only", () => {
    // `cmd_var` runs the payload through `coerce_int`, so anything else fails.
    expect(addVarCommand("fear", 1)).toBe(".var add fear 1")
    expect(addVarCommand("fear", -2)).toBe(".var add fear -2")
    expect(addVarCommand("fear", 1.7)).toBe(".var add fear 1")
  })

  it("refuses a no-op rather than reporting a change that did not happen", () => {
    expect(addVarCommand("fear", 0)).toBeNull()
    expect(addVarCommand("fear", Number.NaN)).toBeNull()
  })
})

describe("isWritable", () => {
  it("allows a hidden variable — hiding governs who SEES it, not who sets it", () => {
    expect(isWritable(variable({ hidden: true }))).toBe(true)
  })

  it("refuses an id the command's own tokenizer could not carry", () => {
    expect(isWritable(variable({ id: "" }))).toBe(false)
    expect(isWritable(variable({ id: "two words" }))).toBe(false)
  })
})

describe("stepFor", () => {
  it("steps a number by one in each direction", () => {
    expect(stepFor(variable({}), 1)).toBe(1)
    expect(stepFor(variable({}), -1)).toBe(-1)
  })

  it("stops at a declared bound instead of asking for a clamp", () => {
    // `core.modvars` would clamp and report a change of nothing.
    expect(stepFor(variable({ value: 10, max: 10 }), 1)).toBeNull()
    expect(stepFor(variable({ value: 10, max: 10 }), -1)).toBe(-1)
    expect(stepFor(variable({ value: 0, min: 0 }), -1)).toBeNull()
    expect(stepFor(variable({ value: 0, min: 0 }), 1)).toBe(1)
  })

  it("offers no step for a kind that has no arithmetic", () => {
    expect(stepFor(variable({ kind: "bool", value: true }), 1)).toBeNull()
    expect(stepFor(variable({ kind: "text", value: "x" }), 1)).toBeNull()
    expect(stepFor(variable({ kind: "enum", value: "calm" }), 1)).toBeNull()
  })
})
