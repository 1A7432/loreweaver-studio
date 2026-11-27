// The engine's panels checks, as Studio runs them while the author types. Codes and paths are
// the engine's (`server/src/core/panels/format.ts`); the round-trip gate runs both readers on
// the panels Studio writes.

import { describe, expect, it } from "vitest"
import { checkPanelsText, conditionReferences, isPanelViewName } from "./panelsCheck"

function problems(yaml: string) {
  return checkPanelsText(yaml).problems
}

const GOOD = `panels:
  - id: tide
    title: {en: The tide, zh: 潮汐}
    slot: sidebar
    views: {me: me, tide: harbor/tide}
    blocks:
      - {kind: meter, label: {en: Tide, zh: 潮位}, value: {$view: tide.level}, min: 0, max: {$view: tide.max}}
      - {kind: image, src: art/chart.png, caption: Harbor chart}
      - repeat:
          each: me.character.resources
          as: r
          block: {kind: meter, label: {$view: r.label}, value: {$view: r.value}, min: 0, max: {$view: r.max}}
      - kind: choices
        prompt: Ring the bell?
        options:
          - {id: ring, label: Ring it, command: harbor/ring, args: {times: 2}}
        visible_when: "tide.level >= 5"
  - id: chart
    title: Sea chart
    slot: modal
    views: {tide: harbor/tide}
    entry: ui/chart.html
    fallback:
      - {kind: text, text: {$view: tide.phase}}
`

describe("checkPanelsText", () => {
  it("accepts the format's own complete example", () => {
    const checked = checkPanelsText(GOOD)
    expect(checked.problems).toEqual([])
    expect(checked.panels).toEqual([
      { id: "tide", kind: "template", entry: null, images: ["art/chart.png"] },
      { id: "chart", kind: "page", entry: "ui/chart.html", images: [] },
    ])
  })

  it("refuses a view that is declared and never read, and a path to an undeclared handle", () => {
    expect(
      problems(`panels:
  - {id: a, title: A, slot: sidebar, views: {me: me, party: party}, blocks: [{kind: stat, label: X, value: {$view: me.member.name}}]}
`),
    ).toEqual([{ code: "unused_view", path: "panels.0.views.party" }])
    expect(
      problems(`panels:
  - {id: a, title: A, slot: sidebar, views: {me: me}, blocks: [{kind: stat, label: X, value: {$view: you.name}}]}
`),
    ).toEqual([{ code: "unknown_handle", path: "panels.0.blocks.0.value.$view", detail: "you" }])
  })

  it("names every 1.x field as replaced_2x", () => {
    const codes = problems(`panels:
  - id: a
    title: A
    slot: modal
    audience: keeper
    entry: ui/a.html
    assets: [ui/a.html]
    fallback:
      - {kind: stat, label: X, value: {$var: day}}
      - kind: choices
        options: [{id: x, label: X, input: ".r 1d6"}]
`).map((problem) => [problem.code, problem.path, problem.detail])
    expect(codes).toEqual(
      expect.arrayContaining([
        ["replaced_2x", "panels.0.assets", "assets"],
        ["replaced_2x", "panels.0.audience", "keeper"],
        ["replaced_2x", "panels.0.fallback.0.value", "$var"],
        ["replaced_2x", "panels.0.fallback.1.options.0.input", "input"],
      ]),
    )
  })

  it("requires a page's fallback, accepting an explicit null", () => {
    expect(problems("panels:\n  - {id: a, title: A, slot: modal, entry: ui/a.html}\n")).toEqual([
      { code: "missing_field", path: "panels.0.fallback" },
    ])
    expect(
      problems("panels:\n  - {id: a, title: A, slot: modal, entry: ui/a.html, fallback: null}\n"),
    ).toEqual([])
    expect(problems("panels:\n  - {id: a, title: A, slot: modal, entry: ui/a.js, fallback: null}\n")).toEqual(
      [{ code: "bad_path", path: "panels.0.entry", detail: "extension" }],
    )
  })

  it("keeps visible_when in the portable subset, its references in scope", () => {
    const at = (condition: string) =>
      problems(`panels:
  - id: a
    title: A
    slot: sidebar
    views: {me: me}
    blocks:
      - {kind: stat, label: X, value: {$view: me.member.name}, visible_when: "${condition}"}
`)
    expect(at("me.character.resources.hp.value > 0")).toEqual([])
    expect(at("me.member.role == 'admin' && !me.character")).toEqual([])
    expect(at("me.level + 1 > 2").map((problem) => problem.code)).toEqual(["bad_condition"])
    expect(at("getvar('x') > 2").map((problem) => problem.code)).toEqual(["bad_condition"])
    expect(at("other.level > 2")).toEqual([
      { code: "unknown_handle", path: "panels.0.blocks.0.visible_when", detail: "other" },
    ])
  })

  it("refuses a repeat inside a repeat, and an `as` that shadows a handle", () => {
    expect(
      problems(`panels:
  - id: a
    title: A
    slot: sidebar
    views: {me: me}
    blocks:
      - repeat: {each: me.character.resources, as: me, block: {kind: stat, label: X, value: 1}}
`),
    ).toEqual([{ code: "handle_shadowed", path: "panels.0.blocks.0.repeat.as", detail: "me" }])
  })

  it("refuses a players-only panel that reads an admin view", () => {
    expect(
      problems(`panels:
  - {id: a, title: A, slot: sidebar, audience: player, views: {keys: admin/keys}, blocks: [{kind: stat, label: X, value: {$view: keys.keys.0.name}}]}
`),
    ).toEqual([{ code: "audience_conflict", path: "panels.0.audience" }])
  })

  it("holds a choice's command and args to the engine's rules", () => {
    const codes = problems(`panels:
  - id: a
    title: A
    slot: sidebar
    blocks:
      - kind: choices
        options:
          - {id: a, label: A, command: "Bad Command"}
          - {id: b, label: B, command: roll, args: {"bad key": 1}}
          - {id: c, label: C, command: rules.sanity_check}
`).map((problem) => [problem.code, problem.path])
    expect(codes).toEqual([
      ["bad_id", "panels.0.blocks.0.options.0.command"],
      ["bad_field", "panels.0.blocks.0.options.1.args"],
    ])
  })

  it("refuses anchors and aliases, like the engine's loader", () => {
    const text = "panels:\n  - &p {id: a, title: A, slot: sidebar, blocks: [{kind: divider}]}\n  - *p\n"
    expect(problems(text).map((problem) => problem.code)).toEqual(["bad_yaml"])
  })
})

describe("view names and condition references", () => {
  it("knows which views a panel may declare", () => {
    expect(isPanelViewName("me")).toBe(true)
    expect(isPanelViewName("admin/keys")).toBe(true)
    expect(isPanelViewName("harbor/tide")).toBe(true)
    expect(isPanelViewName("panels")).toBe(false)
    expect(isPanelViewName("Harbor/Tide")).toBe(false)
    expect(isPanelViewName("harbor")).toBe(false)
  })

  it("reads references, never string literals or keywords", () => {
    expect(
      conditionReferences("vars.module.理智.value < 30 and tide.boats.0.name == 'gull' or not true"),
    ).toEqual(["vars.module.理智.value", "tide.boats.0.name"])
  })
})
