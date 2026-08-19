// Installing a community pack is the person who OPENED the table doing it, not
// the author in Studio: the entry lives here, only for the keeper seat, and it
// says nothing about the outcome that the server's own receipt does not.

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PlayerRole } from "@loreweaver/protocol"

const sent: unknown[] = []
vi.mock("../../../lib/transport", () => ({
  TRANSPORT_EVENT: "loreweaver://transport",
  isTauri: () => true,
  transportSend: async (frame: unknown) => {
    sent.push(frame)
  },
}))

import "../../../i18n"
import { useConnectionStore } from "../../../store/connection"
import ModuleScreen from "./ModuleScreen"

function seat(role: PlayerRole) {
  useConnectionStore.setState({
    status: "online",
    welcome: {
      type: "welcome",
      protocol: "2.3",
      room: "midnight-pier",
      you: { id: "p1", name: "Nyx", role },
      locale: "en",
      server: "loreweaver",
    },
  })
}

describe("ModuleScreen — community packs", () => {
  beforeEach(() => {
    sent.length = 0
    seat("keeper")
  })

  it("sends the reference as an ordinary .pack install command", async () => {
    const user = userEvent.setup()
    render(<ModuleScreen onBack={() => {}} />)
    const field = screen.getByLabelText("Pack reference")
    const button = screen.getByRole("button", { name: "Install (.pack install)" })
    // Nothing to install yet.
    expect(button).toBeDisabled()

    await user.type(field, "  gh:1A7432/antu@v1.0.0  ")
    await user.click(button)
    expect(sent).toEqual([{ type: "input", text: ".pack install gh:1A7432/antu@v1.0.0" }])
    expect(field).toHaveValue("")
  })

  it("is not offered to a player seat", () => {
    seat("player")
    render(<ModuleScreen onBack={() => {}} />)
    expect(screen.queryByLabelText("Pack reference")).toBeNull()
  })
})
