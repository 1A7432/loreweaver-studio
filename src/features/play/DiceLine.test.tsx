import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { DiceFrame, DiceOutcome } from "@loreweaver/protocol"
import DiceLine from "./DiceLine"
import { diceOutcomeClass } from "./rank"

const outcome = (extra: Partial<DiceOutcome>): DiceOutcome => ({
  id: "regular",
  label: "Success",
  success: true,
  critical: false,
  fumble: false,
  tier: 2,
  ...extra,
})

describe("diceOutcomeClass", () => {
  it("colors by the semantic flags, matching the reference TUI", () => {
    expect(diceOutcomeClass(undefined)).toBe("rank-neutral")
    expect(diceOutcomeClass(outcome({ critical: true, tier: 5 }))).toBe("rank-crit")
    expect(diceOutcomeClass(outcome({ fumble: true, success: false, tier: 0 }))).toBe("rank-fumble")
    expect(diceOutcomeClass(outcome({}))).toBe("rank-success")
    expect(diceOutcomeClass(outcome({ success: false, tier: 1 }))).toBe("rank-fail")
  })
})

describe("DiceLine", () => {
  it("renders the roll with target, outcome label, and color class", () => {
    const frame: DiceFrame = {
      type: "dice",
      actor: "Nyx",
      kind: "check",
      expr: "1d100",
      rolls: [3],
      total: 3,
      target: 50,
      outcome: outcome({ id: "extreme", label: "EXTREME", tier: 4 }),
    }
    const { container } = render(<DiceLine frame={frame} />)
    const line = container.querySelector(".dice-line")
    expect(line).toHaveClass("rank-success")
    expect(line).toHaveTextContent("Nyx 1d100 = 3 vs 50 → EXTREME")
    expect(line).toHaveTextContent("[3]")
  })

  it("colors a critical success with the crit class", () => {
    const frame: DiceFrame = {
      type: "dice",
      actor: "Nyx",
      kind: "check",
      expr: "1d100",
      rolls: [1],
      total: 1,
      target: 50,
      outcome: outcome({ id: "crit", label: "CRITICAL", critical: true, tier: 5 }),
    }
    const { container } = render(<DiceLine frame={frame} />)
    expect(container.querySelector(".dice-line")).toHaveClass("rank-crit")
  })

  it("strips control characters from server-supplied fields", () => {
    const frame: DiceFrame = {
      type: "dice",
      actor: "Nyx\u001b]0;pwn\u0007",
      kind: "roll",
      expr: "1d6",
      rolls: [4],
      total: 4,
    }
    const { container } = render(<DiceLine frame={frame} />)
    expect(container.textContent).not.toContain("\u001b")
    expect(container.textContent).toContain("Nyx]0;pwn")
  })
})
