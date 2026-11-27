// Panels from the `panels` view (protocol 3.0 §10.6), evaluated by the protocol package's
// shared `panelBlocks` against the views they read. The tide panel is the document's own
// example; the others follow the same entry shape.
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PanelEntry } from "loreweaver-protocol/v3"
import "../../../i18n"
import { usePanelsStore } from "../../../store/panels"
import { usePanelViews } from "../room"
import { TestRoom, fixtureView } from "../room.testkit"
import { PanelSidebar, PanelTray } from "./PanelDeck"
import { usePanelList } from "./panelList"
import PanelMenu from "./PanelMenu"
import PanelModalHost from "./PanelModalHost"
import PanelNotice from "./PanelNotice"

// protocol.md §10.6.
const TIDE: PanelEntry = {
  id: "harbor/tide",
  title: "The tide",
  slot: "sidebar",
  kind: "template",
  views: [{ as: "tide", view: "harbor/tide" }],
  source: { kind: "pack", id: "harbor" },
  blocks: [
    { kind: "meter", label: "Tide", value: { $view: "tide.level" }, min: 0, max: 10 },
    { kind: "text", text: "Flood warning!", style: "warning", visible_when: "tide.level >= 8" },
    {
      kind: "choices",
      options: [{ id: "bail", label: "Bail water", command: "harbor/bail", args: { hands: 2 } }],
    },
  ],
}

const ROLL_CALL: PanelEntry = {
  id: "harbor/roll-call",
  title: "Roll call",
  slot: "tray",
  kind: "template",
  views: [{ as: "party", view: "party" }],
  source: { kind: "pack", id: "harbor" },
  blocks: [
    {
      repeat: {
        each: "party.characters",
        as: "pc",
        block: { kind: "stat", label: { $view: "pc.name" }, value: { $view: "pc.pack" } },
      },
    },
  ],
}

const MAP: PanelEntry = {
  id: "harbor/map",
  title: "Harbor map",
  slot: "modal",
  kind: "page",
  views: [{ as: "scene", view: "scene" }],
  source: { kind: "pack", id: "harbor" },
  page: { hash: "c".repeat(64), size: 1024 * 1024, mime: "text/html" },
  fallback: [{ kind: "text", text: { $view: "scene.name" } }],
}

const PANELS = [TIDE, ROLL_CALL, MAP]

/** What the game screen does: keep the panels' views subscribed while it is open. */
function Subscriber() {
  usePanelViews(usePanelList())
  return null
}

let room: TestRoom | null = null
beforeEach(() => {
  globalThis.localStorage.clear()
  usePanelsStore.setState({ collapsed: {}, closed: {}, modalOpen: null, noticeRooms: [] })
})
afterEach(() => {
  room?.close()
  room = null
})

async function open(panels: PanelEntry[] = PANELS) {
  room = await TestRoom.open("player")
  await room.view("panels", { panels })
  return room
}

describe("the panels' views", () => {
  it("subscribes the views the listed panels read, and lets them go when no panel reads them", async () => {
    const r = await open()
    const { unmount } = render(<Subscriber />)
    await act(async () => undefined)
    const subscribed = r
      .requests()
      .filter((frame) => frame.type === "call" && frame.method === "view.subscribe")
      .map((frame) => (frame.type === "call" ? frame.params.names : null))
    // `party` and `scene` are wanted for the whole connection already: only the module view is new.
    expect(subscribed.at(-1)).toEqual(["harbor/tide"])

    await r.view("panels", { panels: [ROLL_CALL] })
    expect(r.requests().at(-1)).toMatchObject({
      method: "view.unsubscribe",
      params: { names: ["harbor/tide"] },
    })
    unmount()
  })
})

describe("PanelSidebar", () => {
  it("evaluates a template against its view, and re-evaluates when the view changes", async () => {
    const r = await open()
    render(
      <>
        <Subscriber />
        <PanelSidebar />
      </>,
    )
    await r.view("harbor/tide", { level: 5 })
    expect(screen.getByText("5/10")).toBeInTheDocument()
    expect(screen.queryByText("Flood warning!")).toBeNull()

    await r.view("harbor/tide", { level: 9 })
    expect(screen.getByText("9/10")).toBeInTheDocument()
    expect(screen.getByText("Flood warning!")).toBeInTheDocument()
  })

  it("drops a block whose binding does not resolve yet, and keeps the rest", async () => {
    await open()
    render(<PanelSidebar />)
    expect(screen.getByText("The tide")).toBeInTheDocument()
    expect(screen.queryByText("Tide")).toBeNull()
    expect(screen.getByRole("button", { name: "Bail water" })).toBeInTheDocument()
  })

  it("runs a panel's choice as a command, as the member viewing it", async () => {
    const r = await open()
    const user = userEvent.setup()
    render(<PanelSidebar />)
    await user.click(screen.getByRole("button", { name: "Bail water" }))
    expect(r.commands()).toEqual([{ id: "harbor/bail", args: { hands: 2 } }])
  })

  it("collapses and closes on the player's command", async () => {
    await open()
    const user = userEvent.setup()
    render(<PanelSidebar />)
    await user.click(screen.getByRole("button", { name: "Collapse panel" }))
    expect(screen.queryByRole("button", { name: "Bail water" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(screen.queryByText("The tide")).toBeNull()
  })
})

describe("PanelTray", () => {
  it("renders only tray panels, repeating a block over a list", async () => {
    await open()
    const { container } = render(<PanelTray />)
    expect(screen.queryByText("The tide")).toBeNull()
    const tray = container.querySelector(".panel-tray") as HTMLElement
    const party = fixtureView("player", "party") as { characters: { name: string }[] }
    for (const character of party.characters)
      expect(within(tray).getByText(character.name)).toBeInTheDocument()
  })
})

describe("PanelMenu + PanelModalHost", () => {
  async function openFromMenu(user: ReturnType<typeof userEvent.setup>) {
    render(
      <>
        <PanelMenu />
        <PanelModalHost />
      </>,
    )
    await user.click(screen.getByRole("button", { name: "Panels (3)" }))
    await user.click(screen.getByRole("button", { name: "Open" }))
    return screen.findByRole("dialog", { name: "Harbor map" })
  }

  it("opens an overlay panel from the menu — a page shows its fallback — and closes it with Escape", async () => {
    await open()
    const user = userEvent.setup()
    const dialog = await openFromMenu(user)
    expect(within(dialog).getByText("The Farm")).toBeInTheDocument()
    expect(dialog.querySelector("iframe")).toBeNull()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("moves focus onto the overlay, and back to the menu button when Escape or × closes it", async () => {
    await open()
    const user = userEvent.setup()
    let dialog = await openFromMenu(user)
    expect(dialog).toHaveFocus()
    await user.keyboard("{Escape}")
    expect(screen.getByRole("button", { name: "Panels (3)" })).toHaveFocus()

    await user.click(screen.getByRole("button", { name: "Panels (3)" }))
    await user.click(screen.getByRole("button", { name: "Open" }))
    dialog = await screen.findByRole("dialog", { name: "Harbor map" })
    await user.click(within(dialog).getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Panels (3)" })).toHaveFocus()
  })

  it("keeps the player's focus through a `panels` refresh that re-creates the entry", async () => {
    const r = await open()
    const user = userEvent.setup()
    const dialog = await openFromMenu(user)
    const close = within(dialog).getByRole("button", { name: "Close" })
    act(() => close.focus())
    await r.view("panels", { panels: [TIDE, ROLL_CALL, { ...MAP }] })
    expect(close).toHaveFocus()
  })

  it("reopens a closed panel from the menu", async () => {
    await open()
    const user = userEvent.setup()
    usePanelsStore.getState().setClosed(TIDE.id, true)
    render(<PanelMenu />)
    await user.click(screen.getByRole("button", { name: "Panels (3)" }))
    await user.click(screen.getByRole("button", { name: "Reopen" }))
    expect(usePanelsStore.getState().closed[TIDE.id]).toBe(false)
  })

  it("says a page with no fallback needs a rich client", async () => {
    await open([{ ...MAP, slot: "sidebar", fallback: null }])
    render(<PanelSidebar />)
    expect(screen.getByText("This panel is available in the rich client.")).toBeInTheDocument()
  })
})

describe("PanelNotice", () => {
  it("states what arrived once per room", async () => {
    await open()
    const user = userEvent.setup()
    const { unmount } = render(<PanelNotice />)
    expect(screen.getByText("This room draws its own interface — 3 panels, 1.0 MB.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Got it" }))
    expect(screen.queryByText(/draws its own interface/)).toBeNull()
    unmount()
    render(<PanelNotice />)
    expect(screen.queryByText(/draws its own interface/)).toBeNull()
  })

  it("stays silent for a room without panels", async () => {
    await open([])
    const { container } = render(<PanelNotice />)
    expect(container).toBeEmptyDOMElement()
  })
})
