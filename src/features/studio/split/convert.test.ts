import { describe, expect, it } from "vitest"
import { normalizeCard } from "./charcard"
import { splitCard } from "./cardSplit"
import { characterHalfToStCard, splitToProject, stEntryToForgeLore } from "./convert"
import { promoteLeaves } from "./promote"

describe("characterHalfToStCard", () => {
  it("writes cleaned prose + filtered book back into the v3 envelope", () => {
    const card = normalizeCard({
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "Mara",
        description: "prose <%= ejs %>",
        system_prompt: "keep me",
        extensions: { loreweaver_hooks: ["h"], other: true },
        character_book: {
          name: "Book",
          entries: [
            { comment: "[InitVar]", content: "{}" },
            { comment: "Lore", content: "text" },
          ],
        },
      },
    })
    const { character } = splitCard(card)
    const rebuilt = characterHalfToStCard(character)
    const data = rebuilt.data as Record<string, unknown>
    expect(data.description).toBe("prose ")
    expect(data.system_prompt).toBe("keep me")
    expect(data.extensions).toEqual({ other: true })
    const book = data.character_book as { name: string; entries: unknown[] }
    expect(book.name).toBe("Book")
    expect(book.entries).toHaveLength(1)
  })
})

describe("stEntryToForgeLore", () => {
  it("maps V2 book names, folding @@if back into condition", () => {
    const entry = stEntryToForgeLore({
      comment: "The Well",
      content: "@@if suspicion >= 5\nDo not touch.",
      keys: ["well"],
      secondary_keys: ["night"],
      insertion_order: 7,
      position: "before_char",
      extensions: { selectiveLogic: 3, probability: 80, sticky: 2 },
    })
    expect(entry.title).toBe("The Well")
    expect(entry.condition).toBe("suspicion >= 5")
    expect(entry.content).toBe("Do not touch.")
    expect(entry.selectiveLogic).toBe("and_all")
    expect(entry.priority).toBe(7)
    expect(entry.probability).toBe(80)
    expect(entry.sticky).toBe(2)
    expect(entry.position).toBe("before")
  })

  it("maps ST-native world-info names (key/keysecondary/order/disable)", () => {
    const entry = stEntryToForgeLore({
      comment: "Native",
      content: "c",
      key: "a, b",
      keysecondary: ["x"],
      order: 3,
      disable: true,
    })
    expect(entry.keys).toBe("a, b")
    expect(entry.secondaryKeys).toBe("x")
    expect(entry.priority).toBe(3)
    expect(entry.enabled).toBe(false)
  })
})

describe("splitToProject", () => {
  it("lands character half + included promotions + hooks in one project", () => {
    const card = normalizeCard({
      name: "Mara",
      description: "d",
      extensions: { loreweaver_hooks: ["on('turn_start', f)"] },
      character_book: {
        entries: [
          { comment: "[InitVar]", content: '{"好感度": [10, "0..100"], "tags": ["a","b","c"]}' },
          { comment: "Lore", content: "plain" },
        ],
      },
    })
    const split = splitCard(card)
    const drafts = promoteLeaves([
      { path: "好感度", value: 10, description: "0..100" },
      { path: "tags", value: ["a", "b", "c"], description: "" },
    ])
    const project = splitToProject(split.character, split, drafts)
    expect(project.name).toBe("Mara")
    expect(project.lorebook).toHaveLength(1)
    expect(project.variables).toHaveLength(1) // the list stays in the MVU tree
    expect(project.hooks).toBe("on('turn_start', f)")
  })
})
