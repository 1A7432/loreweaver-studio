import { describe, expect, it } from "vitest"
import { parseStPreset, presetToStJson } from "./stPreset"

/** A preset with the awkward bits: an unmapped top-level field, a prompt with
 * fields the studio's model does not carry, a second enable layer, and ST-only
 * extensions the studio never runs. */
const SOURCE = JSON.stringify(
  {
    temperature: 0.85,
    some_future_knob: { nested: true },
    prompts: [
      {
        identifier: "main",
        name: "Main",
        content: "You are the Keeper.",
        role: "system",
        system_prompt: true,
        forbid_overrides: false,
        an_unmapped_field: 7,
      },
      { identifier: "chatHistory", name: "Chat History", marker: true },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: "main", enabled: true },
          { identifier: "chatHistory", enabled: false },
        ],
      },
    ],
    extensions: { regex_scripts: [{ scriptName: "x" }] },
  },
  null,
  2,
)

describe("presetToStJson", () => {
  it("rebuilds the imported document, unmapped fields and all", () => {
    // Import is lossless by design; that is what makes shipping one honest —
    // the pack carries the document the author imported, not a re-serialization
    // of the studio's own model.
    const { preset } = parseStPreset(SOURCE, "Corridor Keeper")
    const round = JSON.parse(presetToStJson(preset!)) as Record<string, unknown>

    // The sampling knobs were MAPPED on import; a preset that shipped without
    // its temperature would not be the one the author imported.
    expect(round.temperature).toBe(0.85)
    expect(round.some_future_knob).toEqual({ nested: true })
    expect(round.extensions).toEqual({ regex_scripts: [{ scriptName: "x" }] })

    const prompts = round.prompts as Record<string, unknown>[]
    expect(prompts).toHaveLength(2)
    // The prompt's own unmapped field survives the trip.
    expect(prompts[0].an_unmapped_field).toBe(7)
    expect(prompts[1].marker).toBe(true)

    const order = round.prompt_order as { character_id: string; order: { enabled: boolean }[] }[]
    expect(order[0].character_id).toBe("100001")
    expect(order[0].order.map((ref) => ref.enabled)).toEqual([true, false])
  })

  it("emits what the engine's parser requires", () => {
    // `core/preset.py::parse_st_preset` refuses anything without a non-empty
    // `prompts` array; everything below that degrades into its warnings.
    const { preset } = parseStPreset(SOURCE, "x")
    const round = JSON.parse(presetToStJson(preset!)) as { prompts: unknown[] }
    expect(Array.isArray(round.prompts)).toBe(true)
    expect(round.prompts.length).toBeGreaterThan(0)
  })

  it("carries a prompt too broken to normalize rather than dropping it", () => {
    const { preset } = parseStPreset(
      JSON.stringify({ prompts: [{ identifier: "ok", content: "a" }, { no: "identifier" }] }),
      "x",
    )
    expect(preset!.malformedPrompts).toHaveLength(1)
    const round = JSON.parse(presetToStJson(preset!)) as { prompts: unknown[] }
    expect(round.prompts).toHaveLength(2)
  })

  it("omits an empty prompt_order and empty extensions instead of writing noise", () => {
    const { preset } = parseStPreset(JSON.stringify({ prompts: [{ identifier: "a", content: "b" }] }), "x")
    const round = JSON.parse(presetToStJson(preset!)) as Record<string, unknown>
    expect(round).not.toHaveProperty("prompt_order")
    expect(round).not.toHaveProperty("extensions")
  })
})
