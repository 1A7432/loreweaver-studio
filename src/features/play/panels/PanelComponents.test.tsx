import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StateFrame, UiManifestPanel, WelcomeFrame } from "@loreweaver/protocol"
import "../../../i18n"
import { useConnectionStore } from "../../../store/connection"
import { usePanelsStore } from "../../../store/panels"
import { useSessionStore } from "../../../store/session"
import { PanelSidebar, PanelTray } from "./PanelDeck"
import PanelMenu from "./PanelMenu"
import PanelModalHost from "./PanelModalHost"
import PanelNotice from "./PanelNotice"
import Tier2Frame from "./Tier2Frame"

vi.mock("../../../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/transport")>()
  return { ...actual, transportSend: vi.fn().mockResolvedValue(undefined) }
})
vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>()
  return {
    ...actual,
    ensurePanelAssets: vi.fn().mockResolvedValue(undefined),
    panelServeRegister: vi.fn().mockResolvedValue(undefined),
    panelServeUnregister: vi.fn().mockResolvedValue(undefined),
    panelEntryUrl: vi.fn((token: string) => `panel://localhost/${token}/__entry__.html`),
  }
})

import { transportSend } from "../../../lib/transport"
import { ensurePanelAssets, panelServeRegister } from "./assets"

const CASE_BOARD: UiManifestPanel = {
  id: "blackmoor/case-board",
  title: { en: "Case Board", zh: "案情板" },
  slot: "sidebar",
  tier: 1,
  blocks: [
    { kind: "meter", label: { en: "Fear" }, value: { $var: "town_fear" }, min: 0, max: 10 },
    {
      kind: "choices",
      options: [{ id: "act", label: { en: "Investigate" }, input: "查案" }],
    },
  ],
}

const TICKER: UiManifestPanel = {
  id: "blackmoor/ticker",
  title: { en: "Ticker" },
  slot: "tray",
  tier: 1,
  blocks: [{ kind: "text", text: { en: "tray text" } }],
}

const MANOR_MAP: UiManifestPanel = {
  id: "blackmoor/manor-map",
  title: { en: "Manor Map", zh: "庄园地图" },
  slot: "modal",
  tier: 2,
  entry: { hash: "c".repeat(64), size: 1024 * 1024 },
  assets: [{ path: "app.js", hash: "a".repeat(64), size: 1024 * 1024, mime: "text/javascript" }],
  fallback: [{ kind: "text", text: { en: "Map available in the rich client." } }],
}

const GAME = {
  type: "state",
  party: [],
  initiative: [],
  online: 1,
  variables: [{ id: "town_fear", label: "恐慌", kind: "number", value: 6, min: 0, max: 10 }],
} as unknown as StateFrame

const WELCOME = {
  type: "welcome",
  protocol: "1.8",
  room: "r1",
  you: { id: "u1", name: "Nyx", role: "player" },
  locale: "en",
  server: "loreweaver/1",
} as WelcomeFrame

beforeEach(() => {
  vi.mocked(transportSend).mockClear()
  vi.mocked(ensurePanelAssets).mockClear().mockResolvedValue(undefined)
  vi.mocked(panelServeRegister).mockClear().mockResolvedValue(undefined)
  globalThis.localStorage.clear()
  useSessionStore.getState().clear()
  useSessionStore.setState({ game: GAME })
  useConnectionStore.setState({ status: "online", welcome: WELCOME })
  usePanelsStore.setState({ blocksOnly: false, noticeRooms: [] })
  usePanelsStore.getState().applyManifest([CASE_BOARD, TICKER, MANOR_MAP])
})

describe("PanelSidebar", () => {
  it("renders manifest sidebar panels with resolved bindings", () => {
    render(<PanelSidebar />)
    expect(screen.getByText("Case Board")).toBeInTheDocument()
    expect(screen.getByText("Fear")).toBeInTheDocument()
    expect(screen.getByText("6/10")).toBeInTheDocument()
    // Tray/modal panels stay out of the sidebar.
    expect(screen.queryByText("tray text")).not.toBeInTheDocument()
  })

  it("collapses and closes on the player's command", async () => {
    const user = userEvent.setup()
    render(<PanelSidebar />)
    await user.click(screen.getByRole("button", { name: "Collapse panel" }))
    expect(screen.queryByText("Fear")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Expand panel" }))
    expect(screen.getByText("Fear")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByText("Case Board")).not.toBeInTheDocument()
    expect(usePanelsStore.getState().closed[CASE_BOARD.id]).toBe(true)
  })

  it("sends tier-1 choices as panel_intent kind=choice", async () => {
    const user = userEvent.setup()
    render(<PanelSidebar />)
    await user.click(screen.getByRole("button", { name: "Investigate" }))
    expect(transportSend).toHaveBeenCalledWith({
      type: "panel_intent",
      panel: CASE_BOARD.id,
      kind: "choice",
      value: "查案",
    })
  })
})

describe("PanelTray", () => {
  it("renders only tray panels in the strip", () => {
    const { container } = render(<PanelTray />)
    expect(container.querySelector(".panel-tray")).not.toBeNull()
    expect(screen.getByText("tray text")).toBeInTheDocument()
    expect(screen.queryByText("Case Board")).not.toBeInTheDocument()
  })
})

describe("PanelMenu + PanelModalHost", () => {
  it("opens a modal panel from the menu and closes it with Escape", async () => {
    const user = userEvent.setup()
    render(
      <>
        <PanelMenu />
        <PanelModalHost />
      </>,
    )
    await user.click(screen.getByRole("button", { name: "Panels (3)" }))
    await user.click(screen.getByRole("button", { name: "Open" }))
    const dialog = await screen.findByRole("dialog", { name: "Manor Map" })
    expect(dialog).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("reopens a closed panel from the menu", async () => {
    const user = userEvent.setup()
    usePanelsStore.getState().setClosed(CASE_BOARD.id, true)
    render(<PanelMenu />)
    await user.click(screen.getByRole("button", { name: "Panels (3)" }))
    await user.click(screen.getByRole("button", { name: "Reopen" }))
    expect(usePanelsStore.getState().closed[CASE_BOARD.id]).toBe(false)
  })

  it("toggles blocks-only mode from the menu", async () => {
    const user = userEvent.setup()
    render(<PanelMenu />)
    await user.click(screen.getByRole("button", { name: "Panels (3)" }))
    await user.click(screen.getByRole("checkbox"))
    expect(usePanelsStore.getState().blocksOnly).toBe(true)
    expect(globalThis.localStorage.getItem("lw-panels-blocks-only")).toBe("1")
  })
})

describe("Tier2Frame", () => {
  it("mounts a strictly sandboxed iframe from the registered namespace", async () => {
    const { container } = render(<Tier2Frame panel={MANOR_MAP} />)
    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe")
      if (!el) throw new Error("iframe not mounted yet")
      return el
    })
    // The isolation contract: allow-scripts alone — never allow-same-origin.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(iframe.getAttribute("src")).toMatch(/^panel:\/\/localhost\/[0-9a-f]{32}\/__entry__\.html$/)
    expect(iframe.getAttribute("title")).toBe("Manor Map")

    expect(ensurePanelAssets).toHaveBeenCalledWith(MANOR_MAP)
    const registration = vi.mocked(panelServeRegister).mock.calls[0][0]
    expect(registration.token).toMatch(/^[0-9a-f]{32}$/)
    expect(registration.entryHash).toBe(MANOR_MAP.entry?.hash)
    expect(registration.assets).toEqual([{ path: "app.js", hash: "a".repeat(64), mime: "text/javascript" }])
    expect(registration.bootstrapJs).toContain("window.loreweaver")
    expect(registration.themeCss).toContain(":root {")
  })

  it("shows the fallback the moment the panel reports a crash, with its own line", async () => {
    const { container } = render(<Tier2Frame panel={MANOR_MAP} />)
    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe")
      if (!el) throw new Error("iframe not mounted yet")
      return el
    })
    // The mount's nonce is only ever handed to the panel — read it back out of
    // the bootstrap the host registered, exactly as the iframe would.
    const registration = vi.mocked(panelServeRegister).mock.calls.at(-1)![0]
    const nonce = /var NONCE = "([0-9a-f]{32})"/.exec(registration.bootstrapJs)![1]

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { lw: "1", nonce, type: "panel_error", message: "TypeError: x is not a function" },
          source: iframe.contentWindow,
        }),
      )
    })

    // No waiting out the 6s handshake deadline: stalled, now.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The panel reported: TypeError: x is not a function",
    )
    expect(screen.getByText("Map available in the rich client.")).toBeInTheDocument()
  })

  it("ignores a crash forged with the wrong nonce", async () => {
    const { container } = render(<Tier2Frame panel={MANOR_MAP} />)
    await waitFor(() => {
      const el = container.querySelector("iframe")
      if (!el) throw new Error("iframe not mounted yet")
      return el
    })
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { lw: "1", nonce: "0".repeat(32), type: "panel_error", message: "boom" },
          source: container.querySelector("iframe")!.contentWindow,
        }),
      )
    })
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("falls back with a retry line when assets fail", async () => {
    const user = userEvent.setup()
    vi.mocked(ensurePanelAssets).mockRejectedValueOnce(new Error("offline"))
    const { container } = render(<Tier2Frame panel={MANOR_MAP} />)
    expect(await screen.findByText("Panel assets failed to load.")).toBeInTheDocument()
    expect(screen.getByText("Map available in the rich client.")).toBeInTheDocument()
    expect(container.querySelector("iframe")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => {
      if (!container.querySelector("iframe")) throw new Error("iframe not mounted after retry")
    })
  })
})

describe("blocks-only degradation", () => {
  it("renders the tier-2 fallback instead of any iframe", () => {
    usePanelsStore.getState().setBlocksOnly(true)
    usePanelsStore.getState().openModal(MANOR_MAP.id)
    const { container } = render(<PanelModalHost />)
    expect(container.querySelector("iframe")).toBeNull()
    expect(screen.getByText("Map available in the rich client.")).toBeInTheDocument()
  })

  it("renders the localized rich-client line for fallback: null", () => {
    const noFallback: UiManifestPanel = { ...MANOR_MAP, fallback: null }
    usePanelsStore.getState().applyManifest([noFallback])
    usePanelsStore.getState().setBlocksOnly(true)
    usePanelsStore.getState().openModal(noFallback.id)
    render(<PanelModalHost />)
    expect(screen.getByText("This panel is available in the rich client.")).toBeInTheDocument()
  })
})

describe("PanelNotice", () => {
  it("shows the one-line consent notice once per room", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<PanelNotice />)
    expect(screen.getByRole("status").textContent).toContain(
      "This room draws its own interface — 3 panels, 2.0 MB.",
    )
    await user.click(screen.getByRole("button", { name: "Got it" }))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    rerender(<PanelNotice />)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(usePanelsStore.getState().noticeRooms).toContain("r1")
  })

  it("stays silent for rooms without panels", () => {
    usePanelsStore.getState().applyManifest([])
    render(<PanelNotice />)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
})
