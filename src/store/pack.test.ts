import { beforeEach, describe, expect, it } from "vitest"
import { buildDraftFromState, classifyJson, initvarLeaves, packExposeLines, usePackStore } from "./pack"

const encoder = new TextEncoder()

function heavyCardJson(): string {
  return JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "深渊之主",
      description: "harbor <%= getvar('mood') %>",
      creator_notes: "by someone",
      extensions: { loreweaver_hooks: ["on('turn_start', () => {})"] },
      character_book: {
        entries: [
          { comment: "[InitVar]", content: '{"理": {"好感度": [10, "0..100"]}, "secret_flag": true}' },
          { comment: "Pier", content: "plain lore" },
        ],
      },
    },
  })
}

function file(name: string, contents: string) {
  return { name, bytes: encoder.encode(contents), path: null }
}

function reset() {
  usePackStore.getState().reset()
}

describe("classifyJson", () => {
  it("tells cards, lorebooks and other JSON apart deterministically", () => {
    expect(classifyJson(JSON.parse(heavyCardJson()))).toBe("card")
    expect(classifyJson({ name: "X", description: "d" })).toBe("card")
    expect(classifyJson({ entries: [{ content: "a" }] })).toBe("lorebook")
    expect(classifyJson({ character_book: { entries: [] } })).toBe("lorebook")
    expect(classifyJson({ something: 1 })).toBe("asset")
    expect(classifyJson([1])).toBe("asset")
  })
})

describe("initvarLeaves", () => {
  it("strips decorators, merges multiple entries without overwriting", () => {
    const { leaves } = initvarLeaves([
      { content: '@@initial_variables\n{"a": 1, "n": {"x": 1}}' },
      { content: '{"a": 999, "b": 2, "n": {"y": 2}}' },
    ])
    // Insertion order: `n` was created by the first entry, so its subtree
    // (including the merged-in y) flattens before the second entry's new `b`.
    expect(leaves).toEqual([
      { path: "a", value: 1, description: "" },
      { path: "n.x", value: 1, description: "" },
      { path: "n.y", value: 2, description: "" },
      { path: "b", value: 2, description: "" },
    ])
  })
})

describe("pack store pipeline", () => {
  beforeEach(reset)

  it("classifies dropped files and locks world kind on machinery", async () => {
    const store = usePackStore.getState()
    await store.addFiles([
      file("Heavy Card.json", heavyCardJson()),
      file("world book.json", JSON.stringify({ entries: [{ content: "lore" }, { content: "x" }] })),
      file("notes.txt", "hello"),
    ])
    const items = usePackStore.getState().items
    expect(items.map((item) => item.kind)).toEqual(["card", "lorebook", "asset"])

    const card = items[0]
    expect(card.cardKind).toBe("world")
    expect(card.payloads).toEqual({ hooks: 1, initvarEntries: 1, ejsBlocks: 1 })
    expect(card.drafts.length).toBe(2)
    expect(items[1].entryCount).toBe(2)

    // The engine's rule survives manual edits: machinery ⇒ world.
    usePackStore.getState().updateItem(card.uid, { cardKind: "character" })
    expect(usePackStore.getState().items[0].cardKind).toBe("world")
  })

  it("builds a WorldPackDraft with skills extracted and hooks removed from the card copy", async () => {
    await usePackStore.getState().addFiles([file("heavy.json", heavyCardJson())])
    const card = usePackStore.getState().items[0]
    usePackStore.getState().updateItem(card.uid, { extractSkill: true, notesZh: "备注", notesEn: "note" })

    const draft = buildDraftFromState(usePackStore.getState().items, {
      id: "deep-pier",
      version: "0.1.0",
      nameEn: "Deep Pier",
      nameZh: "深渊码头",
      descriptionEn: "d",
      descriptionZh: "描述",
      authors: "someone",
      license: "MIT",
      rulepackPatch: "",
    })
    expect(draft.cards).toHaveLength(1)
    expect(draft.cards[0].kind).toBe("world")
    expect(draft.cards[0].jsonText).not.toContain("loreweaver_hooks")
    expect(draft.skills).toHaveLength(1)
    expect(draft.skills[0].hooks).toEqual(["on('turn_start', () => {})"])
  })

  it("suggests expose lines only for player-guessed prefixes of world cards", async () => {
    await usePackStore.getState().addFiles([file("heavy.json", heavyCardJson())])
    // 理.好感度 is player-guessed; secret_flag is keeper-guessed by name.
    expect(packExposeLines(usePackStore.getState().items)).toEqual([".var expose 理"])
  })
})
