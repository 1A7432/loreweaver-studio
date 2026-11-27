import { describe, expect, it } from "vitest"
import { parsePanelsYaml } from "./panelsModel"
import {
  bindablePaths,
  commandIds,
  previewBlocks,
  previewEntry,
  sampleViewValue,
  schemaPaths,
  viewNames,
} from "./panelsPreview"
import { ME_VIEW_SCHEMA } from "loreweaver-protocol"

const YAML = `panels:
  - id: me
    title: {en: Me, zh: 我}
    slot: sidebar
    views: {me: me, tide: harbor/tide}
    blocks:
      - {kind: stat, label: {en: Name, zh: 姓名}, value: {$view: me.character.name}}
      - repeat:
          each: me.character.resources
          as: r
          block: {kind: meter, label: {$view: r.label}, value: {$view: r.value}, min: 0, max: {$view: r.max}}
      - {kind: image, src: ui/map.png, caption: Map}
      - {kind: text, text: Rising, visible_when: "tide.level > 5"}
  - id: board
    title: Board
    slot: modal
    views: {tide: harbor/tide}
    entry: ui/board.html
    fallback: null
`

const panels = parsePanelsYaml(YAML).document.panels

describe("previewBlocks", () => {
  it("evaluates a panel with the shared panelBlocks over sample values, in the viewer's language", () => {
    const values = new Map<string, unknown>([
      ["me", sampleViewValue("me", "player")],
      ["harbor/tide", { level: 7 }],
    ])
    const blocks = previewBlocks(panels[0], "zh", values)!
    expect(blocks[0]).toEqual({ kind: "stat", label: "姓名", value: "Ada Lovelace" })
    // One meter per resource in the engine's sample `me` view.
    const meters = blocks.filter((block) => block.kind === "meter")
    expect(meters.length).toBeGreaterThan(1)
    expect(blocks).toContainEqual({
      kind: "image",
      hash: "ui/map.png",
      mime: "image/png",
      size: 0,
      caption: "Map",
    })
    expect(blocks.at(-1)).toEqual({ kind: "text", text: "Rising" })
  })

  it("drops what misses and hides what a condition gates, fail closed", () => {
    const blocks = previewBlocks(panels[0], "en", new Map([["harbor/tide", { level: 2 }]]))!
    // No `me` view held: the stat and the repeat drop; the gate is false.
    expect(blocks.map((block) => block.kind)).toEqual(["image"])
  })

  it("draws nothing for a page without a fallback", () => {
    expect(previewBlocks(panels[1], "en", new Map())).toBeNull()
    expect(previewEntry(panels[1], "en").page).toEqual({ hash: "ui/board.html", size: 0, mime: "text/html" })
  })
})

describe("paths, views and commands offered", () => {
  it("lists a built-in view's schema paths under its handle", () => {
    const paths = schemaPaths(ME_VIEW_SCHEMA, "me").map((entry) => entry.path)
    expect(paths).toEqual(
      expect.arrayContaining(["me.member.name", "me.character.resources", "me.character.resources.0.value"]),
    )
    expect(
      schemaPaths(ME_VIEW_SCHEMA, "me").find((entry) => entry.path === "me.character.resources")?.list,
    ).toBe(true)
  })

  it("offers a repeat's element paths under its `as`", () => {
    const paths = bindablePaths([{ handle: "me", view: "me" }], {
      each: "me.character.resources",
      as: "r",
    }).map((entry) => entry.path)
    expect(paths).toEqual(expect.arrayContaining(["r.label", "r.value", "r.max"]))
  })

  it("offers the engine's command ids and the pack's module prefixes", () => {
    const ids = commandIds(["harbor"])
    expect(ids).toEqual(expect.arrayContaining(["roll", "import", "harbor/"]))
    expect(viewNames(["harbor"])).toEqual(
      expect.arrayContaining(["me", "variables", "admin/keys", "harbor/"]),
    )
    expect(viewNames([])).not.toContain("panels")
  })
})
