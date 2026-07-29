import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WelcomeFrame } from "@loreweaver/protocol"
import "../../i18n"
import { useConnectionStore } from "../../store/connection"
import { useSessionStore } from "../../store/session"
import PlayView from "./PlayView"

const WELCOME: WelcomeFrame = {
  type: "welcome",
  protocol: "1.7",
  room: "r1",
  you: { id: "u1", name: "Nyx", role: "keeper" },
  locale: "en",
  server: "loreweaver/1",
}

function reset() {
  useConnectionStore.setState({ status: "offline", attempt: 0, lastError: null, welcome: null })
  useSessionStore.getState().clear()
}

describe("PlayView", () => {
  beforeEach(reset)

  it("disables connect until ticket and key are filled", async () => {
    const user = userEvent.setup()
    render(<PlayView />)
    const submit = screen.getByRole("button", { name: "Connect" })
    expect(submit).toBeDisabled()
    await user.type(screen.getByLabelText(/server ticket/i), "endpoint-abc")
    expect(submit).toBeDisabled()
    await user.type(screen.getByLabelText(/access key/i), "k-1")
    expect(submit).toBeEnabled()
  })

  it("submits trimmed connect parameters", async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({ connect })
    const user = userEvent.setup()
    render(<PlayView />)
    await user.type(screen.getByLabelText(/server ticket/i), "  endpoint-abc  ")
    await user.type(screen.getByLabelText(/access key/i), " k-1 ")
    await user.click(screen.getByRole("button", { name: "Connect" }))
    expect(connect).toHaveBeenCalledWith({ ticket: "endpoint-abc", key: "k-1", name: undefined })
  })

  it("shows the session view with room banner and input while online", () => {
    useConnectionStore.setState({ status: "online", welcome: WELCOME })
    render(<PlayView />)
    expect(screen.getByText("r1 · Nyx")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument()
  })

  it("keeps the session visible while reconnecting, with the attempt count", () => {
    useConnectionStore.setState({ status: "reconnecting", attempt: 2, welcome: WELCOME })
    render(<PlayView />)
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
    expect(screen.getByText(/attempt 2/i)).toBeInTheDocument()
    expect(screen.getByRole("textbox")).toBeDisabled()
  })

  it("surfaces transport errors on the connect form", () => {
    useConnectionStore.setState({ lastError: "bad_key: unknown key" })
    render(<PlayView />)
    expect(screen.getByRole("alert")).toHaveTextContent("bad_key")
  })
})
