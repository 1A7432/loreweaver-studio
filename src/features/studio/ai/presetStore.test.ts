import { beforeEach, describe, expect, it } from "vitest"
import { usePresetStore } from "./presetStore"
import { parseStPreset } from "./stPreset"

function importedFixture() {
  const { preset } = parseStPreset(
    JSON.stringify({
      temperature: 0.8,
      prompts: [
        { identifier: "main", name: "Main", content: "rules", enabled: true },
        { identifier: "aux", name: "Aux", content: "extra", enabled: false },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "aux", enabled: true },
          ],
        },
      ],
    }),
    "fixture",
  )
  return preset!
}

function reset() {
  usePresetStore.setState({ presets: [], activeId: null })
}

describe("presetStore", () => {
  beforeEach(reset)

  it("adds a preset as a local asset and returns its id", () => {
    const id = usePresetStore.getState().addPreset(importedFixture())
    const stored = usePresetStore.getState().presets
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(id)
    expect(stored[0].name).toBe("fixture")
    expect(stored[0].overrides).toEqual({})
    expect(stored[0].importedAt).toBeTruthy()
  })

  it("keeps preview-time overrides passed at save", () => {
    const id = usePresetStore.getState().addPreset(importedFixture(), { aux: true })
    expect(usePresetStore.getState().presets[0].overrides).toEqual({ aux: true })
    expect(usePresetStore.getState().presets[0].id).toBe(id)
  })

  it("activates, deactivates and clears activation on delete", () => {
    const store = usePresetStore.getState()
    const id = store.addPreset(importedFixture())
    store.setActive(id)
    expect(usePresetStore.getState().activeId).toBe(id)
    usePresetStore.getState().removePreset(id)
    expect(usePresetStore.getState().activeId).toBeNull()
    expect(usePresetStore.getState().presets).toHaveLength(0)
  })

  it("sets, replaces and clears per-entry overrides", () => {
    const store = usePresetStore.getState()
    const id = store.addPreset(importedFixture())
    store.setOverride(id, "aux", true)
    expect(usePresetStore.getState().presets[0].overrides).toEqual({ aux: true })
    usePresetStore.getState().setOverride(id, "aux", false)
    expect(usePresetStore.getState().presets[0].overrides).toEqual({ aux: false })
    usePresetStore.getState().setOverride(id, "aux", null)
    expect(usePresetStore.getState().presets[0].overrides).toEqual({})
    usePresetStore.getState().setOverride(id, "main", false)
    usePresetStore.getState().clearOverrides(id)
    expect(usePresetStore.getState().presets[0].overrides).toEqual({})
  })

  it("renames without touching the imported payload", () => {
    const store = usePresetStore.getState()
    const id = store.addPreset(importedFixture())
    store.renamePreset(id, "明月秋青·写卡")
    const stored = usePresetStore.getState().presets[0]
    expect(stored.name).toBe("明月秋青·写卡")
    expect(stored.prompts).toHaveLength(2)
  })
})
