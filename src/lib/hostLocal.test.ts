import { describe, expect, it } from "vitest"
import { hostEventApplies, mintHostId, type HostLocalEvent, type HostLocalEventKind } from "./hostLocal"

function ev(hostId: string, rest: HostLocalEventKind): HostLocalEvent {
  return { hostId, ...rest }
}

describe("hostEventApplies", () => {
  it("accepts every kind for the current hostId", () => {
    expect(hostEventApplies(ev("a", { kind: "log", level: "out", text: "x" }), "a", null)).toBe(true)
    expect(hostEventApplies(ev("a", { kind: "ready", ticket: "t", key: "k" }), "a", null)).toBe(true)
    expect(hostEventApplies(ev("a", { kind: "exit", code: 1 }), "a", null)).toBe(true)
    expect(hostEventApplies(ev("a", { kind: "error", message: "m" }), "a", null)).toBe(true)
  })

  it("drops a queued event from a previous host after a new start", () => {
    expect(hostEventApplies(ev("old", { kind: "exit", code: 1 }), "new", null)).toBe(false)
    expect(hostEventApplies(ev("old", { kind: "ready", ticket: "t", key: "k" }), "new", null)).toBe(false)
  })

  it("accepts only the confirming Exit for a stopping id", () => {
    expect(hostEventApplies(ev("stop", { kind: "exit", code: null }), null, "stop")).toBe(true)
    expect(hostEventApplies(ev("stop", { kind: "ready", ticket: "t", key: "k" }), null, "stop")).toBe(false)
    expect(hostEventApplies(ev("stop", { kind: "log", level: "out", text: "x" }), null, "stop")).toBe(false)
  })

  it("drops everything when no id is current or stopping", () => {
    expect(hostEventApplies(ev("a", { kind: "exit", code: 0 }), null, null)).toBe(false)
  })
})

describe("mintHostId", () => {
  it("returns a non-empty unique pair", () => {
    const a = mintHostId()
    const b = mintHostId()
    expect(a.length).toBeGreaterThan(0)
    expect(b.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })
})
