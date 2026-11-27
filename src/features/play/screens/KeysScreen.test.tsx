// The access keys: this room's keys from `admin/keys`, a change per `key` command, and a minted
// key shown once — on its own panel, with the ticket — held by nothing but that panel. Views and
// results are the engine's own (`fixtures/actions.json`).

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { ACTION_FIXTURE, TestRoom, actionResult, resultBody } from "../room.testkit"
import KeysScreen from "./KeysScreen"

const MINTED = (actionResult("keyMint") as { data: { key: string } }).data.key

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
  vi.restoreAllMocks()
})

async function open() {
  room = await TestRoom.open("admin")
  await room.actionViews("admin")
  render(<KeysScreen onBack={() => {}} />)
  await room.view("admin/keys", structuredClone(ACTION_FIXTURE.adminKeys))
  return room
}

function row(name: string): HTMLElement {
  return screen.getByText(name, { selector: "td" }).closest("tr") as HTMLElement
}

describe("KeysScreen", () => {
  it("holds admin/keys while open and lists the keys, masked", async () => {
    const r = await open()
    expect(
      r
        .requests()
        .some(
          (frame) =>
            frame.type === "call" &&
            frame.method === "view.subscribe" &&
            JSON.stringify(frame).includes("admin/keys"),
        ),
    ).toBe(true)
    expect(row("Root")).toHaveTextContent("root...cdef")
    expect(row("Ada")).toHaveTextContent("ada-...cdef")
  })

  it("shows a minted key once, beside the ticket, and nowhere else", async () => {
    const r = await open()
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ]
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Name"), "Bao")
    await user.click(screen.getByRole("button", { name: "Make key" }))
    expect(r.commands()).toEqual([{ id: "key", args: { op: "mint", name: "Bao", role: "player" } }])
    await r.answer(resultBody("keyMint"))
    const panel = screen.getByRole("region", { name: "New key" })
    expect(within(panel).getByTestId("minted-key")).toHaveTextContent(MINTED)
    expect(panel).toHaveTextContent("endpointabc")
    // The answer's own text carries the key too: it is not shown as feedback.
    expect(document.body.textContent?.split(MINTED).length).toBe(2)
    expect(JSON.stringify(r.connection.session.getSnapshot().events)).not.toContain(MINTED)
    for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain(MINTED)
    await user.click(screen.getByRole("button", { name: "Done — hide it" }))
    expect(document.body.textContent).not.toContain(MINTED)
  })

  it("asks before revoking, and shows a refusal in the server's words", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.click(within(row("Root")).getByRole("button", { name: "Revoke" }))
    expect(r.commands()).toEqual([])
    await user.click(within(row("Root")).getByRole("button", { name: "Revoke Root’s key for good" }))
    expect(r.commands()).toEqual([{ id: "key", args: { op: "revoke", id: "k:1e5aee6f3830" } }])
    await r.answer(resultBody("keyRevokeLast"))
    expect(screen.getByRole("alert")).toHaveTextContent("That is this room's last admin key")
  })

  it("renames a key and changes its role through the key command", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.selectOptions(within(row("Ada")).getByRole("combobox", { name: "Role of Ada" }), "observer")
    expect(r.commands().at(-1)).toEqual({
      id: "key",
      args: { op: "role", id: "k:f63b64bc4757", role: "observer" },
    })
    await r.answer({ ok: true, text: "Ada is an observer now." })
    await user.click(within(row("Ada")).getByRole("button", { name: "Rename" }))
    const field = screen.getByLabelText("New name for Ada")
    await user.clear(field)
    await user.type(field, "Ada L{Enter}")
    expect(r.commands().at(-1)).toEqual({
      id: "key",
      args: { op: "rename", id: "k:f63b64bc4757", name: "Ada L" },
    })
  })
})
