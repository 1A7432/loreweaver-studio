// The panels model is the whole editor's contract with the file on disk: what it
// reads, what it writes back, and what it refuses to lose. The round-trip tests
// matter most — an editor that quietly rewrites an author's panels file into
// something the engine rejects is worse than no editor.

import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import {
  BLOCK_FIELDS,
  PANEL_SLOTS,
  isOpaquePanel,
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
    slot: tray
    audience: keeper
    blocks:
      - repeat:
          prefix: suspect.
          block: {kind: stat, label: {$leaf: label}, value: {$leaf: value}}
        visible_when: tide >= 2
      - {kind: stat, label: {zh: 已报警}, value: true}
      - kind: choices
        prompt: {en: What now?, zh: 现在呢？}
        options:
          - {id: look, label: {en: Look around, zh: 环顾}, input: .ra 侦查}
`

describe("reading a panels file", () => {
  it("reads panels, blocks, bindings, conditions and repeats", () => {
    const { document, error, opaqueBlocks } = parsePanelsYaml(HAND_WRITTEN)

    expect(error).toBeNull()
    expect(opaqueBlocks).toBe(0)
    expect(document.panels.map((panel) => panel.id)).toEqual(["tide-board", "suspicions"])
    expect(document.panels.every((panel) => !isOpaquePanel(panel))).toBe(true)

    const [tide, suspicions] = document.panels
    if (isOpaquePanel(tide) || isOpaquePanel(suspicions)) throw new Error("expected modeled panels")
    expect(tide.title).toEqual({ en: "Tide", zh: "潮汐" })
    expect(tide.slot).toBe("sidebar")
    expect(tide.audience).toBe("all")
    expect(tide.blocks[0].fields.value).toEqual({ mode: "var", path: "tide" })
    expect(tide.blocks[1].visibleWhen).toBe("tide >= 8")

    // A plain-string title is an en-only label, exactly as the schema reads it.
    expect(suspicions.title).toEqual({ en: "Suspicions", zh: "" })
    expect(suspicions.slot).toBe("tray")
    expect(suspicions.audience).toBe("keeper")
    // `{repeat: {prefix, block}}` flattens into one block plus its prefix — repeat
    // cannot nest, so an editor never needs a tree here. A condition on the WRAPPER
    // (the whole repeat) is kept apart from the inner block's per-instance one.
    expect(suspicions.blocks[0].kind).toBe("stat")
    expect(suspicions.blocks[0].repeatPrefix).toBe("suspect.")
    expect(suspicions.blocks[0].repeatVisibleWhen).toBe("tide >= 2")
    expect(suspicions.blocks[0].visibleWhen).toBe("")
    // zh-only text, a boolean literal, and a choices block are all engine-valid shapes.
    expect(suspicions.blocks[1].fields.label).toEqual({ en: "", zh: "已报警" })
    expect(suspicions.blocks[1].fields.value).toEqual({ mode: "literal", value: true })
    expect(suspicions.blocks[2].kind).toBe("choices")
    expect(suspicions.blocks[2].fields.options).toMatchObject({
      mode: "options",
      options: [{ id: "look", label: { en: "Look around", zh: "环顾" }, input: ".ra 侦查" }],
    })
  })

  it("writes the hand-written file back in the shapes the ENGINE accepts", () => {
    // Every one of these was checked against `core.panels.parse_panels_text`: a slot
    // outside sidebar|tray|modal, an `{en: ""}` beside a zh text, and a wrapper
    // condition folded into the inner block are each either refused or a different
    // panel from what the author wrote.
    const written = parseYaml(serializePanelsYaml(parsePanelsYaml(HAND_WRITTEN).document)) as {
      panels: { slot: string; blocks: Record<string, unknown>[] }[]
    }
    expect(written.panels[1].slot).toBe("tray")
    const [repeated, flagged, choices] = written.panels[1].blocks
    expect(repeated).toEqual({
      repeat: {
        prefix: "suspect.",
        block: { kind: "stat", label: { $leaf: "label" }, value: { $leaf: "value" } },
      },
      visible_when: "tide >= 2",
    })
    expect(flagged).toEqual({ kind: "stat", label: { zh: "已报警" }, value: true })
    expect(choices).toEqual({
      kind: "choices",
      prompt: { en: "What now?", zh: "现在呢？" },
      options: [{ id: "look", label: { en: "Look around", zh: "环顾" }, input: ".ra 侦查" }],
    })
  })

  it("carries a block it does not model through verbatim, in place — never dropped", () => {
    // A kind the engine grows after this file, or a shape the form cannot hold: kept
    // exactly as written, still there on save, and NOT counted as an error.
    const yaml = `panels:
  - id: hud
    title: HUD
    slot: sidebar
    blocks:
      - {kind: stat, label: A, value: 1}
      - {kind: hologram, depth: 3, label: {en: Ghost}}
      - {kind: stat, label: B, value: 2}
`
    const { document, opaqueBlocks } = parsePanelsYaml(yaml)
    expect(opaqueBlocks).toBe(1)
    const hud = document.panels[0]
    if (isOpaquePanel(hud)) throw new Error("expected modeled panel")
    expect(hud.blocks.map((block) => block.kind)).toEqual(["stat", "hologram", "stat"])
    expect(hud.blocks[1].raw).toEqual({ kind: "hologram", depth: 3, label: { en: "Ghost" } })
    expect(problemsFor(document, new Set())).toEqual([])

    const written = parseYaml(serializePanelsYaml(document)) as { panels: { blocks: unknown[] }[] }
    expect(written.panels[0].blocks[1]).toEqual({ kind: "hologram", depth: 3, label: { en: "Ghost" } })
  })

  it("round-trips: what it writes back parses to the same model", () => {
    const first = parsePanelsYaml(HAND_WRITTEN).document
    const second = parsePanelsYaml(serializePanelsYaml(first)).document

    // uids are per-parse identity, not content: blank every one before comparing.
    const strip = (document: typeof first) =>
      JSON.stringify(document.panels, (key, value) => (key === "uid" ? "" : value))
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
    expect(document.panels).toHaveLength(1)
    expect(isOpaquePanel(document.panels[0])).toBe(true)

    const written = parseYaml(serializePanelsYaml(document)) as { panels: Record<string, unknown>[] }
    expect(written.panels[0].entry).toBe("ui/board/index.html")
    expect(written.panels[0].assets).toEqual(["ui/board/app.js"])
  })

  it("keeps a tier-2 panel between modeled ones — order is the file's, not modeled-then-opaque", () => {
    const yaml = `panels:
  - id: hud
    title: HUD
    slot: sidebar
    blocks:
      - {kind: stat, label: A, value: 1}
  - id: board
    title: Board
    slot: sidebar
    entry: ui/board/index.html
    assets: [ui/board/app.js]
  - id: map
    title: Map
    slot: modal
    blocks:
      - {kind: image, src: assets/map.png}
`
    const { document } = parsePanelsYaml(yaml)
    expect(document.panels.map((panel) => panel.id)).toEqual(["hud", "board", "map"])
    expect(isOpaquePanel(document.panels[0])).toBe(false)
    expect(isOpaquePanel(document.panels[1])).toBe(true)
    expect(isOpaquePanel(document.panels[2])).toBe(false)

    const written = parseYaml(serializePanelsYaml(document)) as { panels: { id: string }[] }
    expect(written.panels.map((panel) => panel.id)).toEqual(["hud", "board", "map"])
    expect(written.panels[1]).toMatchObject({ id: "board", entry: "ui/board/index.html" })
  })

  it("keeps an unknown slot as written instead of rewriting it to sidebar", () => {
    const yaml = `panels:
  - id: hud
    title: HUD
    slot: overlay
    blocks:
      - {kind: stat, label: A, value: 1}
`
    const { document } = parsePanelsYaml(yaml)
    const panel = document.panels[0]
    if (isOpaquePanel(panel)) throw new Error("expected modeled panel")
    expect(panel.slot).toBe("overlay")
    expect(problemsFor(document, new Set()).map((problem) => problem.key)).toContain("unknownSlot")

    const written = parseYaml(serializePanelsYaml(document)) as { panels: { slot: string }[] }
    expect(written.panels[0].slot).toBe("overlay")
  })

  it("writes extra keys back instead of dropping them", () => {
    const yaml = `panels:
  - id: hud
    title: HUD
    slot: sidebar
    icon: lantern
    blocks:
      - {kind: stat, label: A, value: 1, tooltip: hi}
`
    const { document } = parsePanelsYaml(yaml)
    const panel = document.panels[0]
    if (isOpaquePanel(panel)) throw new Error("expected modeled panel")
    expect(panel.rest).toEqual({ icon: "lantern" })
    expect(panel.blocks[0].rest).toEqual({ tooltip: "hi" })
    // Kept, but reported: the engine's `_require_keys` refuses them at build.
    expect(problemsFor(document, new Set()).filter((problem) => problem.key === "unknownKeys")).toEqual([
      { key: "unknownKeys", params: { at: "hud", keys: "icon" } },
      { key: "unknownKeys", params: { at: "hud #1", keys: "tooltip" } },
    ])

    const text = serializePanelsYaml(document)
    const written = parseYaml(text) as {
      panels: { icon?: unknown; blocks: { tooltip?: unknown }[] }[]
    }
    expect(written.panels[0].icon).toBe("lantern")
    expect(written.panels[0].blocks[0].tooltip).toBe("hi")
    // …and they stay BEHIND the keys the editor models, rather than jumping to
    // the front of every mapping they appear in.
    expect(Object.keys(written.panels[0])).toEqual(["id", "title", "slot", "blocks", "icon"])
    expect(Object.keys(written.panels[0].blocks[0])).toEqual(["kind", "label", "value", "tooltip"])
  })

  it("keeps a quoted YAML string a string — the serializer does not guess", () => {
    const yaml = `panels:
  - id: hud
    title: HUD
    slot: sidebar
    blocks:
      - {kind: stat, label: A, value: "true"}
      - {kind: stat, label: B, value: "12"}
`
    const { document } = parsePanelsYaml(yaml)
    const panel = document.panels[0]
    if (isOpaquePanel(panel)) throw new Error("expected modeled panel")
    expect(panel.blocks[0].fields.value).toEqual({ mode: "literal", value: "true" })
    expect(panel.blocks[1].fields.value).toEqual({ mode: "literal", value: "12" })

    const written = parseYaml(serializePanelsYaml(document)) as { panels: { blocks: { value: unknown }[] }[] }
    expect(written.panels[0].blocks[0].value).toBe("true")
    expect(written.panels[0].blocks[1].value).toBe("12")
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
    block.fields.value = literal(3)
    panel.blocks = [block]

    const written = parseYaml(serializePanelsYaml({ panels: [panel] })) as {
      panels: { title: unknown; blocks: { value: unknown }[] }[]
    }
    expect(written.panels[0].title).toBe("HUD")
    // A numeric literal stays a number, so `min`/`max` comparisons hold engine-side.
    expect(written.panels[0].blocks[0].value).toBe(3)
  })

  it("writes a zh-only text as {zh} — an empty `en` beside it is refused by the build", () => {
    const panel = newPanel()
    panel.id = "hud"
    panel.title = { en: "", zh: "状态板" }
    const block = newBlock("stat")
    block.fields.label = { en: "", zh: "灯笼" }
    block.fields.value = literal(3)
    panel.blocks = [block]

    const written = parseYaml(serializePanelsYaml({ panels: [panel] })) as {
      panels: { title: unknown; blocks: { label: unknown }[] }[]
    }
    expect(written.panels[0].title).toEqual({ zh: "状态板" })
    expect(written.panels[0].blocks[0].label).toEqual({ zh: "灯笼" })
  })

  it("keeps a boolean a boolean", () => {
    const panel = newPanel()
    panel.id = "hud"
    panel.title = { en: "HUD", zh: "" }
    const block = newBlock("stat")
    block.fields.label = { en: "Alarm", zh: "" }
    block.fields.value = literal(false)
    panel.blocks = [block]
    const written = parseYaml(serializePanelsYaml({ panels: [panel] })) as {
      panels: { blocks: { value: unknown }[] }[]
    }
    expect(written.panels[0].blocks[0].value).toBe(false)
  })

  it("drops an empty OPTIONAL field rather than writing a blank one", () => {
    const panel = newPanel()
    panel.id = "hud"
    panel.title = { en: "HUD", zh: "" }
    panel.blocks = [
      { ...newBlock("badge"), fields: { ...newBlock("badge").fields, label: { en: "Alert", zh: "" } } },
    ]

    const written = parseYaml(serializePanelsYaml({ panels: [panel] })) as {
      panels: { blocks: Record<string, unknown>[] }[]
    }
    expect(written.panels[0].blocks[0]).toEqual({ kind: "badge", label: "Alert" })
  })

  it("writes nothing at all for an empty document", () => {
    expect(serializePanelsYaml({ panels: [] })).toBe("")
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
    const suspicions = document.panels[1]
    if (isOpaquePanel(suspicions)) throw new Error("expected modeled panel")
    const repeated = suspicions.blocks[0]
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
    meter.fields.min = literal(10)
    meter.fields.max = literal(2)
    meter.fields.value = literal(5)
    panel.blocks = [meter]

    const keys = problemsFor({ panels: [panel] }, declared).map((problem) => problem.key)
    expect(keys).toContain("badId")
    expect(keys).toContain("noTitle")
    expect(keys).toContain("missingField") // the meter's label
    expect(keys).toContain("meterRange")

    const empty = newPanel()
    empty.id = "hud"
    empty.title = { en: "HUD", zh: "" }
    expect(problemsFor({ panels: [empty] }, declared).map((p) => p.key)).toContain("noBlocks")
  })

  it("flags a repeat item outside a repeat, and a binding where the engine takes none", () => {
    const document = parsePanelsYaml(`panels:
  - id: hud
    title: HUD
    slot: sidebar
    blocks:
      - {kind: stat, label: {$leaf: label}, value: 1}
      - {kind: image, src: {$var: tide}}
      - {kind: text, text: {en: hi}, style: {$var: tide}}
`).document
    const keys = problemsFor(document, declared).map((problem) => problem.key)
    expect(keys).toContain("leafOutsideRepeat")
    expect(keys.filter((key) => key === "bindingNotAllowed")).toHaveLength(2)
  })

  it("wants every option of a choices block whole", () => {
    const document = parsePanelsYaml(`panels:
  - id: hud
    title: HUD
    slot: sidebar
    blocks:
      - {kind: choices, options: [{id: a, label: {en: Go}, input: ""}, {id: "", label: {en: Stay}, input: stay}]}
      - {kind: choices, options: []}
`).document
    const keys = problemsFor(document, declared).map((problem) => problem.key)
    expect(keys.filter((key) => key === "optionIncomplete")).toHaveLength(2)
    expect(keys).toContain("missingField") // the empty options list
  })

  it("says nothing about bindings when the pack declares no variables yet", () => {
    const document = parsePanelsYaml(HAND_WRITTEN).document
    const keys = problemsFor(document, new Set<string>()).map((problem) => problem.key)
    expect(keys).not.toContain("unknownVar")
  })
})

describe("the field table", () => {
  it("is the whole wire vocabulary — every block kind and slot the engine has", () => {
    // `BLOCK_FIELDS` is typed over the protocol package's `PanelTemplateBlock` kinds
    // and `PANEL_SLOTS` over its pack-panel `PanelSlot`, so a kind or slot the engine
    // grows fails to COMPILE here; this pins the runtime lists to `core/panels.py`.
    expect(Object.keys(BLOCK_FIELDS).sort()).toEqual([
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
    ])
    expect([...PANEL_SLOTS]).toEqual(["sidebar", "tray", "modal"])
    expect(BLOCK_FIELDS.meter.filter((spec) => spec.required).map((spec) => spec.name)).toEqual([
      "label",
      "value",
      "min",
      "max",
    ])
  })
})
