// The room behind the main menu, on a real session fed the engine's own view values.
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Role } from "loreweaver-protocol/v3"
import "../../i18n"
import { usePanelsStore } from "../../store/panels"
import OnlineView from "./OnlineView"
import { TestRoom } from "./room.testkit"

let room: TestRoom | null = null
beforeEach(() => {
  usePanelsStore.setState({ collapsed: {}, closed: {}, modalOpen: null, noticeRooms: ["main"] })
})
afterEach(() => {
  room?.close()
  room = null
})

async function open(role: Role = "player") {
  room = await TestRoom.open(role)
  return room
}

describe("OnlineView", () => {
  it("lands on the main menu; Enter game opens the story; Esc goes back", async () => {
    await open()
    const user = userEvent.setup()
    render(<OnlineView />)
    expect(screen.getByText(/Table “main”/)).toHaveTextContent("Ada · Player")
    await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
    expect(screen.getByText("main · Ada")).toBeInTheDocument()
    expect(screen.getByLabelText("Speak, act, or type a command…")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.getByText(/Table “main”/)).toBeInTheDocument()
  })

  it("gives everyone the game, the character, the report and settings", async () => {
    await open("player")
    render(<OnlineView />)
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "⚄Enter game",
      "⚄My character",
      "⚄Session report",
      "⚄Settings",
    ])
  })

  it("gives the room admin the keys, the models, the content and the room's lifecycle too", async () => {
    await open("admin")
    const user = userEvent.setup()
    render(<OnlineView />)
    expect(screen.getByText(/Table “main”/)).toHaveTextContent("Root · Room admin")
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "⚄Enter game",
      "⚄My character",
      "⚄Session report",
      "⚄Settings",
      "⚄Access keys",
      "⚄Models",
      "⚄Packs, rules & skills",
      "⚄Save, undo & reset",
    ])
    await user.click(screen.getByRole("menuitem", { name: /Access keys/ }))
    expect(screen.getByRole("heading", { name: "Access keys" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.getByText(/Table “main”/)).toBeInTheDocument()
  })

  it("plays a line through the game screen and shows the story it comes back as", async () => {
    const r = await open()
    const user = userEvent.setup()
    render(<OnlineView />)
    await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
    await user.type(screen.getByLabelText("Speak, act, or type a command…"), "I wait by the quay.{Enter}")
    expect(r.lastRequest()).toMatchObject({ type: "input", text: "I wait by the quay." })
    await r.feed(
      {
        type: "event",
        seq: 1,
        id: "e-1",
        ts: 1764240000001,
        kind: "narrative",
        turn: 1,
        data: {
          speaker: "player",
          name: "Ada",
          member: "m-ada",
          text: "I wait by the quay.",
          format: "plain",
        },
      },
      { type: "result", rid: r.lastRequest().rid, ok: true },
    )
    const log = document.querySelector(".narrative-log") as HTMLElement
    expect(within(log).getByText("I wait by the quay.")).toBeInTheDocument()
  })

  it("closes a panel overlay on Escape without leaving the game", async () => {
    const r = await open()
    const user = userEvent.setup()
    await r.view("panels", {
      panels: [
        {
          id: "harbor/map",
          title: "Harbor map",
          slot: "modal",
          kind: "template",
          views: [],
          source: { kind: "pack", id: "harbor" },
          blocks: [{ kind: "text", text: "the tide line" }],
        },
      ],
    })
    usePanelsStore.getState().openModal("harbor/map")
    render(<OnlineView />)
    await user.click(screen.getByRole("menuitem", { name: /Enter game/ }))
    expect(screen.getByRole("dialog", { name: "Harbor map" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(screen.getByText("main · Ada")).toBeInTheDocument()
  })

  it("cancels a sheet edit on Escape without returning to the menu", async () => {
    await open()
    const user = userEvent.setup()
    render(<OnlineView />)
    await user.click(screen.getByRole("menuitem", { name: /My character/ }))
    const row = screen.getByText("Luck").closest("tr") as HTMLElement
    await user.click(within(row).getByRole("button", { name: "50" }))
    expect(screen.getByLabelText("Luck")).toBeInTheDocument()
    await user.keyboard("{Escape}")
    expect(screen.queryByLabelText("Luck")).not.toBeInTheDocument()
    expect(screen.queryByText(/Table “main”/)).not.toBeInTheDocument()
  })
})
