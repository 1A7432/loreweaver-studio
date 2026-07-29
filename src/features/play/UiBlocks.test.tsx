import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UiFrame } from "@loreweaver/protocol"
import "../../i18n"
import { useConnectionStore } from "../../store/connection"
import UiBlocks from "./UiBlocks"

vi.mock("../../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/transport")>()
  return { ...actual, transportSend: vi.fn().mockResolvedValue(undefined) }
})

import { transportSend } from "../../lib/transport"

const HUD: UiFrame = {
  type: "ui",
  panel: "sidebar",
  id: "hud",
  blocks: [
    { kind: "meter", label: "HP", value: 7, min: 0, max: 10 },
    { kind: "stat", label: "Doom", value: 3 },
    { kind: "badge", label: "omen", tone: "danger" },
    { kind: "text", text: "a whisper", style: "quote" },
    { kind: "divider" },
    {
      kind: "choices",
      prompt: "Pick",
      options: [{ id: "a", label: "Attack", input: ".ra fight" }],
    },
  ],
}

describe("UiBlocks", () => {
  beforeEach(() => {
    vi.mocked(transportSend).mockClear()
    useConnectionStore.setState({ status: "online" })
  })

  it("renders every v1.7 block kind", () => {
    const { container } = render(<UiBlocks frame={HUD} />)
    expect(screen.getByText("HP")).toBeInTheDocument()
    expect(screen.getByText("7/10")).toBeInTheDocument()
    expect(screen.getByText("Doom")).toBeInTheDocument()
    expect(screen.getByText("omen")).toHaveClass("badge-danger")
    expect(screen.getByText("a whisper")).toHaveClass("is-quote")
    expect(container.querySelector(".ui-divider")).not.toBeNull()
    expect(screen.getByText("Pick")).toBeInTheDocument()
  })

  it("sends a choice's input verbatim as a normal input frame", async () => {
    const user = userEvent.setup()
    render(<UiBlocks frame={HUD} />)
    await user.click(screen.getByRole("button", { name: "Attack" }))
    expect(transportSend).toHaveBeenCalledWith({ type: "input", text: ".ra fight" })
  })

  it("disables choices while not online", () => {
    useConnectionStore.setState({ status: "reconnecting" })
    render(<UiBlocks frame={HUD} />)
    expect(screen.getByRole("button", { name: "Attack" })).toBeDisabled()
  })
})
