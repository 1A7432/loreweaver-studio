import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "../../i18n"
import { fatal, flush, welcome } from "../../lib/connection.testkit"
import type { LinkEvent } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"
import { useLastTableStore } from "../../store/lastTable"
import PlayView from "./PlayView"

// The form's own controls run against the real connection owner; only the
// Rust bridge is faked. `tauri` is on just while a test dials, so the
// host-locally block below still renders its outside-the-shell state.
const bridge = vi.hoisted(() => ({
  tauri: false,
  linkConnect: vi.fn(async (params: { generation: { connectionId: string } }) => void params),
  linkSend: vi.fn(async (connectionId: string, frame: unknown) => void [connectionId, frame]),
  linkDisconnect: vi.fn(async (connectionId: string) => void connectionId),
}))
vi.mock("../../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/transport")>()
  return {
    ...actual,
    isTauri: () => bridge.tauri,
    linkConnect: bridge.linkConnect,
    linkSend: bridge.linkSend,
    linkDisconnect: bridge.linkDisconnect,
  }
})

const { connect, disconnect, forgetLastTable } = useConnectionStore.getState()

function linkId(): string {
  const call = bridge.linkConnect.mock.calls.at(-1)
  if (call === undefined) throw new Error("nothing dialled")
  return call[0].generation.connectionId
}

/** Dial through the real slot, as the form would. */
async function dial(): Promise<void> {
  bridge.tauri = true
  await act(() => connect({ ticket: "endpointabc", key: "k-1" }))
  bridge.tauri = false
}

type Unstamped = LinkEvent extends infer E ? (E extends LinkEvent ? Omit<E, "connectionId"> : never) : never

async function emit(event: Unstamped): Promise<void> {
  await act(async () => {
    useConnectionStore.getState().handleEvent({ ...event, connectionId: linkId() } as LinkEvent)
    await flush()
  })
}

async function welcomed(): Promise<void> {
  await dial()
  await emit({ kind: "status", status: "up" })
  await emit({ kind: "frame", frame: welcome() })
}

function reset() {
  useConnectionStore.getState().connection?.stop()
  useConnectionStore.setState({ connection: null, connect, disconnect, forgetLastTable })
  useLastTableStore.getState().forget()
  bridge.tauri = false
  bridge.linkConnect.mockClear()
  bridge.linkDisconnect.mockClear()
}

describe("PlayView: the connect form", () => {
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

  it("submits trimmed connect parameters, asking for the table to be remembered", async () => {
    const connectSpy = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({ connect: connectSpy })
    const user = userEvent.setup()
    render(<PlayView />)
    await user.type(screen.getByLabelText(/server ticket/i), "  endpoint-abc  ")
    await user.type(screen.getByLabelText(/access key/i), " k-1 ")
    await user.click(screen.getByRole("button", { name: "Connect" }))
    expect(connectSpy).toHaveBeenCalledWith(
      { ticket: "endpoint-abc", key: "k-1", name: undefined },
      { remember: true },
    )
  })

  it("keeps the access key out of sight until asked, and hides it again", async () => {
    const user = userEvent.setup()
    render(<PlayView />)
    const key = screen.getByLabelText(/access key/i)
    expect(key).toHaveAttribute("type", "password")
    expect(key).toHaveAttribute("autocomplete", "off")
    await user.type(key, "k-secret")
    await user.click(screen.getByRole("button", { name: "Show" }))
    expect(key).toHaveAttribute("type", "text")
    await user.click(screen.getByRole("button", { name: "Hide" }))
    expect(key).toHaveAttribute("type", "password")
    expect(key).toHaveValue("k-secret")
  })

  it("offers the host-locally button on the connect screen (desktop-only outside the shell)", () => {
    render(<PlayView />)
    expect(screen.getByRole("button", { name: "Host locally & play" })).toBeDisabled()
    expect(screen.getByText(/needs the desktop app/)).toBeInTheDocument()
  })

  it("offers Cancel only while a dial is in flight, and Cancel drops the attempt", async () => {
    const user = userEvent.setup()
    render(<PlayView />)
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    await dial()
    expect(screen.getByText("Connecting…")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(bridge.linkDisconnect).toHaveBeenCalledWith(linkId())
    expect(screen.getByText("Offline")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps the form live while connecting: a new ticket can replace a stuck dial", async () => {
    await dial()
    const connectSpy = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({ connect: connectSpy })
    const user = userEvent.setup()
    render(<PlayView />)
    await user.type(screen.getByLabelText(/server ticket/i), "endpoint-current")
    await user.type(screen.getByLabelText(/access key/i), "k-2")
    await user.click(screen.getByRole("button", { name: "Connect" }))
    expect(connectSpy).toHaveBeenCalledWith(
      { ticket: "endpoint-current", key: "k-2", name: undefined },
      { remember: true },
    )
  })

  describe("the last table joined by hand", () => {
    const SAVED = { ticket: "endpointabc12345678", key: "k-saved", name: "Nyx" }

    it("prefills the form from the saved table without dialling, and never shows its key", () => {
      useLastTableStore.getState().remember(SAVED)
      const { container } = render(<PlayView />)
      expect(screen.getByLabelText(/server ticket/i)).toHaveValue("endpointabc12345678")
      expect(screen.getByText(/Last table: Nyx · …12345678/)).toBeInTheDocument()
      expect(container.textContent).not.toContain("k-saved")
      expect(bridge.linkConnect).not.toHaveBeenCalled()
    })

    it("reconnects to the saved table in one press, whatever the form says now", async () => {
      const connectSpy = vi.fn().mockResolvedValue(undefined)
      useConnectionStore.setState({ connect: connectSpy })
      useLastTableStore.getState().remember(SAVED)
      const user = userEvent.setup()
      render(<PlayView />)
      await user.clear(screen.getByLabelText(/access key/i))
      await user.type(screen.getByLabelText(/access key/i), "half-edited")
      await user.click(screen.getByRole("button", { name: "Reconnect to last table" }))
      expect(connectSpy).toHaveBeenCalledWith(SAVED, { remember: true })
    })

    it("forgets through the connection slot, so a dial in flight cannot save the table back", async () => {
      const forget = vi.fn()
      useConnectionStore.setState({ forgetLastTable: forget })
      useLastTableStore.getState().remember(SAVED)
      const user = userEvent.setup()
      render(<PlayView />)
      await user.click(screen.getByRole("button", { name: "Forget" }))
      expect(forget).toHaveBeenCalledOnce()
      expect(screen.getByLabelText(/server ticket/i)).toHaveValue("")
    })
  })
})

describe("PlayView: connected", () => {
  beforeEach(reset)

  it("shows the room once welcomed: who, as what role, on which server — and says the screen is moving", async () => {
    render(<PlayView />)
    await welcomed()
    expect(screen.getByRole("heading", { name: "Room main" })).toBeInTheDocument()
    expect(screen.getByText("Ada · Room admin")).toBeInTheDocument()
    expect(screen.getByText("loreweaver 3.0.0-alpha.0 · protocol 3.0")).toBeInTheDocument()
    expect(screen.getByText(/being moved to protocol 3\.0/)).toBeInTheDocument()
    expect(screen.getByText("Online")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument()
  })

  it("keeps the room visible while reconnecting, with the attempt count", async () => {
    render(<PlayView />)
    await welcomed()
    await emit({ kind: "status", status: "closed", code: "connection_lost" })
    expect(screen.getByRole("heading", { name: "Room main" })).toBeInTheDocument()
    expect(screen.getByText(/Reconnecting… \(attempt 1\)/)).toBeInTheDocument()
  })

  it("Disconnect leaves the room for the form, with nothing to apologise for", async () => {
    const user = userEvent.setup()
    render(<PlayView />)
    await welcomed()
    await user.click(screen.getByRole("button", { name: "Disconnect" }))
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("PlayView: why a connection ended", () => {
  beforeEach(reset)
  afterEach(() => void i18n.changeLanguage("en"))

  async function refusedWith(code: string, message: string): Promise<void> {
    await dial()
    await emit({ kind: "status", status: "up" })
    await emit({ kind: "frame", frame: fatal(code, message) })
  }

  it.each([
    ["bad_key", /does not know this access key/],
    ["protocol_mismatch", /another version of the protocol/],
    ["bad_name", /at most 64 characters/],
    ["hello_first", /spoke before saying hello/],
    ["bad_frame", /could not read what Studio sent/],
    ["something_new", /refused the connection \(something_new\)/],
  ])(
    "words the refusal %s in its own sentence, with the server's words beside it",
    async (code, sentence) => {
      render(<PlayView />)
      await refusedWith(code, "the server's own words")
      const alert = screen.getByRole("alert")
      expect(alert).toHaveTextContent(sentence)
      expect(alert).toHaveTextContent("the server's own words")
      expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument()
    },
  )

  it("words a refusal in Chinese too", async () => {
    await act(() => i18n.changeLanguage("zh"))
    render(<PlayView />)
    await refusedWith("bad_key", "服务器不认识这把钥匙。")
    expect(screen.getByRole("alert")).toHaveTextContent("请向房间管理员要一把新的")
  })

  it("shows a first dial's timeout inline, with the form usable again", async () => {
    const user = userEvent.setup()
    render(<PlayView />)
    await dial()
    await emit({ kind: "status", status: "closed", code: "dial_timeout" })
    expect(screen.getByRole("alert")).toHaveTextContent(/ticket changed/i)
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/server ticket/i), "endpoint-fresh")
    await user.type(screen.getByLabelText(/access key/i), "k-1")
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled()
  })

  it("says a dial needs the desktop app when there is no shell", async () => {
    render(<PlayView />)
    await act(() => connect({ ticket: "endpointabc", key: "k-1" }))
    await act(() => flush())
    expect(screen.getByRole("alert")).toHaveTextContent("Connecting needs the desktop app.")
  })
})
