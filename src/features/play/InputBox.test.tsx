import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { useConnectionStore } from "../../store/connection"
import { useSessionStore } from "../../store/session"
import InputBox from "./InputBox"

vi.mock("../../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/transport")>()
  return { ...actual, transportSend: vi.fn().mockResolvedValue(undefined) }
})

import { transportSend } from "../../lib/transport"

describe("InputBox", () => {
  beforeEach(() => {
    vi.mocked(transportSend).mockClear()
    vi.mocked(transportSend).mockResolvedValue(undefined)
    useSessionStore.getState().clear()
    useConnectionStore.setState({
      status: "online",
      welcome: {
        type: "welcome",
        protocol: "2.3",
        room: "midnight-pier",
        you: { id: "p1", name: "Nyx", role: "player" },
        locale: "en",
        server: "loreweaver",
      },
    })
  })

  it("sends the typed text as an input frame and clears the field", async () => {
    const user = userEvent.setup()
    render(<InputBox />)
    const field = screen.getByRole("textbox")
    await user.type(field, "look around{Enter}")
    expect(transportSend).toHaveBeenCalledWith({ type: "input", text: "look around" })
    expect(field).toHaveValue("")
  })

  it("echoes the line locally the moment it is sent", async () => {
    const user = userEvent.setup()
    render(<InputBox />)
    await user.type(screen.getByRole("textbox"), "I check the ledger.{Enter}")
    const entries = useSessionStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: "pending",
      pending: { speaker: "Nyx", text: "I check the ledger." },
    })
  })

  it("marks the echo undelivered when the send itself fails", async () => {
    const user = userEvent.setup()
    vi.mocked(transportSend).mockRejectedValueOnce(new Error("offline"))
    render(<InputBox />)
    await user.type(screen.getByRole("textbox"), ".ra spot hidden{Enter}")
    await waitFor(() => {
      const entry = useSessionStore.getState().entries[0]
      if (!(entry.kind === "pending" && entry.pending.failed)) throw new Error("not failed yet")
    })
    const entry = useSessionStore.getState().entries[0]
    expect(entry).toMatchObject({ kind: "pending", pending: { text: ".ra spot hidden", failed: true } })
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
