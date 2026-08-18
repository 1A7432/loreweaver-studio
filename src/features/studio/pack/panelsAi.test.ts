// The drafting lane's contract: the model is told the real vocabulary and the pack's
// real variables, and nothing it returns reaches the editor without passing the same
// checks a hand-written panel passes.

import { describe, expect, it } from "vitest"
import type { LintVariable } from "../lint/model"
import { gatePanelsDraft, panelsSystemPrompt } from "./panelsAi"
import { BLOCK_KINDS, PANEL_SLOTS } from "./panelsModel"

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

  it("teaches the model the ENGINE's slots, each with what it means", () => {
    // `sidebar|tray|modal` is `core/panels.py` `PANEL_SLOTS`. The first draft taught
    // `inline` — the hook `ui` frame's word — and every drafted panel failed the build.
    const prompt = panelsSystemPrompt(VARIABLES)
    expect(prompt).toContain('"slot": "sidebar" | "tray" | "modal"')
    for (const slot of PANEL_SLOTS) expect(prompt).toContain(`- ${slot}:`)
    expect(prompt).not.toContain("inline")
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

  it("refuses a block kind outside the vocabulary — from a model that is a wrong answer, not a keepsake", () => {
    const draft = structuredClone(GOOD) as { panels: { blocks: unknown[] }[] }
    draft.panels[0].blocks.push({ kind: "hologram", label: { en: "Ghost", zh: "鬼影" } })
    const { value, problems } = gatePanelsDraft(draft, VARIABLES)
    expect(value).toBeNull()
    expect(problems.join(" ")).toContain('"hologram" is not a block kind')
  })

  it("accepts a choices block and wants each option whole", () => {
    const draft = structuredClone(GOOD) as { panels: { blocks: unknown[] }[] }
    draft.panels[0].blocks.push({
      kind: "choices",
      prompt: { en: "What now?", zh: "现在呢？" },
      options: [{ id: "look", label: { en: "Look around", zh: "环顾" }, input: ".ra 侦查" }],
    })
    expect(gatePanelsDraft(draft, VARIABLES).problems).toEqual([])

    draft.panels[0].blocks.push({
      kind: "choices",
      options: [{ id: "", label: { en: "x", zh: "x" }, input: "go" }],
    })
    const { value, problems } = gatePanelsDraft(draft, VARIABLES)
    expect(value).toBeNull()
    expect(problems.join(" ")).toContain("every option needs an id")
  })

  it("refuses a reply that is not a panels document at all", () => {
    expect(gatePanelsDraft({ hello: 1 }, VARIABLES).value).toBeNull()
    expect(gatePanelsDraft({ panels: [] }, VARIABLES).problems.join(" ")).toContain("empty")
  })
})
