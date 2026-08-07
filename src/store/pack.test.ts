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
    // A stock ST world-info export carries name+description NEXT TO entries;
    // the root-level entries collection must beat the loose card heuristic.
    expect(classifyJson({ name: "Atlas", description: "city color", entries: [{ content: "a" }] })).toBe(
      "lorebook",
    )
    expect(classifyJson({ name: "Atlas", entries: { "0": { content: "a" } } })).toBe("lorebook")
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
    expect(card.payloads).toEqual({ hooks: 1, initvarEntries: 1, ejsBlocks: 1, secretEntries: 0 })
    expect(card.drafts.length).toBe(2)
    expect(items[1].entryCount).toBe(2)

    // The engine's rule survives manual edits: machinery ⇒ world.
    usePackStore.getState().updateItem(card.uid, { cardKind: "character" })
    expect(usePackStore.getState().items[0].cardKind).toBe("world")
  })

  it("pins a clean card to character in both directions (v2: kind is detected, never declared)", async () => {
    const store = usePackStore.getState()
    await store.addFiles([file("npc.json", JSON.stringify({ spec: "chara_card_v2", data: { name: "NPC" } }))])
    const card = usePackStore.getState().items[0]
    expect(card.cardKind).toBe("character")
    usePackStore.getState().updateItem(card.uid, { cardKind: "world" })
    expect(usePackStore.getState().items[0].cardKind).toBe("character")
  })

  it("folds a native bundle's typed variables specs into the world detection", async () => {
    const store = usePackStore.getState()
    // A specs-only lorecard: no hooks, no [InitVar] entry, no secret lore —
    // only typed specs. `core/pack.py:644-652` forces kind: world here.
    const bundle = {
      format: "loreweaver.card",
      format_version: 1,
      name: "林晚",
      description: "a plain persona with trackers",
      opening: "雨夜。",
      variables: [
        { id: "heat", kind: "number", minimum: 0, maximum: 10, default: 1 },
        { id: "mood", kind: "enum", options: ["calm", "tense"] },
        { id: "heat", kind: "number" }, // duplicate id — the engine skips it
      ],
      worldbook: [{ title: "Pier", content: "plain lore" }],
    }
    await store.addFiles([file("lin-wan.lorecard.json", JSON.stringify(bundle))])
    const card = usePackStore.getState().items[0]
    expect(card.kind).toBe("card")
    expect(card.cardKind).toBe("world")
    expect(card.payloads).toEqual({ hooks: 0, initvarEntries: 2, ejsBlocks: 0, secretEntries: 0 })
  })

  it("keeps a native bundle without any machinery a character card", async () => {
    const store = usePackStore.getState()
    const bundle = {
      format: "loreweaver.card",
      format_version: 1,
      name: "阿白",
      description: "no trackers at all",
      worldbook: [{ title: "Pier", content: "plain lore" }],
    }
    await store.addFiles([file("a-bai.lorecard.json", JSON.stringify(bundle))])
    const card = usePackStore.getState().items[0]
    expect(card.cardKind).toBe("character")
    expect(card.payloads?.initvarEntries).toBe(0)
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
      rulepackId: "",
    })
    expect(draft.cards).toHaveLength(1)
    // Manifest v2: the author draft carries NO kind — detection stamps it.
    expect(draft.cards[0]).not.toHaveProperty("kind")
    expect(draft.cards[0].jsonText).not.toContain("loreweaver_hooks")
    expect(draft.skills).toHaveLength(1)
    expect(draft.skills[0].hooks).toEqual(["on('turn_start', () => {})"])
  })

  it("suggests expose lines only for player-guessed prefixes of world cards", async () => {
    await usePackStore.getState().addFiles([file("heavy.json", heavyCardJson())])
    // 理.好感度 is player-guessed; secret_flag is keeper-guessed by name.
    expect(packExposeLines(usePackStore.getState().items)).toEqual([".var expose 理"])
  })

  it("carries asset items into the draft instead of dropping them silently", async () => {
    await usePackStore.getState().addFiles([file("cover art.png", "not a png at all")])
    const items = usePackStore.getState().items
    expect(items[0].kind).toBe("asset")
    const draft = buildDraftFromState(items, {
      id: "p",
      version: "0.1.0",
      nameEn: "P",
      nameZh: "",
      descriptionEn: "d",
      descriptionZh: "",
      authors: "a",
      license: "MIT",
      rulepackPatch: "",
      rulepackId: "",
    })
    expect(draft.assets).toEqual([{ fileName: items[0].fileName, base64: items[0].base64 }])
  })
})
