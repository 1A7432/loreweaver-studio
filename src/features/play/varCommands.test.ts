import { describe, expect, it } from "vitest"
import type { ViewModuleVariable } from "loreweaver-protocol/v3"
import { MAX_VAR_PATH_CHARS, addVarArgs, isWritablePath, setVarArgs, stepFor } from "./varCommands"

// The engine's view-test room's tracker (server/test/gateway/views/fixture.ts).
const MORALE: ViewModuleVariable = {
  id: "morale",
  kind: "number",
  label: "Morale",
  value: 7,
  min: 0,
  max: 10,
}

describe("setVarArgs", () => {
  it("builds the `var set` arguments, the value as text — the SERVER parses and checks it", () => {
    expect(setVarArgs("morale", 8)).toEqual({ op: "set", path: "morale", value: "8" })
    expect(setVarArgs("flag", true)).toEqual({ op: "set", path: "flag", value: "true" })
    expect(setVarArgs("mood", "  grim  ")).toEqual({ op: "set", path: "mood", value: "grim" })
  })

  it("carries a path with a space or CJK as written: it is an argument, not a token", () => {
    expect(setVarArgs("角色.好感 度", "3")).toEqual({ op: "set", path: "角色.好感 度", value: "3" })
  })
})

describe("addVarArgs", () => {
  it("builds integer deltas only, and refuses a no-op", () => {
    expect(addVarArgs("morale", 1)).toEqual({ op: "add", path: "morale", delta: 1 })
    expect(addVarArgs("morale", -2.7)).toEqual({ op: "add", path: "morale", delta: -2 })
    expect(addVarArgs("morale", 0)).toBeNull()
    expect(addVarArgs("morale", Number.NaN)).toBeNull()
  })
})

describe("isWritablePath", () => {
  it("refuses an empty path or one longer than the command takes, counted in characters", () => {
    expect(isWritablePath("morale")).toBe(true)
    expect(isWritablePath("  ")).toBe(false)
    expect(isWritablePath("𠮷".repeat(MAX_VAR_PATH_CHARS))).toBe(true)
    expect(isWritablePath("a".repeat(MAX_VAR_PATH_CHARS + 1))).toBe(false)
  })
})

describe("stepFor", () => {
  it("steps by one, and stops at a declared bound instead of asking for a clamp", () => {
    expect(stepFor(MORALE, 1)).toBe(1)
    expect(stepFor(MORALE, -1)).toBe(-1)
    expect(stepFor({ ...MORALE, value: 10 }, 1)).toBeNull()
    expect(stepFor({ ...MORALE, value: 0 }, -1)).toBeNull()
  })

  it("offers no step for a kind that has no arithmetic", () => {
    expect(stepFor({ id: "mood", kind: "text", label: "Mood", value: "grim" }, 1)).toBeNull()
  })
})
