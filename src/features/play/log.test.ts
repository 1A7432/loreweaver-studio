import { describe, expect, it } from "vitest"
import type { Draft, EventFrame } from "loreweaver-protocol/v3"
import { itemBlocks, logItems } from "./log"

function blocks(seq: number, id: string, title: string, replace?: boolean): EventFrame {
  return {
    type: "event",
    seq,
    id,
    ts: seq,
    kind: "blocks",
    data: { blocks: [{ kind: "title_card", title }], ...(replace ? { replace } : {}) },
  }
}

function line(seq: number): EventFrame {
  return {
    type: "event",
    seq,
    id: `n${seq}`,
    ts: seq,
    kind: "narrative",
    data: { speaker: "kp", text: `line ${seq}`, format: "markdown" },
  }
}

describe("logItems", () => {
  it("lists the events in order, then the drafts after everything", () => {
    const drafts: Draft[] = [{ id: "d1", text: "The fog" }]
    expect(logItems([line(1), line(4)], drafts).map((item) => item.key)).toEqual(["e1", "e4", "dd1"])
  })

  it("draws a replacement where the blocks it replaces were, and not again", () => {
    const items = logItems([blocks(1, "b", "Act I"), line(2), blocks(3, "b", "Act II", true)], [])
    expect(items.map((item) => item.key)).toEqual(["e1", "e2"])
    const first = items[0]
    expect(first.kind === "event" && itemBlocks(first)?.blocks[0]).toEqual({
      kind: "title_card",
      title: "Act II",
    })
  })

  it("keeps a second blocks event with the same id that does not ask to replace", () => {
    const items = logItems([blocks(1, "b", "Act I"), blocks(2, "b", "Act II")], [])
    expect(items.map((item) => item.key)).toEqual(["e1", "e2"])
  })
})
