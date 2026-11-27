// The 2.x play screens, kept (unrendered by PlayView) until they move to
// protocol 3.0. These tests were PlayView's while the screens were live; they
// drive the screens straight through the unfed 2.x store so the kept code stays
// covered until it is migrated.
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import type { UiManifestPanel, WelcomeFrame } from "@loreweaver/protocol"
import { useAudioStore } from "../../store/audio"
import { useLegacyConnectionStore } from "../../store/legacyConnection"
import { usePanelsStore } from "../../store/panels"
import { useSessionStore } from "../../store/session"
import OnlineView from "./OnlineView"

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

describe("OnlineView (2.x screens, unfed)", () => {
  beforeEach(() => {
    useLegacyConnectionStore.setState({ status: "online", attempt: 0, lastError: null, welcome: WELCOME })
    useSessionStore.getState().clear()
  })

  it("lands on the main menu; Enter game opens the chronicle; Esc goes back", async () => {
    const user = userEvent.setup()
    render(<OnlineView />)
    expect(screen.getByText(/Table “r1”/)).toBeInTheDocument()
    await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
    expect(screen.getByText("r1 · Nyx")).toBeInTheDocument()
    expect(screen.getByLabelText("Speak, act, or type a command…")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.getByText(/Table “r1”/)).toBeInTheDocument()
  })

  it("tells a player whose sound was refused where they can see it, not only in the sidebar card", async () => {
    const user = userEvent.setup()
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
      render(<OnlineView />)
      await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
      const notice = screen.getByText(/A sound cue is waiting/).closest(".panel-notice") as HTMLElement
      expect(notice.closest(".desk-pane")).toBeNull()
      await user.click(within(notice).getByRole("button", { name: "Turn sound on" }))
      expect(screen.queryByText(/A sound cue is waiting/)).toBeNull()
    } finally {
      useAudioStore.getState().reset()
    }
  })

  it("shows admin rows and the demo item only for an admin whose server offers it", () => {
    useLegacyConnectionStore.setState({ welcome: { ...WELCOME, features: ["demo"] } })
    render(<OnlineView />)
    expect(screen.getByText("── Admin ──")).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Play sample adventure/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Rooms & invites/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Model \/ config/ })).toBeInTheDocument()
  })

  it("hides the admin section from players", () => {
    useLegacyConnectionStore.setState({ welcome: { ...WELCOME, you: { ...WELCOME.you, role: "player" } } })
    render(<OnlineView />)
    expect(screen.queryByText("── Admin ──")).not.toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /Rooms & invites/ })).not.toBeInTheDocument()
  })

  it("closes a panel modal on Escape without leaving the game", async () => {
    const user = userEvent.setup()
    usePanelsStore.getState().applyManifest([MODAL])
    usePanelsStore.getState().openModal(MODAL.id)
    render(<OnlineView />)
    await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
    expect(screen.getByRole("dialog", { name: "Manor Map" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByText("r1 · Nyx")).toBeInTheDocument()
    expect(screen.queryByText(/Table “r1”/)).not.toBeInTheDocument()
  })

  it("cancels a sheet edit on Escape without returning to the menu", async () => {
    const user = userEvent.setup()
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
    render(<OnlineView />)
    await user.click(screen.getByRole("menuitem", { name: /My character/ }))
    await user.click(screen.getByRole("button", { name: "55" }))
    expect(screen.getByLabelText("力量")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByLabelText("力量")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "55" })).toBeInTheDocument()
    expect(screen.queryByText(/Table “r1”/)).not.toBeInTheDocument()
  })
})
