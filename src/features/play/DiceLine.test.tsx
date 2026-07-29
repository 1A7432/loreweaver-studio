import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { DiceFrame } from "@loreweaver/protocol"
import DiceLine from "./DiceLine"
import { diceRankClass } from "./rank"

describe("diceRankClass", () => {
  it("maps every rank of -2..4 onto the reference ramp", () => {
    expect(diceRankClass(-2)).toBe("rank-fumble")
    expect(diceRankClass(-1)).toBe("rank-fail")
    expect(diceRankClass(0)).toBe("rank-neutral")
    expect(diceRankClass(undefined)).toBe("rank-neutral")
    expect(diceRankClass(1)).toBe("rank-success")
    expect(diceRankClass(2)).toBe("rank-hard")
    expect(diceRankClass(3)).toBe("rank-extreme")
    expect(diceRankClass(4)).toBe("rank-crit")
    expect(diceRankClass(9)).toBe("rank-crit")
  })
})

describe("DiceLine", () => {
  it("renders the roll with target, level, and rank color class", () => {
    const frame: DiceFrame = {
      type: "dice",
      actor: "Nyx",
      kind: "check",
      expr: "1d100",
      rolls: [3],
      total: 3,
      target: 50,
      rank: 3,
      level: "EXTREME",
      success: true,
    }
    const { container } = render(<DiceLine frame={frame} />)
    const line = container.querySelector(".dice-line")
    expect(line).toHaveClass("rank-extreme")
    expect(line).toHaveTextContent("Nyx 1d100 = 3 vs 50 → EXTREME")
    expect(line).toHaveTextContent("[3]")
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
