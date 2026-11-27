// Dice lines from the event's neutral fields (protocol 3.0 §8.2). The check is the
// document's own example; the plain roll is §13.1's; the sanity roll and the contest are
// shaped as the engine's commands emit them (server/src/gateway/commands/engine/checks.ts).
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { DiceData } from "loreweaver-protocol/v3"
import DiceLine from "./DiceLine"
import { diceOutcomeClass } from "./rank"

// protocol.md §8.2.
const CHECK: DiceData = {
  actor: "Alice",
  kind: "check",
  expr: "1d100",
  rolls: [19],
  total: 19,
  target: 25,
  effectiveTarget: 25,
  outcome: {
    id: "regular",
    label: "Success",
    success: true,
    critical: false,
    fumble: false,
    tier: 2,
    margin: 6,
  },
  detail: { skill: "Spot Hidden", modifier: 0, modifiers: [], params: [] },
}

const outcome = (patch: Partial<NonNullable<DiceData["outcome"]>>) => ({ ...CHECK.outcome!, ...patch })

describe("diceOutcomeClass", () => {
  it("colours by the flags, never by the rank id", () => {
    expect(diceOutcomeClass(undefined)).toBe("rank-neutral")
    expect(diceOutcomeClass(outcome({ critical: true }))).toBe("rank-crit")
    expect(diceOutcomeClass(outcome({ success: false, fumble: true }))).toBe("rank-fumble")
    expect(diceOutcomeClass(outcome({}))).toBe("rank-success")
    expect(diceOutcomeClass(outcome({ success: false }))).toBe("rank-fail")
    // A rank id that reads like a crit, on a plain success, is still a plain success.
    expect(diceOutcomeClass(outcome({ id: "critical" }))).toBe("rank-success")
  })
})

describe("DiceLine", () => {
  it("draws a check: who, the notation and total, the target, the outcome's label, the dice", () => {
    const { container } = render(<DiceLine data={CHECK} />)
    const line = container.querySelector(".dice-line") as HTMLElement
    expect(line).toHaveTextContent("Alice 1d100 = 19 vs 25 → Success")
    expect(line).toHaveTextContent("[19]")
    expect(line).toHaveClass("rank-success")
    expect(line).toHaveAttribute("data-kind", "check")
    expect(line).toHaveAttribute("data-tier", "2")
  })

  it("never shows a `detail` it would have to understand", () => {
    const { container } = render(<DiceLine data={CHECK} />)
    expect(container).not.toHaveTextContent("Spot Hidden")
  })

  it("names the value rolled against after difficulty, with the base value beside it", () => {
    const { container } = render(<DiceLine data={{ ...CHECK, target: 60, effectiveTarget: 30 }} />)
    expect(container.querySelector(".dice-text")).toHaveTextContent("vs 30 (60)")
  })

  it("spells a plain roll with its own readable text", () => {
    // protocol.md §13.1 step 5.
    const roll: DiceData = {
      actor: "Ada",
      kind: "roll",
      expr: "2d6",
      rolls: [5, 5],
      total: 10,
      detail: { text: "2d6 (5, 5) = 10" },
    }
    const { container } = render(<DiceLine data={roll} />)
    expect(container.querySelector(".dice-text")).toHaveTextContent(/^Ada 2d6 \(5, 5\) = 10$/)
    expect(container.querySelector(".dice-rolls")).toBeNull()
    expect(container.querySelector(".dice-line")).toHaveClass("rank-neutral")
  })

  it("says what a check was rolled for: the skill, as the rule system names it", () => {
    const { container } = render(
      <DiceLine
        data={{
          ...CHECK,
          actor: "沈青",
          label: "知识",
          rolls: [31],
          total: 31,
          target: 65,
          effectiveTarget: 65,
        }}
      />,
    )
    expect(container.querySelector(".dice-text")).toHaveTextContent(/^沈青 知识 1d100 = 31 vs 65 → Success$/)
    // A label from a server is content.
    const dirty = render(<DiceLine data={{ ...CHECK, label: "Spot\u001b[2J Hidden" }} />)
    expect(dirty.container.querySelector(".dice-text")?.textContent ?? "").not.toContain("\u001b")
  })

  it("shows the server's whole line when it sent one, and composes nothing beside it", () => {
    // A sanity roll as the engine emits it today: the line carries the consequence.
    const sanity: DiceData = {
      actor: "林夏",
      kind: "subsystem",
      subsystem: "sanity_check",
      subsystemLabel: "理智",
      label: "理智",
      expr: "1d100",
      rolls: [54],
      total: 54,
      target: 70,
      text: "理智 54/70（成功）：失去 1（1 = 1），理智 70 → 69",
      outcome: outcome({ label: "成功" }),
      detail: { stat: "SAN", loss: 1, before: 70, after: 69 },
    }
    const { container } = render(<DiceLine data={sanity} />)
    expect(container.querySelector(".dice-text")).toHaveTextContent(
      "林夏: 理智 54/70（成功）：失去 1（1 = 1），理智 70 → 69",
    )
    expect(container.querySelector(".dice-text")?.textContent ?? "").not.toContain("vs 70")
    expect(container.querySelector(".dice-rolls")).toBeNull()
    expect(container.querySelector(".dice-line")).toHaveClass("rank-success")
    // A plain roll carries `text` too (and the same words in `detail.text`): shown once.
    const roll: DiceData = {
      actor: "沈青",
      kind: "roll",
      expr: "2d6+1",
      rolls: [3, 1],
      total: 5,
      text: "2d6 (3, 1) + 1 = 5",
      detail: { text: "2d6 (3, 1) + 1 = 5" },
    }
    const plain = render(<DiceLine data={roll} />)
    expect(plain.container.querySelector(".dice-text")).toHaveTextContent(/^沈青: 2d6 \(3, 1\) \+ 1 = 5$/)
  })

  it("names a subsystem by its label in the room's language, the id as the tooltip", () => {
    const sanity: DiceData = {
      actor: "Ada",
      kind: "subsystem",
      subsystem: "sanity_check",
      subsystemLabel: "理智",
      expr: "1d100",
      rolls: [88],
      total: 88,
      target: 50,
      outcome: outcome({ id: "fail", label: "失败", success: false, tier: 0 }),
      detail: { stat: "SAN", loss: 3, lossNotation: "1d6", before: 50, after: 47 },
    }
    const { container, getByText } = render(<DiceLine data={sanity} />)
    expect(getByText("理智")).toHaveAttribute("title", "sanity_check")
    expect(container.querySelector(".dice-line")).toHaveClass("rank-fail")
    expect(container).not.toHaveTextContent("47")
  })

  it("draws a contest from its neutral fields alone", () => {
    const contest: DiceData = {
      actor: "Ada",
      kind: "opposed",
      subsystem: "opposed",
      subsystemLabel: "Opposed roll",
      expr: "1d100",
      rolls: [40, 70],
      total: 40,
      outcome: outcome({ critical: true, tier: 4 }),
      detail: { winner: "a", decidedBy: "level", settle: "tie", a: {}, b: {} },
    }
    const { container } = render(<DiceLine data={contest} />)
    const line = container.querySelector(".dice-line") as HTMLElement
    expect(line).toHaveTextContent("Opposed roll")
    expect(line).toHaveTextContent("[40, 70]")
    expect(line).toHaveClass("rank-crit")
  })

  it("strips control characters from what the server sent", () => {
    const { container } = render(
      <DiceLine data={{ ...CHECK, actor: "Ali\u0007ce", outcome: outcome({ label: "Succ\u001bess" }) }} />,
    )
    const text = container.querySelector(".dice-text")?.textContent ?? ""
    expect(text).not.toContain("\u0007")
    expect(text).not.toContain("\u001b")
  })
})
