import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UiManifestPanel, WelcomeFrame } from "@loreweaver/protocol"
import i18n from "../../i18n"
import { useAudioStore } from "../../store/audio"
import { useConnectionStore } from "../../store/connection"
import { useLastTableStore } from "../../store/lastTable"
import { usePanelsStore } from "../../store/panels"
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

const MODAL: UiManifestPanel = {
  id: "harbour/map",
  title: { en: "Manor Map" },
  slot: "modal",
  tier: 1,
  blocks: [{ kind: "text", text: { en: "the tide line" } }],
}

const { forgetLastTable } = useConnectionStore.getState()

function reset() {
  useConnectionStore.setState({
    status: "offline",
    attempt: 0,
    lastError: null,
    welcome: null,
    forgetLastTable,
  })
  useSessionStore.getState().clear()
  useLastTableStore.getState().forget()
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

  it("submits trimmed connect parameters, asking for the table to be remembered", async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({ connect })
    const user = userEvent.setup()
    render(<PlayView />)
    await user.type(screen.getByLabelText(/server ticket/i), "  endpoint-abc  ")
    await user.type(screen.getByLabelText(/access key/i), " k-1 ")
    await user.click(screen.getByRole("button", { name: "Connect" }))
    expect(connect).toHaveBeenCalledWith(
      { ticket: "endpoint-abc", key: "k-1", name: undefined },
      { remember: true },
    )
  })

  describe("the last table joined by hand", () => {
    const SAVED = { ticket: "endpointabc12345678", key: "k-saved", name: "Nyx" }

    it("offers nothing when no table is saved", () => {
      render(<PlayView />)
      expect(screen.queryByRole("button", { name: /reconnect to last table/i })).not.toBeInTheDocument()
      expect(screen.getByLabelText(/server ticket/i)).toHaveValue("")
    })

    it("prefills the form from the saved table, and does not dial by itself", () => {
      const connect = vi.fn().mockResolvedValue(undefined)
      useConnectionStore.setState({ connect })
      useLastTableStore.getState().remember(SAVED)
      render(<PlayView />)
      expect(screen.getByLabelText(/server ticket/i)).toHaveValue("endpointabc12345678")
      expect(screen.getByLabelText(/access key/i)).toHaveValue("k-saved")
      expect(screen.getByLabelText(/display name/i)).toHaveValue("Nyx")
      expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled()
      expect(connect).not.toHaveBeenCalled()
    })

    it("names the saved table without showing its key", () => {
      useLastTableStore.getState().remember(SAVED)
      const { container } = render(<PlayView />)
      expect(screen.getByText(/Last table: Nyx · …12345678/)).toBeInTheDocument()
      expect(container.textContent).not.toContain("k-saved")
    })

    it("reconnects to the saved table in one press, whatever the form says now", async () => {
      const connect = vi.fn().mockResolvedValue(undefined)
      useConnectionStore.setState({ connect })
      useLastTableStore.getState().remember(SAVED)
      const user = userEvent.setup()
      render(<PlayView />)
      await user.clear(screen.getByLabelText(/access key/i))
      await user.type(screen.getByLabelText(/access key/i), "half-edited")
      await user.click(screen.getByRole("button", { name: "Reconnect to last table" }))
      expect(connect).toHaveBeenCalledWith(
        { ticket: "endpointabc12345678", key: "k-saved", name: "Nyx" },
        { remember: true },
      )
    })

    it("forgets the table on request: store, storage and the prefilled form", async () => {
      useLastTableStore.getState().remember(SAVED)
      const user = userEvent.setup()
      render(<PlayView />)
      await user.click(screen.getByRole("button", { name: "Forget" }))
      expect(useLastTableStore.getState()).toMatchObject({ ticket: "", key: "", name: "" })
      expect(JSON.parse(localStorage.getItem("loreweaver-studio-last-table")!).state.key).toBe("")
      expect(screen.getByLabelText(/server ticket/i)).toHaveValue("")
      expect(screen.getByLabelText(/access key/i)).toHaveValue("")
      expect(screen.queryByRole("button", { name: /reconnect to last table/i })).not.toBeInTheDocument()
    })

    it("forgets through the connection store, so a dial in flight cannot save the table back", async () => {
      const forget = vi.fn()
      useConnectionStore.setState({ status: "connecting", forgetLastTable: forget })
      useLastTableStore.getState().remember(SAVED)
      const user = userEvent.setup()
      render(<PlayView />)
      await user.click(screen.getByRole("button", { name: "Forget" }))
      expect(forget).toHaveBeenCalledOnce()
      expect(screen.getByLabelText(/server ticket/i)).toHaveValue("")
    })

    it("does not forget just because the player disconnected", () => {
      useLastTableStore.getState().remember(SAVED)
      useConnectionStore.setState({ status: "online", welcome: WELCOME })
      const { unmount } = render(<PlayView />)
      unmount()
      useConnectionStore.setState({ status: "offline", welcome: null })
      render(<PlayView />)
      expect(screen.getByLabelText(/access key/i)).toHaveValue("k-saved")
    })
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
    expect(key).toHaveValue("k-secret")

    await user.click(screen.getByRole("button", { name: "Hide" }))
    expect(key).toHaveAttribute("type", "password")
    expect(key).toHaveValue("k-secret")
  })

  it("does not submit the form when the show/hide toggle is pressed", async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({ connect })
    const user = userEvent.setup()
    render(<PlayView />)
    await user.type(screen.getByLabelText(/server ticket/i), "endpoint-abc")
    await user.type(screen.getByLabelText(/access key/i), "k-1")
    await user.click(screen.getByRole("button", { name: "Show" }))
    expect(connect).not.toHaveBeenCalled()
  })

  it("only treats the access key as secret: the ticket and the name stay readable", () => {
    render(<PlayView />)
    expect(screen.getByLabelText(/server ticket/i)).not.toHaveAttribute("type", "password")
    expect(screen.getByLabelText(/display name/i)).not.toHaveAttribute("type", "password")
  })

  it("offers Cancel only while a dial is in flight, and Cancel drops the attempt", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({ status: "offline", disconnect })
    const user = userEvent.setup()
    const { rerender } = render(<PlayView />)
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()

    useConnectionStore.setState({ status: "connecting" })
    rerender(<PlayView />)
    await user.click(await screen.findByRole("button", { name: "Cancel" }))
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  it("keeps the form live while connecting: a new ticket can replace a stuck dial", async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({ status: "connecting", connect })
    const user = userEvent.setup()
    render(<PlayView />)

    const ticket = screen.getByLabelText(/server ticket/i)
    expect(ticket).toBeEnabled()
    expect(screen.getByLabelText(/access key/i)).toBeEnabled()
    await user.type(ticket, "endpoint-current")
    await user.type(screen.getByLabelText(/access key/i), "k-1")
    await user.click(screen.getByRole("button", { name: "Connect" }))
    expect(connect).toHaveBeenCalledWith(
      { ticket: "endpoint-current", key: "k-1", name: undefined },
      { remember: true },
    )
  })

  it("keeps the remembered table usable while a dial is in flight: reconnect replaces it, Cancel sits beside it", async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    const disconnect = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({ status: "connecting", connect, disconnect })
    useLastTableStore.getState().remember({ ticket: "endpointabc12345678", key: "k-saved", name: "Nyx" })
    const user = userEvent.setup()
    render(<PlayView />)

    expect(screen.getByText(/Last table: Nyx · …12345678/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Forget" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()
    const reconnect = screen.getByRole("button", { name: "Reconnect to last table" })
    expect(reconnect).toBeEnabled()
    await user.click(reconnect)
    expect(connect).toHaveBeenCalledWith(
      { ticket: "endpointabc12345678", key: "k-saved", name: "Nyx" },
      { remember: true },
    )
  })

  it("shows a timeout inline with the form editable and Connect usable again", async () => {
    const connect = vi.fn().mockResolvedValue(undefined)
    useConnectionStore.setState({
      status: "offline",
      lastError: i18n.t("connect.error.connectTimeout"),
      connect,
    })
    const user = userEvent.setup()
    render(<PlayView />)

    expect(screen.getByRole("alert")).toHaveTextContent(/ticket changed/i)
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText(/server ticket/i), "endpoint-fresh")
    await user.type(screen.getByLabelText(/access key/i), "k-1")
    const submit = screen.getByRole("button", { name: "Connect" })
    expect(submit).toBeEnabled()
    await user.click(submit)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it("lands on the main menu while online; Enter game opens the chronicle", async () => {
    const user = userEvent.setup()
    useConnectionStore.setState({ status: "online", welcome: WELCOME })
    render(<PlayView />)
    // The TUI flow: welcome → main menu, the game is one item among the rows.
    expect(screen.getByText(/Table “r1”/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
    expect(screen.getByText("r1 · Nyx")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument()
    // Named, not "the one textbox": the keeper's audio deck has fields too.
    expect(screen.getByLabelText("Speak, act, or type a command…")).toBeInTheDocument()
    // Esc backs out to the menu.
    await user.keyboard("{Escape}")
    expect(screen.getByText(/Table “r1”/)).toBeInTheDocument()
  })

  it("tells a player whose sound was refused where they can see it, not only in the sidebar card", async () => {
    const user = userEvent.setup()
    useConnectionStore.setState({ status: "online", welcome: WELCOME })
    useAudioStore.getState().reset()
    useAudioStore.getState().ingest({
      type: "audio_control",
      id: "c1",
      action: "play",
      layer: "bgm",
      hash: "a".repeat(64),
      title: "Tide",
    })
    useAudioStore.getState().markBlocked("bgm")
    try {
      render(<PlayView />)
      await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
      const notice = screen.getByText(/A sound cue is waiting/).closest(".panel-notice") as HTMLElement
      expect(notice.closest(".desk-pane")).toBeNull()
      await user.click(within(notice).getByRole("button", { name: "Turn sound on" }))
      expect(screen.queryByText(/A sound cue is waiting/)).toBeNull()
    } finally {
      useAudioStore.getState().reset()
    }
  })

  it("keeps the menu visible while reconnecting, with the attempt count", () => {
    useConnectionStore.setState({ status: "reconnecting", attempt: 2, welcome: WELCOME })
    render(<PlayView />)
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
    expect(screen.getByText(/attempt 2/i)).toBeInTheDocument()
  })

  it("shows keeper rows and the demo item only for a keeper whose server offers it", () => {
    useConnectionStore.setState({ status: "online", welcome: { ...WELCOME, features: ["demo"] } })
    render(<PlayView />)
    expect(screen.getByText("── Keeper ──")).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Play sample adventure/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Rooms & invites/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Model \/ config/ })).toBeInTheDocument()
  })

  it("hides the keeper section from players", () => {
    useConnectionStore.setState({
      status: "online",
      welcome: { ...WELCOME, you: { ...WELCOME.you, role: "player" } },
    })
    render(<PlayView />)
    expect(screen.queryByText("── Keeper ──")).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /Rooms & invites/ })).not.toBeInTheDocument()
  })

  it("offers the host-locally button on the connect screen (desktop-only outside the shell)", () => {
    render(<PlayView />)
    const button = screen.getByRole("button", { name: "Host locally & play" })
    // jsdom is not the Tauri shell, so the button is present but disabled.
    expect(button).toBeDisabled()
    expect(screen.getByText(/needs the desktop app/)).toBeInTheDocument()
  })

  it("surfaces transport errors on the connect form", () => {
    useConnectionStore.setState({ lastError: "bad_key: unknown key" })
    render(<PlayView />)
    expect(screen.getByRole("alert")).toHaveTextContent("bad_key")
  })

  it("closes a panel modal on Escape without leaving the game", async () => {
    const user = userEvent.setup()
    useConnectionStore.setState({ status: "online", welcome: WELCOME })
    usePanelsStore.getState().applyManifest([MODAL])
    usePanelsStore.getState().openModal(MODAL.id)
    render(<PlayView />)
    await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
    expect(screen.getByRole("dialog", { name: "Manor Map" })).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByText("r1 · Nyx")).toBeInTheDocument()
    expect(screen.queryByText(/Table “r1”/)).not.toBeInTheDocument()
  })

  it("cancels a sheet edit on Escape without returning to the menu", async () => {
    const user = userEvent.setup()
    useConnectionStore.setState({ status: "online", welcome: WELCOME })
    useSessionStore.getState().ingest({
      type: "state",
      party: [],
      initiative: [],
      online: 1,
      character: {
        name: "Lin Quill",
        system: "coc7",
        resources: [],
        attributes: { 力量: 55 },
        status_effects: [],
      },
    })
    render(<PlayView />)
    await user.click(screen.getByRole("menuitem", { name: /My character/ }))
    await user.click(screen.getByRole("button", { name: "55" }))
    expect(screen.getByLabelText("力量")).toBeInTheDocument()

    await user.keyboard("{Escape}")
    expect(screen.queryByLabelText("力量")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "55" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Delete character" })).toBeInTheDocument()
    expect(screen.queryByText(/Table “r1”/)).not.toBeInTheDocument()
  })
})
