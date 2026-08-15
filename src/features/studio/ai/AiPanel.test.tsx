import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import "../../../i18n"
import AiPanel from "./AiPanel"
import { usePresetStore } from "./presetStore"
import { useAiStore } from "./provider"
import { parseStPreset } from "./stPreset"

function seedPreset(name: string, extra: Record<string, unknown> = {}): string {
  const { preset } = parseStPreset(
    JSON.stringify({
      ...extra,
      prompts: [{ identifier: "main", name: "Main", content: "Preset voice.", enabled: true }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }] }],
    }),
    name,
  )
  return usePresetStore.getState().addPreset(preset!)
}

const noop = () => {}

describe("AiPanel preset switching", () => {
  beforeEach(() => {
    usePresetStore.setState({ presets: [], activeId: null })
    useAiStore.setState({ kind: "openai", baseUrl: "", model: "", maxTokens: 16384, apiKey: "" })
  })

  it("offers built-in prompts plus every imported preset and switches the session", async () => {
    seedPreset("明月秋青")
    const user = userEvent.setup()
    render(<AiPanel onClose={noop} onOpenSettings={noop} onOpenPresets={noop} />)

    const select = screen.getByLabelText("Prompt preset")
    expect(select).toHaveValue("")
    await user.selectOptions(select, screen.getByRole("option", { name: "明月秋青" }))

    const active = usePresetStore.getState()
    expect(active.activeId).not.toBeNull()
    // The in-use line reports the assembled shape of the leading preset text.
    expect(screen.getByText(/Preset "明月秋青": 1 prompt segment/)).toBeInTheDocument()
  })

  it("warns when deepseek-v4-pro is paired with a preset temperature", async () => {
    seedPreset("热预设", { temperature: 1.2 })
    useAiStore.setState({ model: "deepseek-v4-pro" })
    const user = userEvent.setup()
    render(<AiPanel onClose={noop} onOpenSettings={noop} onOpenPresets={noop} />)

    expect(screen.queryByText(/degrades its thinking mode/)).not.toBeInTheDocument()
    await user.selectOptions(
      screen.getByLabelText("Prompt preset"),
      screen.getByRole("option", { name: "热预设" }),
    )
    expect(screen.getByText(/degrades its thinking mode/)).toBeInTheDocument()
  })
})
