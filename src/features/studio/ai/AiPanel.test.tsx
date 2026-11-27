import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import AiPanel from "./AiPanel"
import { useAiStore } from "./provider"

const noop = () => {}

describe("AiPanel", () => {
  beforeEach(() => {
    useAiStore.setState({ kind: "openai", baseUrl: "", model: "", maxTokens: 0, apiKey: "" })
  })

  it("offers the draft type and no prompt-preset controls", () => {
    render(<AiPanel onClose={noop} onOpenSettings={noop} />)

    expect(screen.getByLabelText("Draft type")).toHaveValue("world")
    expect(screen.queryByLabelText("Prompt preset")).not.toBeInTheDocument()
    expect(screen.queryByText(/Manage presets/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/degrades its thinking mode/)).not.toBeInTheDocument()
  })

  it("switches the draft type before a conversation starts", async () => {
    const user = userEvent.setup()
    render(<AiPanel onClose={noop} onOpenSettings={noop} />)

    await user.selectOptions(screen.getByLabelText("Draft type"), "character")
    expect(screen.getByLabelText("Draft type")).toHaveValue("character")
  })

  it("asks for a provider setup and points at the settings dialog", async () => {
    const onOpenSettings = vi.fn()
    const user = userEvent.setup()
    render(<AiPanel onClose={noop} onOpenSettings={onOpenSettings} />)

    expect(screen.getByText(/Configure a provider, model and API key first/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Generate draft" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Open settings" }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})
