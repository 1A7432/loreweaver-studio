// The drafting lane's contract: the model is told the real vocabulary and the pack's
// real variables, and nothing it returns reaches the editor without passing the same
// checks a hand-written panel passes.

import { describe, expect, it } from "vitest"
import type { LintVariable } from "../lint/model"
import { gatePanelsDraft, panelsSystemPrompt } from "./panelsAi"
import { BLOCK_KINDS } from "./panelsModel"

const VARIABLES: LintVariable[] = [
  { id: "tide", labelEn: "Tide", labelZh: "潮汐", visibility: "player" },
  { id: "suspicion", labelEn: "Suspicion", labelZh: "怀疑", visibility: "keeper" },
]

const GOOD = {
  panels: [
    {
      id: "tide-board",
      title: { en: "Tide", zh: "潮汐" },
      slot: "sidebar",
      audience: "all",
      blocks: [
        { kind: "meter", label: { en: "Water", zh: "水位" }, value: { $var: "tide" }, min: 0, max: 10 },
      ],
    },
  ],
}

describe("the drafting prompt", () => {
  it("lists every block kind the editor can actually edit", () => {
    const prompt = panelsSystemPrompt(VARIABLES)
    // Generated from the field table, so the prompt cannot describe a kind the
    // editor lacks (or miss one it has).
    for (const kind of BLOCK_KINDS) expect(prompt).toContain(`- ${kind}:`)
  })

  it("hands the model the pack's own variables, with their visibility", () => {
    const prompt = panelsSystemPrompt(VARIABLES)
    expect(prompt).toContain("- tide — Tide (player)")
    expect(prompt).toContain("- suspicion — Suspicion (keeper)")
  })

  it("tells a variable-less pack not to bind anything", () => {
    expect(panelsSystemPrompt([])).toContain("Do not use any")
  })
})

describe("the gate", () => {
  it("accepts a well-formed draft and returns it as an editable document", () => {
    const { value, problems } = gatePanelsDraft(GOOD, VARIABLES)
    expect(problems).toEqual([])
    expect(value?.panels).toHaveLength(1)
    expect(value?.panels[0].id).toBe("tide-board")
  })

  it("refuses a binding the pack never declared, in words the model can act on", () => {
    const draft = structuredClone(GOOD)
    draft.panels[0].blocks[0].value = { $var: "tidal" }

    const { value, problems } = gatePanelsDraft(draft, VARIABLES)
    expect(value).toBeNull()
    expect(problems.join(" ")).toContain("not a variable this pack declares")
  })

  it("refuses a backwards meter and a missing required field", () => {
    const draft = structuredClone(GOOD)
    draft.panels[0].blocks[0].min = 10
    draft.panels[0].blocks[0].max = 2
    draft.panels[0].blocks[0].label = { en: "", zh: "" }

    const { value, problems } = gatePanelsDraft(draft, VARIABLES)
    expect(value).toBeNull()
    expect(problems.join(" ")).toContain("max must be greater")
    expect(problems.join(" ")).toContain('"label" is missing')
  })

  it("refuses a reply that is not a panels document at all", () => {
    expect(gatePanelsDraft({ hello: 1 }, VARIABLES).value).toBeNull()
    expect(gatePanelsDraft({ panels: [] }, VARIABLES).problems.join(" ")).toContain("empty")
  })
})
