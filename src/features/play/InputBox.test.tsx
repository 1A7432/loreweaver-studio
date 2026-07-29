import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { useConnectionStore } from "../../store/connection"
import InputBox from "./InputBox"

vi.mock("../../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/transport")>()
  return { ...actual, transportSend: vi.fn().mockResolvedValue(undefined) }
})

import { transportSend } from "../../lib/transport"

describe("InputBox", () => {
  beforeEach(() => {
    vi.mocked(transportSend).mockClear()
    useConnectionStore.setState({ status: "online" })
  })

  it("sends the typed text as an input frame and clears the field", async () => {
    const user = userEvent.setup()
    render(<InputBox />)
    const field = screen.getByRole("textbox")
    await user.type(field, "look around{Enter}")
    expect(transportSend).toHaveBeenCalledWith({ type: "input", text: "look around" })
    expect(field).toHaveValue("")
  })

  it("does not send blank input", async () => {
    const user = userEvent.setup()
    render(<InputBox />)
    await user.type(screen.getByRole("textbox"), "   {Enter}")
    expect(transportSend).not.toHaveBeenCalled()
  })

  it("is disabled unless the connection is online", () => {
    useConnectionStore.setState({ status: "reconnecting" })
    render(<InputBox />)
    expect(screen.getByRole("textbox")).toBeDisabled()
  })
})
