// Synthetic fixtures modeled on the real-world shape these importers must
// survive ("双人成行 v10.0"-class files): ~250 prompts, roughly 2/3 disabled,
// the two-layer enable matrix, all 8 marker slots, dense variable macros.
// No third-party preset files are committed — everything here is generated.

import { describe, expect, it } from "vitest"
import {
  assembleSystemPrompt,
  effectivePromptList,
  isEffectivelyEnabled,
  MARKER_SLOTS,
  parseStPreset,
  resolveOrderGroup,
  scanMacros,
  toLlmSampling,
  unsentSamplingKeys,
} from "./stPreset"

// --- small full-coverage fixture -------------------------------------------

function duoStylePreset(): Record<string, unknown> {
  return {
    temperature: 1.3,
    top_p: 0.95,
    top_k: 40,
    top_a: 0.12,
    min_p: 0.05,
    frequency_penalty: 0.4,
    presence_penalty: 0.6,
    repetition_penalty: 1.07,
    seed: -1,
    n: 1,
    openai_max_tokens: 8192,
    openai_max_context: 128000,
    wi_format: "{0}",
    impersonation_prompt: "impersonation text",
    names_behavior: 0,
    prompts: [
      {
        identifier: "main",
        name: "Main",
        system_prompt: true,
        role: "system",
        content: "Core rules. {{setvar::mood::calm}} Speak as {{char}}.",
        enabled: true,
        marker: false,
        injection_position: 0,
        injection_depth: 4,
        forbid_overrides: false,
      },
      {
        identifier: "chatHistory",
        name: "Chat History",
        system_prompt: true,
        marker: true,
        content: "",
        enabled: true,
      },
      {
        identifier: "charDescription",
        name: "Char Description",
        system_prompt: true,
        marker: true,
        content: "",
        enabled: true,
      },
      // A marker that (incorrectly) carries content — must never leak as text.
      {
        identifier: "worldInfoBefore",
        name: "World Info",
        system_prompt: true,
        marker: true,
        content: "SHOULD NOT LEAK",
        enabled: true,
      },
      {
        identifier: "st-uuid-user-turn",
        name: "User nudge",
        role: "user",
        content: "Continue. {{random::a,b,c}} then {{getvar::mood}}",
        enabled: true,
        injection_position: 1,
        injection_depth: 1,
        injection_order: 100,
      },
      {
        identifier: "st-uuid-poolonly",
        name: "Pool only",
        role: "system",
        content: "NEVER IN ORDER",
        enabled: true,
      },
      {
        identifier: "st-uuid-promptoff",
        name: "Prompt layer off",
        role: "system",
        content: "PROMPT LAYER OFF",
        enabled: false,
      },
      {
        identifier: "st-uuid-orderoff",
        name: "Order layer off",
        role: "system",
        content: "ORDER LAYER OFF",
        enabled: true,
      },
      // marker with an identifier outside the 8 standard slots
      { identifier: "customAnchor", name: "Weird marker", marker: true, content: "", enabled: true },
      // nearly-empty entry: every missing field takes its ST default
      { identifier: "st-uuid-sparse", content: "Sparse fields survive with defaults" },
      // no identifier → malformed, kept verbatim
      { name: "broken", content: "MALFORMED" },
      {
        identifier: "st-uuid-extra",
        name: "Extra fields",
        content: "extra",
        enabled: false,
        custom_st_field: { nested: true },
      },
    ],
    prompt_order: [
      // decoy: the legacy 100000 pseudo-character — 100001 must win
      { character_id: 100000, order: [{ identifier: "main", enabled: false }] },
      {
        character_id: 100001,
        order: [
          { identifier: "main", enabled: true },
          { identifier: "worldInfoBefore", enabled: true },
          { identifier: "charDescription", enabled: true },
          { identifier: "st-uuid-promptoff", enabled: true },
          { identifier: "st-uuid-orderoff", enabled: false },
          { identifier: "st-uuid-user-turn", enabled: true },
          { identifier: "chatHistory", enabled: true },
          { identifier: "st-uuid-sparse", enabled: true },
          { identifier: "st-uuid-extra", enabled: false },
          { identifier: "ghost-not-in-pool", enabled: true },
        ],
      },
    ],
    extensions: { regex_scripts: [{ scriptName: "smooth" }], tavern_helper: { version: 3 } },
  }
}

function parseDuo() {
  const { preset, error } = parseStPreset(JSON.stringify(duoStylePreset()), "duo")
  expect(error).toBeNull()
  expect(preset).not.toBeNull()
  return preset!
}

describe("parseStPreset", () => {
  it("fails closed on garbage", () => {
    expect(parseStPreset("not json{", "x").preset).toBeNull()
    expect(parseStPreset("[1,2]", "x").error).toMatch(/not a JSON object/)
    expect(parseStPreset('"str"', "x").preset).toBeNull()
  })

  it("accepts a sampling-only preset (no prompts at all)", () => {
    const { preset, error } = parseStPreset(JSON.stringify({ temperature: 0.5 }), "bare")
    expect(error).toBeNull()
    expect(preset!.prompts).toHaveLength(0)
    expect(preset!.sampling.temperature).toBe(0.5)
  })

  it("maps every documented sampling field and keeps unknown top-level keys raw", () => {
    const preset = parseDuo()
    expect(preset.sampling).toEqual({
      temperature: 1.3,
      topP: 0.95,
      topK: 40,
      topA: 0.12,
      minP: 0.05,
      frequencyPenalty: 0.4,
      presencePenalty: 0.6,
      repetitionPenalty: 1.07,
      seed: -1,
      n: 1,
      maxTokens: 8192,
      maxContext: 128000,
    })
    expect(preset.rawTopLevel.wi_format).toBe("{0}")
    expect(preset.rawTopLevel.impersonation_prompt).toBe("impersonation text")
    expect(preset.rawTopLevel).not.toHaveProperty("temperature")
    expect(preset.rawTopLevel).not.toHaveProperty("prompts")
    expect(preset.rawTopLevel).not.toHaveProperty("extensions")
  })

  it("keeps a non-finite sampling value raw instead of mapping it", () => {
    const { preset } = parseStPreset(JSON.stringify({ temperature: "hot" }), "odd")
    expect(preset!.sampling).toEqual({})
    expect(preset!.rawTopLevel.temperature).toBe("hot")
    expect(preset!.warnings.some((w) => w.includes("temperature"))).toBe(true)
  })

  it("normalizes prompts tolerantly: defaults for sparse entries, raw kept verbatim", () => {
    const preset = parseDuo()
    expect(preset.prompts).toHaveLength(11)
    expect(preset.malformedPrompts).toHaveLength(1)

    const sparse = preset.prompts.find((p) => p.identifier === "st-uuid-sparse")!
    expect(sparse.enabled).toBe(true)
    expect(sparse.role).toBe("system")
    expect(sparse.injectionPosition).toBe(0)
    expect(sparse.injectionDepth).toBe(4)
    expect(sparse.marker).toBe(false)

    const extra = preset.prompts.find((p) => p.identifier === "st-uuid-extra")!
    expect(extra.raw.custom_st_field).toEqual({ nested: true })

    const userTurn = preset.prompts.find((p) => p.identifier === "st-uuid-user-turn")!
    expect(userTurn.role).toBe("user")
    expect(userTurn.injectionPosition).toBe(1)
    expect(userTurn.injectionDepth).toBe(1)
    expect(userTurn.injectionOrder).toBe(100)
  })

  it("treats markers as anchors: content dropped from the normalized entry, slot resolved", () => {
    const preset = parseDuo()
    const wib = preset.prompts.find((p) => p.identifier === "worldInfoBefore")!
    expect(wib.marker).toBe(true)
    expect(wib.slot).toBe("worldInfoBefore")
    expect(wib.content).toBe("")
    expect(wib.raw.content).toBe("SHOULD NOT LEAK")

    const custom = preset.prompts.find((p) => p.identifier === "customAnchor")!
    expect(custom.marker).toBe(true)
    expect(custom.slot).toBeNull()
    expect(preset.warnings.some((w) => w.includes("customAnchor"))).toBe(true)
  })

  it("keeps extensions verbatim and never executes them", () => {
    const preset = parseDuo()
    expect(preset.extensions.regex_scripts).toEqual([{ scriptName: "smooth" }])
    expect(preset.extensions.tavern_helper).toEqual({ version: 3 })
  })
})

describe("two-layer enablement + ordering", () => {
  it("resolves pseudo-character 100001 over 100000", () => {
    const preset = parseDuo()
    const group = resolveOrderGroup(preset.promptOrder)!
    expect(group.characterId).toBe("100001")
    expect(group.order.length).toBe(10)
  })

  it("computes effective = both layers enabled, sequence from the order list", () => {
    const preset = parseDuo()
    const views = effectivePromptList(preset)
    expect(views).toHaveLength(11)

    const sequence = views.filter((v) => v.position !== null).map((v) => v.entry.identifier)
    expect(sequence).toEqual([
      "main",
      "worldInfoBefore",
      "charDescription",
      "st-uuid-promptoff",
      "st-uuid-orderoff",
      "st-uuid-user-turn",
      "chatHistory",
      "st-uuid-sparse",
      "st-uuid-extra",
    ])

    const byId = new Map(views.map((v) => [v.entry.identifier, v]))
    expect(byId.get("main")!.effective).toBe(true)
    expect(byId.get("st-uuid-promptoff")!.effective).toBe(false) // prompts layer off
    expect(byId.get("st-uuid-promptoff")!.orderEnabled).toBe(true)
    expect(byId.get("st-uuid-orderoff")!.effective).toBe(false) // order layer off
    expect(byId.get("st-uuid-orderoff")!.promptEnabled).toBe(true)
    expect(byId.get("st-uuid-poolonly")!.orderEnabled).toBeNull() // absent from order
    expect(byId.get("st-uuid-poolonly")!.effective).toBe(false)
    expect(byId.get("st-uuid-sparse")!.effective).toBe(true)
  })

  it("layers overrides without touching the imported matrix", () => {
    const preset = parseDuo()
    const view = effectivePromptList(preset).find((v) => v.entry.identifier === "st-uuid-promptoff")!
    expect(isEffectivelyEnabled(view, {})).toBe(false)
    expect(isEffectivelyEnabled(view, { "st-uuid-promptoff": true })).toBe(true)
    expect(view.promptEnabled).toBe(false) // matrix untouched
  })
})

describe("assembleSystemPrompt", () => {
  it("fills marker slots from caller context and never leaks marker/disabled text", () => {
    const preset = parseDuo()
    const assembled = assembleSystemPrompt(preset, {}, { charDescription: "A lighthouse keeper." })

    const segments = assembled.system.split("\n\n")
    expect(segments[0]).toContain("Core rules.")
    expect(segments[1]).toBe("A lighthouse keeper.")
    expect(assembled.usedSlots).toEqual(["charDescription"])
    expect(assembled.emptySlots).toEqual(["worldInfoBefore", "chatHistory"])
    expect(assembled.segmentCount).toBe(3) // main + user nudge + sparse

    expect(assembled.system).not.toContain("SHOULD NOT LEAK")
    expect(assembled.system).not.toContain("PROMPT LAYER OFF")
    expect(assembled.system).not.toContain("ORDER LAYER OFF")
    expect(assembled.system).not.toContain("NEVER IN ORDER")
    expect(assembled.system).not.toContain("MALFORMED")
    // Macros ride along verbatim — no static expansion.
    expect(assembled.system).toContain("{{setvar::mood::calm}}")
  })

  it("honors overrides in both directions", () => {
    const preset = parseDuo()
    const on = assembleSystemPrompt(preset, { "st-uuid-promptoff": true }, {})
    expect(on.system).toContain("PROMPT LAYER OFF")
    const off = assembleSystemPrompt(preset, { main: false }, {})
    expect(off.system).not.toContain("Core rules.")
  })
})

describe("macro report", () => {
  it("counts macro names, marks runtime support honestly", () => {
    const preset = parseDuo()
    const names = Object.fromEntries(preset.macroReport.uses.map((u) => [u.name, u.count]))
    expect(names).toEqual({ setvar: 1, char: 1, random: 1, getvar: 1 })
    expect(preset.macroReport.total).toBe(4)
    // This runtime expands nothing yet — the report must say so.
    expect(preset.macroReport.uses.every((u) => !u.supported)).toBe(true)
  })

  it("handles single-colon macro forms and comment macros", () => {
    const report = scanMacros([
      {
        identifier: "x",
        name: "",
        content: "{{roll:1d6}} {{random:a,b}} {{// note to self}} {{USER}}",
        role: "system",
        enabled: true,
        marker: false,
        slot: null,
        systemPrompt: false,
        forbidOverrides: false,
        injectionPosition: 0,
        injectionDepth: 4,
        raw: {},
      },
    ])
    const names = Object.fromEntries(report.uses.map((u) => [u.name, u.count]))
    expect(names).toEqual({ roll: 1, random: 1, "//": 1, user: 1 })
  })
})

describe("sampling → wire params", () => {
  it("sends only standard knobs and filters the random seed", () => {
    const preset = parseDuo()
    expect(toLlmSampling(preset.sampling)).toEqual({
      temperature: 1.3,
      topP: 0.95,
      topK: 40,
      frequencyPenalty: 0.4,
      presencePenalty: 0.6,
    })
    expect(toLlmSampling({ seed: 42 })).toEqual({ seed: 42 })
  })

  it("reports display-only keys for the UI badge", () => {
    const preset = parseDuo()
    expect(unsentSamplingKeys(preset.sampling).sort()).toEqual(
      ["maxContext", "maxTokens", "minP", "n", "repetitionPenalty", "seed", "topA"].sort(),
    )
  })
})

// --- 250-entry stress fixture ----------------------------------------------

function bigPreset(): Record<string, unknown> {
  const prompts: Record<string, unknown>[] = MARKER_SLOTS.map((slot) => ({
    identifier: slot,
    name: slot,
    marker: true,
    content: "",
    enabled: true,
  }))
  const order: Record<string, unknown>[] = MARKER_SLOTS.map((slot) => ({
    identifier: slot,
    enabled: true,
  }))
  for (let i = 0; i < 242; i++) {
    prompts.push({
      identifier: `uuid-${i}`,
      name: `P${i}`,
      role: i % 2 === 0 ? "system" : "user",
      content: `Segment ${i}. {{getvar::v${i % 7}}}`,
      enabled: i % 3 !== 1,
      injection_position: i % 5 === 0 ? 1 : 0,
      injection_depth: i % 5 === 0 ? 1 : 4,
    })
    order.push({ identifier: `uuid-${i}`, enabled: i % 3 !== 2 })
  }
  return { temperature: 0.9, prompts, prompt_order: [{ character_id: 100001, order }] }
}

describe("250-entry stress import", () => {
  it("imports with zero loss and the expected enable split (~2/3 disabled)", () => {
    const { preset, error } = parseStPreset(JSON.stringify(bigPreset()), "big")
    expect(error).toBeNull()
    expect(preset!.prompts).toHaveLength(250)
    expect(preset!.malformedPrompts).toHaveLength(0)

    const views = effectivePromptList(preset!)
    expect(views).toHaveLength(250)
    const effective = views.filter((v) => isEffectivelyEnabled(v, {}))
    // 8 markers + every i ≡ 0 (mod 3) of the 242 plain prompts (81 of them).
    expect(effective).toHaveLength(89)
  })

  it("keeps macro counting and assembly linear over the full file", () => {
    const { preset } = parseStPreset(JSON.stringify(bigPreset()), "big")
    expect(preset!.macroReport.total).toBe(242)
    expect(preset!.macroReport.uses).toEqual([{ name: "getvar", count: 242, supported: false }])

    const assembled = assembleSystemPrompt(preset!, {}, {})
    expect(assembled.segmentCount).toBe(81)
    expect(assembled.emptySlots).toHaveLength(8)
    expect(assembled.system.split("\n\n")).toHaveLength(81)
  })
})
