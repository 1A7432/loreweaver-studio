// The panels model is the whole editor's contract with the file on disk: what it
// reads, what it writes back, and what it refuses to lose. The round-trip tests
// matter most — an editor that quietly rewrites an author's panels file into
// something the engine rejects is worse than no editor.

import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import {
  BLOCK_FIELDS,
  literal,
  newBlock,
  newPanel,
  parsePanelsYaml,
  problemsFor,
  serializePanelsYaml,
} from "./panelsModel"

const HAND_WRITTEN = `panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    blocks:
      - {kind: meter, label: {en: Water, zh: 水位}, value: {$var: tide}, min: 0, max: 10}
      - kind: text
        text: {en: The gate closes at high water., zh: 涨潮时闸门关闭。}
        style: warning
        visible_when: tide >= 8
  - id: suspicions
    title: Suspicions
    slot: inline
    audience: keeper
    blocks:
      - repeat:
          prefix: suspect.
          block: {kind: stat, label: {$leaf: label}, value: {$leaf: value}}
`

describe("reading a panels file", () => {
  it("reads panels, blocks, bindings, conditions and repeats", () => {
    const { document, error, dropped } = parsePanelsYaml(HAND_WRITTEN)

    expect(error).toBeNull()
    expect(dropped).toBe(0)
    expect(document.panels.map((panel) => panel.id)).toEqual(["tide-board", "suspicions"])

    const [tide, suspicions] = document.panels
    expect(tide.title).toEqual({ en: "Tide", zh: "潮汐" })
    expect(tide.slot).toBe("sidebar")
    expect(tide.audience).toBe("all")
    expect(tide.blocks[0].fields.value).toEqual({ mode: "var", path: "tide" })
    expect(tide.blocks[1].visibleWhen).toBe("tide >= 8")

    // A plain-string title is an en-only label, exactly as the schema reads it.
    expect(suspicions.title).toEqual({ en: "Suspicions", zh: "" })
    expect(suspicions.audience).toBe("keeper")
    // `{repeat: {prefix, block}}` flattens into one block plus its prefix — repeat
    // cannot nest, so an editor never needs a tree here.
    expect(suspicions.blocks[0].kind).toBe("stat")
    expect(suspicions.blocks[0].repeatPrefix).toBe("suspect.")
  })

  it("round-trips: what it writes back parses to the same model", () => {
    const first = parsePanelsYaml(HAND_WRITTEN).document
    const second = parsePanelsYaml(serializePanelsYaml(first)).document

    const strip = (document: typeof first) =>
      JSON.stringify(
        document.panels.map((panel) => ({
          ...panel,
          uid: "",
          blocks: panel.blocks.map((b) => ({ ...b, uid: "" })),
        })),
      )
    expect(strip(second)).toEqual(strip(first))
  })

  it("keeps a tier-2 panel exactly as written instead of eating it", () => {
    const yaml = `panels:
  - id: board
    title: Board
    slot: sidebar
    entry: ui/board/index.html
    assets: [ui/board/app.js]
    fallback: null
`
    const { document } = parsePanelsYaml(yaml)
    expect(document.panels).toHaveLength(0)
    expect(document.opaque).toHaveLength(1)

    const written = parseYaml(serializePanelsYaml(document)) as { panels: Record<string, unknown>[] }
    expect(written.panels[0].entry).toBe("ui/board/index.html")
    expect(written.panels[0].assets).toEqual(["ui/board/app.js"])
  })

  it("reports a broken file instead of silently emptying it", () => {
    expect(parsePanelsYaml("panels: [").error).not.toBeNull()
    expect(parsePanelsYaml("nope: 1").error).not.toBeNull()
    expect(parsePanelsYaml("").error).toBeNull()
  })
})

describe("writing a panels file", () => {
  it("writes an en-only label as the plain string the schema accepts", () => {
    const panel = newPanel()
    panel.id = "hud"
    panel.title = { en: "HUD", zh: "" }
    const block = newBlock("stat")
    block.fields.label = { en: "Lanterns", zh: "" }
    block.fields.value = literal("3")
    panel.blocks = [block]

    const written = parseYaml(serializePanelsYaml({ panels: [panel], opaque: [] })) as {
      panels: { title: unknown; blocks: { value: unknown }[] }[]
    }
    expect(written.panels[0].title).toBe("HUD")
    // A numeric literal stays a number, so `min`/`max` comparisons hold engine-side.
    expect(written.panels[0].blocks[0].value).toBe(3)
  })

  it("drops an empty OPTIONAL field rather than writing a blank one", () => {
    const panel = newPanel()
    panel.id = "hud"
    panel.title = { en: "HUD", zh: "" }
    panel.blocks = [
      { ...newBlock("badge"), fields: { ...newBlock("badge").fields, label: { en: "Alert", zh: "" } } },
    ]

    const written = parseYaml(serializePanelsYaml({ panels: [panel], opaque: [] })) as {
      panels: { blocks: Record<string, unknown>[] }[]
    }
    expect(written.panels[0].blocks[0]).toEqual({ kind: "badge", label: "Alert" })
  })

  it("writes nothing at all for an empty document", () => {
    expect(serializePanelsYaml({ panels: [], opaque: [] })).toBe("")
  })
})

describe("what an author can fix while typing", () => {
  const declared = new Set(["tide", "lantern"])

  it("names a binding no variable backs — the block would vanish, not error", () => {
    const document = parsePanelsYaml(`panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    blocks:
      - {kind: meter, label: {en: Water, zh: 水位}, value: {$var: tidal}, min: 0, max: 10}
`).document
    const keys = problemsFor(document, declared).map((problem) => problem.key)
    expect(keys).toContain("unknownVar")
  })

  it("leaves a repeat's own {$leaf} substitution alone — it names no variable", () => {
    const document = parsePanelsYaml(HAND_WRITTEN).document
    const repeated = document.panels[1].blocks[0]
    expect(repeated.fields.label).toEqual({ mode: "leaf", leaf: "label" })
    expect(repeated.fields.value).toEqual({ mode: "leaf", leaf: "value" })
    expect(problemsFor(document, declared)).toEqual([])
  })

  it("passes a file whose bindings all resolve", () => {
    const document = parsePanelsYaml(`panels:
  - id: tide-board
    title: {en: Tide, zh: 潮汐}
    slot: sidebar
    blocks:
      - {kind: meter, label: {en: Water, zh: 水位}, value: {$var: tide}, min: 0, max: 10}
`).document
    expect(problemsFor(document, declared)).toEqual([])
  })

  it("catches a bad id, a missing required field, an empty panel and a backwards meter", () => {
    const panel = newPanel()
    panel.id = "Tide Board"
    panel.title = { en: "", zh: "" }
    const meter = newBlock("meter")
    meter.fields.min = literal("10")
    meter.fields.max = literal("2")
    meter.fields.value = literal("5")
    panel.blocks = [meter]

    const keys = problemsFor({ panels: [panel], opaque: [] }, declared).map((problem) => problem.key)
    expect(keys).toContain("badId")
    expect(keys).toContain("noTitle")
    expect(keys).toContain("missingField") // the meter's label
    expect(keys).toContain("meterRange")

    const empty = newPanel()
    empty.id = "hud"
    empty.title = { en: "HUD", zh: "" }
    expect(problemsFor({ panels: [empty], opaque: [] }, declared).map((p) => p.key)).toContain("noBlocks")
  })

  it("says nothing about bindings when the pack declares no variables yet", () => {
    const document = parsePanelsYaml(HAND_WRITTEN).document
    const keys = problemsFor(document, new Set<string>()).map((problem) => problem.key)
    expect(keys).not.toContain("unknownVar")
  })
})

describe("the field table", () => {
  it("is the whole vocabulary — the editor has no per-kind code to fall behind it", () => {
    // Mirrors `core/panels.py`'s own table; a kind added there and not here simply
    // cannot be edited, which is the failure this assertion makes loud.
    expect(Object.keys(BLOCK_FIELDS).sort()).toEqual([
      "badge",
      "clipping",
      "divider",
      "image",
      "letter",
      "map_pin",
      "meter",
      "stat",
      "text",
      "title_card",
    ])
    expect(BLOCK_FIELDS.meter.filter((spec) => spec.required).map((spec) => spec.name)).toEqual([
      "label",
      "value",
      "min",
      "max",
    ])
  })
})
