// The drafting lane's contract: the model is told the real vocabulary, and nothing it returns
// reaches the editor without passing the same checks a hand-written panel passes.

import { describe, expect, it } from "vitest"
import type { LintVariable } from "../lint/model"
import { gatePanelsDraft, panelsSystemPrompt } from "./panelsAi"
import { BLOCK_KINDS, PANEL_SLOTS } from "./panelsModel"

const VARIABLES: LintVariable[] = [{ id: "tide", labelEn: "Tide", labelZh: "潮汐", visibility: "player" }]

const GOOD = {
  panels: [
    {
      id: "tide-board",
      title: { en: "Tide", zh: "潮汐" },
      slot: "sidebar",
      audience: "all",
      views: { vars: "variables" },
      blocks: [
        {
          kind: "meter",
          label: { en: "Water", zh: "水位" },
          value: { $view: "vars.module.tide.value" },
          min: 0,
          max: 10,
        },
      ],
    },
  ],
}

describe("the drafting prompt", () => {
  it("lists every block kind, slot, built-in view and command it may use", () => {
    const prompt = panelsSystemPrompt(VARIABLES, ["harbor"])
    for (const kind of BLOCK_KINDS) expect(prompt).toContain(`- ${kind}:`)
    for (const slot of PANEL_SLOTS) expect(prompt).toContain(`- ${slot}:`)
    expect(prompt).toContain("- me: me.member")
    expect(prompt).toContain("harbor/")
    expect(prompt).toContain("roll")
    expect(prompt).toContain("tide — Tide")
    expect(prompt).not.toContain("$var")
    expect(prompt).not.toContain('keeper"')
  })
})

describe("gatePanelsDraft", () => {
  it("lets a valid 3.0 draft through as an editor document", () => {
    const gate = gatePanelsDraft(GOOD)
    expect(gate.problems).toEqual([])
    expect(gate.value?.panels[0].id).toBe("tide-board")
  })

  it("sends the engine's own problems back to the model", () => {
    const bad = { panels: [{ ...GOOD.panels[0], views: { vars: "variables", me: "me" } }] }
    expect(gatePanelsDraft(bad).problems).toEqual(["panels.0.views.me: unused_view"])
  })

  it("refuses a 1.x binding, a page and an empty list", () => {
    const legacy = {
      panels: [{ ...GOOD.panels[0], blocks: [{ kind: "stat", label: "X", value: { $var: "tide" } }] }],
    }
    expect(gatePanelsDraft(legacy).value).toBeNull()
    const page = { panels: [{ id: "p", title: "P", slot: "modal", entry: "ui/p.html", fallback: null }] }
    expect(gatePanelsDraft(page).problems[0]).toContain("not a page")
    expect(gatePanelsDraft({ panels: [] }).value).toBeNull()
    expect(gatePanelsDraft("nope").value).toBeNull()
  })
})
