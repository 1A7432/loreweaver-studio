import { render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { DiceFrame, DiceOutcome } from "@loreweaver/protocol"
import i18n from "../../i18n"
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

  it("names the subsystem by its display name (v2.5 subsystem_label), the id as tooltip", () => {
    const { container } = render(
      <DiceLine
        frame={{
          ...base,
          kind: "subsystem",
          subsystem: "sanity_check",
          subsystem_label: "Sani\u0007ty",
          expr: "1d100",
        }}
      />,
    )
    const chip = container.querySelector(".dice-subsystem")
    expect(chip?.textContent).toBe("Sanity")
    expect(chip).toHaveAttribute("title", "sanity_check")
    expect(container.textContent).not.toContain("sanity_check")
  })

  it("drops the chip when it would only repeat the roll's own expression", () => {
    // The engine writes a SAN check's `expr` as the localized stat already — "理智 理智".
    const { container } = render(
      <DiceLine
        frame={{
          ...base,
          kind: "subsystem",
          subsystem: "sanity_check",
          subsystem_label: "理智",
          expr: "理智",
        }}
      />,
    )
    expect(container.querySelector(".dice-subsystem")).toBeNull()
    expect(container.textContent?.match(/理智/g)).toHaveLength(1)
    // Case-blind for a Latin label, so "Sanity" beside "sanity" does not stutter either.
    const latin = render(
      <DiceLine
        frame={{
          ...base,
          kind: "subsystem",
          subsystem: "sanity_check",
          subsystem_label: "Sanity",
          expr: "sanity",
        }}
      />,
    )
    expect(latin.container.querySelector(".dice-subsystem")).toBeNull()
  })

  it("falls back to the raw subsystem id when the server sends no label", () => {
    const { container } = render(
      <DiceLine frame={{ ...base, kind: "subsystem", subsystem: "sanity_check" }} />,
    )
    const chip = container.querySelector(".dice-subsystem")
    expect(chip?.textContent).toBe("sanity_check")
    expect(chip).not.toHaveAttribute("title")
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

  it("keeps a zero whose zero IS the reading: a rule-capped loss", () => {
    // 《安土》 caps plant-horror sanity loss to 0 once a character is far enough
    // gone — the module's whole thesis. The engine publishes loss:0 alongside
    // loss_ceiling:0 and says why; dropping both zeroes left the player watching
    // a failed check roll 1d4 and lose nothing, unexplained (run-3 play-test).
    const { container } = render(
      <DiceLine
        frame={{
          ...base,
          detail: { loss_expr: "1d4", loss: 0, remaining: 42, loss_ceiling: 0, resource_max: 99 },
        }}
      />,
    )
    const chips = [...container.querySelectorAll(".dice-chip")].map((chip) => chip.textContent ?? "")
    expect(chips.some((chip) => /loss\b/i.test(chip) && chip.includes("0"))).toBe(true)
    expect(chips.some((chip) => /cap/i.test(chip))).toBe(true)
  })

  it("renders nothing extra when there is no detail at all", () => {
    const { container } = render(<DiceLine frame={base} />)
    expect(container.querySelector(".dice-detail")).toBeNull()
    expect(container.querySelector(".dice-opposed")).toBeNull()
  })
})

describe("percentile bonus / penalty dice", () => {
  // `core/dice_engine.py` reports a d100 with extra tens dice as `base_roll`
  // (the d100 before them), `extra_tens`, `final_tens` and the bonus/penalty
  // counts. Rendered raw, a CoC bonus-die check read
  //   [68]  base_roll: 98  奖励骰: 1  extra_tens: [6]  final_tens: 6
  // — four chips for one mechanic, two of them in the engine's own words.
  const check: DiceFrame = {
    type: "dice",
    actor: "Nyx",
    kind: "check",
    expr: "1d100",
    rolls: [68],
    total: 68,
    target: 70,
  }
  const chipsOf = (container: HTMLElement) =>
    [...container.querySelectorAll(".dice-chip")].map((chip) => ({
      label: chip.querySelector(".dice-chip-label")?.textContent,
      value: chip.querySelector(".dice-chip-value")?.textContent,
    }))

  afterEach(async () => {
    await i18n.changeLanguage("en")
  })

  it("reads a bonus die as one sentence, with none of its keys repeated as chips", async () => {
    await i18n.changeLanguage("en")
    const { container } = render(
      <DiceLine frame={{ ...check, detail: { bonus: 1, base_roll: 98, extra_tens: [6], final_tens: 6 } }} />,
    )
    expect(chipsOf(container)).toEqual([
      { label: "bonus die 1", value: "rolled 98, extra tens 6, tens taken 6" },
    ])
    for (const raw of ["base_roll", "extra_tens", "final_tens", "bonus dice"]) {
      expect(container.textContent).not.toContain(raw)
    }
    // The roll itself still shows beside it.
    expect(container.querySelector(".dice-rolls")).toHaveTextContent("[68]")
  })

  it("reads a penalty die the same way", async () => {
    await i18n.changeLanguage("en")
    const { container } = render(
      <DiceLine
        frame={{ ...check, detail: { penalty: 2, base_roll: 41, extra_tens: [7, 9], final_tens: 9 } }}
      />,
    )
    expect(chipsOf(container)).toEqual([
      { label: "penalty die 2", value: "rolled 41, extra tens 7/9, tens taken 9" },
    ])
  })

  it("says so in Chinese too", async () => {
    await i18n.changeLanguage("zh")
    const { container } = render(
      <DiceLine frame={{ ...check, detail: { bonus: 1, base_roll: 98, extra_tens: [6], final_tens: 6 } }} />,
    )
    expect(chipsOf(container)).toEqual([{ label: "奖励骰 1", value: "原掷 98，另掷十位 6，取十位 6" }])
  })

  it("names both counts when a bonus and a penalty die did not cancel", async () => {
    await i18n.changeLanguage("en")
    const { container } = render(
      <DiceLine
        frame={{
          ...check,
          detail: { bonus: 2, penalty: 1, base_roll: 98, extra_tens: [6], final_tens: 6 },
        }}
      />,
    )
    expect(chipsOf(container)).toHaveLength(1)
    expect(chipsOf(container)[0].label).toBe("bonus die 2 / penalty die 1")
  })

  it("still reads the cluster when the pack names its dice something else", async () => {
    await i18n.changeLanguage("en")
    const { container } = render(
      <DiceLine frame={{ ...check, detail: { base_roll: 98, extra_tens: [6], final_tens: 6 } }} />,
    )
    expect(chipsOf(container)).toEqual([
      { label: "tens dice", value: "rolled 98, extra tens 6, tens taken 6" },
    ])
  })

  it("leaves every other key alone: a modifier and a field from the future survive", async () => {
    await i18n.changeLanguage("en")
    const { container } = render(
      <DiceLine
        frame={{
          ...check,
          detail: {
            bonus: 1,
            base_roll: 98,
            extra_tens: [6],
            final_tens: 6,
            modifier: 5,
            some_future_field: "moonlit",
          },
        }}
      />,
    )
    const chips = chipsOf(container)
    expect(chips).toHaveLength(3)
    expect(chips[0].label).toBe("bonus die 1")
    expect(chips.map((chip) => chip.label)).toContain("modifier")
    expect(chips.map((chip) => chip.label)).toContain("some_future_field")
  })

  it("falls back to labelled chips when only some of the keys came", async () => {
    await i18n.changeLanguage("en")
    const { container } = render(
      <DiceLine frame={{ ...check, detail: { bonus: 1, base_roll: 98, final_tens: 6 } }} />,
    )
    expect(chipsOf(container)).toEqual([
      { label: "bonus dice", value: "1" },
      { label: "original roll", value: "98" },
      { label: "tens taken", value: "6" },
    ])
  })

  it("falls back, hiding nothing, when the cluster is malformed", async () => {
    await i18n.changeLanguage("en")
    const { container } = render(
      <DiceLine frame={{ ...check, detail: { base_roll: 98, extra_tens: ["six"], final_tens: 6 } }} />,
    )
    expect(chipsOf(container)).toEqual([
      { label: "original roll", value: "98" },
      { label: "extra tens", value: '["six"]' },
      { label: "tens taken", value: "6" },
    ])
  })

  it("keeps a kept tens digit of 0: a roll of 01-09 is a reading, not an absence", async () => {
    await i18n.changeLanguage("en")
    const { container } = render(<DiceLine frame={{ ...check, detail: { base_roll: 47, final_tens: 0 } }} />)
    expect(chipsOf(container)).toContainEqual({ label: "tens taken", value: "0" })
    // ...and inside the whole cluster, where it is simply the digit that was taken.
    const whole = render(
      <DiceLine frame={{ ...check, detail: { bonus: 1, base_roll: 47, extra_tens: [0], final_tens: 0 } }} />,
    )
    expect(chipsOf(whole.container)[0].value).toBe("rolled 47, extra tens 0, tens taken 0")
  })
})
