import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import "../../../i18n"
import PresetManagerDialog from "./PresetManagerDialog"
import { usePresetStore } from "./presetStore"
import { parseStPreset } from "./stPreset"

function seedPreset(): string {
  const { preset } = parseStPreset(
    JSON.stringify({
      temperature: 1.1,
      top_a: 0.2,
      prompts: [
        { identifier: "main", name: "Main rules", content: "Be vivid. {{getvar::tone}}", enabled: true },
        { identifier: "charDescription", name: "Char Description", marker: true, content: "", enabled: true },
        { identifier: "off-entry", name: "Muted entry", content: "muted", enabled: false },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: "main", enabled: true },
            { identifier: "charDescription", enabled: true },
            { identifier: "off-entry", enabled: true },
          ],
        },
      ],
      extensions: { regex_scripts: [] },
    }),
    "写卡预设",
  )
  return usePresetStore.getState().addPreset(preset!)
}

describe("PresetManagerDialog", () => {
  beforeEach(() => {
    usePresetStore.setState({ presets: [], activeId: null })
  })

  it("lists stored presets with their effective stats", () => {
    seedPreset()
    render(<PresetManagerDialog onClose={() => {}} />)
    expect(screen.getByRole("button", { name: "写卡预设" })).toBeInTheDocument()
    expect(screen.getByText(/3 prompts · 2 effective/)).toBeInTheDocument()
  })

  it("shows the grouped preview and toggles via the override layer", async () => {
    const id = seedPreset()
    const user = userEvent.setup()
    render(<PresetManagerDialog onClose={() => {}} />)
    await user.click(screen.getByRole("button", { name: "写卡预设" }))

    expect(screen.getByText(/Injection slots \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/Effective \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/Disabled \(1\)/)).toBeInTheDocument()
    expect(screen.getByText("Main rules")).toBeInTheDocument()
    expect(screen.getByText("Character description (slot)")).toBeInTheDocument()
    // macro report + inactive ST extensions are surfaced
    expect(screen.getByText(/\{\{getvar\}\}/)).toBeInTheDocument()
    expect(screen.getByText("regex_scripts")).toBeInTheDocument()

    // Toggling the muted entry lands in overrides, not in the imported matrix.
    const row = screen.getByText("Muted entry").closest("li")!
    await user.click(row.querySelector("input")!)
    const stored = usePresetStore.getState().presets.find((p) => p.id === id)!
    expect(stored.overrides).toEqual({ "off-entry": true })
    expect(stored.prompts.find((p) => p.identifier === "off-entry")!.enabled).toBe(false)
    expect(screen.getByText(/Effective \(2\)/)).toBeInTheDocument()
  })

  it("activates a preset for the forge", async () => {
    const id = seedPreset()
    const user = userEvent.setup()
    render(<PresetManagerDialog onClose={() => {}} />)
    await user.click(screen.getByRole("button", { name: "Use in forge" }))
    expect(usePresetStore.getState().activeId).toBe(id)
    expect(screen.getByText("in use")).toBeInTheDocument()
  })
})
