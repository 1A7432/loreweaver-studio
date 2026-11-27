import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { checkPanelsText } from "./panelsCheck"
import {
  BLOCK_FIELDS,
  binding,
  isOpaqueBlock,
  newBlock,
  newPanel,
  newRepeat,
  newViewDecl,
  opaqueBlockCount,
  parseLiteralInput,
  parsePanelsYaml,
  serializePanelsYaml,
} from "./panelsModel"

const FILE = `panels:
  - id: tide
    title: {en: The tide, zh: 潮汐}
    slot: sidebar
    audience: admin
    views: {me: me, tide: harbor/tide}
    blocks:
      - kind: meter
        label: {en: Tide, zh: 潮位}
        value: {$view: tide.level}
        min: 0
        max: {$view: tide.max}
        visible_when: "tide.level >= 1"
      - repeat:
          each: me.character.resources
          as: r
          prefix: h
          block: {kind: stat, label: {$view: r.label}, value: {$view: r.value}}
        visible_when: me.character
      - kind: choices
        prompt: Ring?
        options:
          - {id: ring, label: Ring it, command: harbor/ring, args: {times: 2}}
  - id: chart
    title: Chart
    slot: modal
    views: {tide: harbor/tide}
    entry: ui/chart.html
    fallback: null
`

describe("parsePanelsYaml / serializePanelsYaml", () => {
  it("reads every 3.0 construct into the model", () => {
    const { document, error } = parsePanelsYaml(FILE)
    expect(error).toBeNull()
    const [tide, chart] = document.panels
    expect(tide.views.map((decl) => [decl.handle, decl.view])).toEqual([
      ["me", "me"],
      ["tide", "harbor/tide"],
    ])
    expect(tide.blocks[0].fields.value).toEqual(binding("tide.level"))
    expect(tide.blocks[0].visibleWhen).toBe("tide.level >= 1")
    expect(tide.blocks[1].repeat).toEqual({
      each: "me.character.resources",
      as: "r",
      prefix: "h",
      visibleWhen: "me.character",
    })
    expect(tide.blocks[2].fields.options).toMatchObject({
      mode: "options",
      options: [{ id: "ring", command: "harbor/ring", argsText: '{"times":2}' }],
    })
    expect(chart.kind).toBe("page")
    expect(chart.entry).toBe("ui/chart.html")
    expect(chart.fallback).toBeNull()
  })

  it("round-trips the file to the same document", () => {
    const written = serializePanelsYaml(parsePanelsYaml(FILE).document)
    expect(parse(written)).toEqual(parse(FILE))
    expect(checkPanelsText(written).problems).toEqual([])
  })

  it("keeps a block it cannot hold verbatim, and a key it does not model", () => {
    const text = `panels:
  - id: a
    title: A
    slot: sidebar
    icon: bell
    blocks:
      - {kind: hologram, beam: 3}
      - {kind: stat, label: X, value: {$var: day}}
`
    const { document } = parsePanelsYaml(text)
    expect(document.panels[0].blocks.every(isOpaqueBlock)).toBe(true)
    expect(opaqueBlockCount(document)).toBe(2)
    const written = parse(serializePanelsYaml(document)) as { panels: Record<string, unknown>[] }
    expect(written.panels[0].icon).toBe("bell")
    expect(written.panels[0].blocks).toEqual([
      { kind: "hologram", beam: 3 },
      { kind: "stat", label: "X", value: { $var: "day" } },
    ])
  })

  it("writes what the editor builds as a file the checks accept", () => {
    const panel = newPanel()
    panel.id = "hud"
    panel.title = { en: "HUD", zh: "" }
    panel.views = [newViewDecl("me", "me")]
    const stat = newBlock("stat")
    stat.fields.label = { en: "", zh: "名字" }
    stat.fields.value = binding("me.character.name")
    const meter = newBlock("meter")
    meter.fields.label = binding("item.label")
    meter.fields.value = binding("item.value")
    meter.fields.min = parseLiteralInput("0")
    meter.fields.max = binding("item.max")
    meter.repeat = { ...newRepeat(), each: "me.character.resources" }
    panel.blocks = [stat, meter]
    const text = serializePanelsYaml({ panels: [panel] })
    expect(checkPanelsText(text).problems).toEqual([])
    const written = parse(text) as { panels: Record<string, unknown>[] }
    // A blank locale is left out, never written blank; the default `as` is not written.
    expect((written.panels[0].blocks as Record<string, unknown>[])[0].label).toEqual({ zh: "名字" })
    expect((written.panels[0].blocks as Record<string, unknown>[])[1]).toEqual({
      repeat: {
        each: "me.character.resources",
        block: {
          kind: "meter",
          label: { $view: "item.label" },
          value: { $view: "item.value" },
          min: 0,
          max: { $view: "item.max" },
        },
      },
    })
  })

  it("writes a page with an explicit null fallback", () => {
    const panel = {
      ...newPanel(),
      id: "chart",
      title: { en: "Chart", zh: "" },
      kind: "page" as const,
      entry: "ui/c.html",
    }
    const written = parse(serializePanelsYaml({ panels: [panel] })) as { panels: Record<string, unknown>[] }
    expect(written.panels[0]).toEqual({
      id: "chart",
      title: "Chart",
      slot: "sidebar",
      entry: "ui/c.html",
      fallback: null,
    })
  })

  it("has a form for every block kind the engine knows", () => {
    expect(Object.keys(BLOCK_FIELDS).sort()).toEqual(
      [
        "badge",
        "choices",
        "clipping",
        "divider",
        "image",
        "letter",
        "map_pin",
        "meter",
        "stat",
        "text",
        "title_card",
      ].sort(),
    )
  })

  it("reports a file that is not a panels mapping", () => {
    expect(parsePanelsYaml("- 1").error).not.toBeNull()
    expect(parsePanelsYaml("").document.panels).toEqual([])
  })
})
