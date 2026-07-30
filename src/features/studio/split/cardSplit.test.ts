// Alignment tests: these cases mirror the engine's `core/card_split.py`
// semantics — if one fails after an upstream change, re-diff against the
// Python source rather than "fixing" the expectation.

import { describe, expect, it } from "vitest"
import { normalizeCard } from "./charcard"
import {
  cardHookCodes,
  isVariableDeclarationEntry,
  payloadsAny,
  splitCard,
  splitDecorators,
  stripEjs,
} from "./cardSplit"

describe("stripEjs", () => {
  it("removes each span independently (non-greedy) and counts them", () => {
    const { clean, removed } = stripEjs("a <%= x %> b <% if (y) { %> c <% } %> d")
    expect(clean).toBe("a  b  c  d")
    expect(removed).toBe(3)
  })

  it("strips a dangling opener to end-of-text, fail closed", () => {
    const { clean, removed } = stripEjs("safe <% setvar('k', 1)")
    expect(clean).toBe("safe ")
    expect(removed).toBe(1)
  })

  it("passes plain text through untouched", () => {
    expect(stripEjs("no templates here")).toEqual({ clean: "no templates here", removed: 0 })
  })
})

describe("splitDecorators", () => {
  it("maps @@if to its expression and flags to true, stopping at prose", () => {
    const { decorators, body } = splitDecorators("@@if stage === 2\n@@dont_activate\nThe lore body.")
    expect(decorators).toEqual({ if: "stage === 2", dont_activate: true })
    expect(body).toBe("The lore body.")
  })

  it("returns text unchanged when there are no decorators", () => {
    const text = "just lore"
    expect(splitDecorators(text)).toEqual({ decorators: {}, body: text })
  })

  it("skips blank lines between decorators", () => {
    const { decorators, body } = splitDecorators("@@initial_variables\n\n@@if x\nbody")
    expect(decorators).toEqual({ initial_variables: true, if: "x" })
    expect(body).toBe("body")
  })
})

describe("isVariableDeclarationEntry", () => {
  it("detects the three declaration shapes across title fields", () => {
    expect(isVariableDeclarationEntry({ title: "「[InitVar]变量初始化」", content: "{}" })).toBe(true)
    expect(isVariableDeclarationEntry({ comment: "[Initial Variables]", content: "{}" })).toBe(true)
    expect(isVariableDeclarationEntry({ name: "vars", content: "@@initial_variables\n{}" })).toBe(true)
    expect(isVariableDeclarationEntry({ title: "Plain lore", content: "text" })).toBe(false)
  })

  it("falls through empty title to comment then name (engine `or` chain)", () => {
    expect(isVariableDeclarationEntry({ title: "", comment: "", name: "initvar seed" })).toBe(true)
  })
})

describe("cardHookCodes", () => {
  it("reads v3 data.extensions, tolerating {code} entries and skipping blanks", () => {
    const raw = {
      spec: "chara_card_v3",
      data: { extensions: { loreweaver_hooks: ["on('turn_start', f)", { code: "code2" }, "  ", 42] } },
    }
    expect(cardHookCodes(raw)).toEqual(["on('turn_start', f)", "code2"])
  })

  it("falls back to root-level extensions", () => {
    expect(cardHookCodes({ extensions: { loreweaver_hooks: ["root hook"] } })).toEqual(["root hook"])
  })
})

function heavyCardRaw(): Record<string, unknown> {
  return {
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "深渊之主",
      description: "A persona. <%= getvar('mood') %>",
      personality: "calm",
      scenario: "harbor",
      first_mes: "hello <% if (x) { %>hidden<% } %>",
      mes_example: "",
      creator_notes: "notes",
      tags: ["horror"],
      extensions: { loreweaver_hooks: ["on('turn_start', () => {})"], other: 1 },
      character_book: {
        entries: [
          { comment: "[InitVar]", content: '{"好感度": [0, "0..100"]}', constant: true },
          { comment: "The Pier", content: "Lore with <%- ejs %> inside." },
          { comment: "Clean", content: "No templates." },
        ],
      },
    },
  }
}

describe("splitCard", () => {
  it("splits a heavy card into a stripped character half + counted payloads", () => {
    const card = normalizeCard(heavyCardRaw())
    const { character, payloads, hooks, initvarEntries } = splitCard(card)

    // 4 spans: one in description, two forming the if/close pair in first_mes,
    // one inside the surviving book entry.
    expect(payloads).toEqual({ hooks: 1, initvarEntries: 1, ejsBlocks: 4 })
    expect(payloadsAny(payloads)).toBe(true)
    expect(hooks).toEqual(["on('turn_start', () => {})"])
    expect(initvarEntries).toHaveLength(1)

    expect(character.description).toBe("A persona. ")
    expect(character.firstMes).toBe("hello hidden")
    expect(character.characterBook).toHaveLength(2)
    expect(character.characterBook[0].content).toBe("Lore with  inside.")

    // Hooks are gone from the character half's raw, other extensions kept.
    const data = character.raw.data as Record<string, unknown>
    expect(data.extensions).toEqual({ other: 1 })
    // The original card is never mutated.
    const originalData = card.raw.data as Record<string, unknown>
    expect(originalData.extensions).toHaveProperty("loreweaver_hooks")
  })

  it("reports all-zero payloads for a plain persona card", () => {
    const card = normalizeCard({ name: "Plain", description: "Just prose." })
    const { payloads } = splitCard(card)
    expect(payloads).toEqual({ hooks: 0, initvarEntries: 0, ejsBlocks: 0 })
    expect(payloadsAny(payloads)).toBe(false)
  })
})
