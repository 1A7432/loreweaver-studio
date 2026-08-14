import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { DiceFrame, DiceOutcome } from "@loreweaver/protocol"
import "../../i18n"
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

describe("dice detail", () => {
  const base: DiceFrame = {
    type: "dice",
    actor: "Nyx",
    kind: "check",
    expr: "侦查",
    rolls: [37],
    total: 37,
    target: 60,
  }

  it("renders a subsystem check's label and its loss numbers", () => {
    // `agent/kp_tools_subsystems.py` emits exactly this shape for a SAN check;
    // the studio used to drop every number in it.
    const { container } = render(
      <DiceLine
        frame={{
          ...base,
          kind: "subsystem",
          subsystem: "sanity",
          detail: { loss_expr: "1d6", loss: 4, remaining: 51, loss_ceiling: 5 },
        }}
      />,
    )
    expect(container.textContent).toContain("sanity")
    expect(container.textContent).toContain("loss")
    expect(container.textContent).toContain("4")
    expect(container.textContent).toContain("51")
  })

  it("renders an opposed check's two sides and marks the winner", () => {
    const { container } = render(
      <DiceLine
        frame={{
          ...base,
          kind: "opposed",
          detail: {
            left: { name: "Nyx", total: 37, target: 60, outcome: { label: "Hard success" } },
            right: { name: "The porter", total: 88, target: 45 },
            winner: "left",
          },
        }}
      />,
    )
    expect(container.textContent).toContain("Nyx")
    expect(container.textContent).toContain("The porter")
    expect(container.textContent).toContain("Hard success")
    expect(container.textContent).toContain("Nyx wins")
    // The two sides are laid out, not repeated as raw chips.
    expect(container.querySelectorAll(".dice-side")).toHaveLength(2)
    expect(container.querySelector(".dice-side.won")?.textContent).toContain("Nyx")
    expect(container.querySelectorAll(".dice-chip")).toHaveLength(0)
  })

  it("says nothing about a winner the server did not name", () => {
    const { container } = render(
      <DiceLine
        frame={{
          ...base,
          kind: "opposed",
          detail: { left: { name: "a", total: 10 }, right: { name: "b", total: 90 } },
        }}
      />,
    )
    // 90 beats 10 — and the rule system, not this client, decides that.
    expect(container.querySelector(".dice-winner")).toBeNull()
    expect(container.querySelector(".dice-side.won")).toBeNull()
  })

  it("surfaces an unknown key verbatim rather than dropping it", () => {
    const { container } = render(
      <DiceLine frame={{ ...base, detail: { bonus: 1, some_future_field: "moonlit" } }} />,
    )
    expect(container.textContent).toContain("bonus")
    expect(container.textContent).toContain("some_future_field")
    expect(container.textContent).toContain("moonlit")
  })

  it("hides the absence of a thing: false flags and zero modifiers", () => {
    const { container } = render(
      <DiceLine
        frame={{
          ...base,
          detail: { critical_success: false, critical_failure: false, modifier: 0, bonus: 2 },
        }}
      />,
    )
    const chips = [...container.querySelectorAll(".dice-chip")].map((chip) => chip.textContent)
    expect(chips).toHaveLength(1)
    expect(chips[0]).toContain("2")
  })

  it("renders nothing extra when there is no detail at all", () => {
    const { container } = render(<DiceLine frame={base} />)
    expect(container.querySelector(".dice-detail")).toBeNull()
    expect(container.querySelector(".dice-opposed")).toBeNull()
  })
})
