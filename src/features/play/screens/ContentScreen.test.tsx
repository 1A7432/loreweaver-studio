// The room's content: packs, the rule system and the Keeper's skills from `admin/content`, each
// change a command, and an install whose answer — the trust card — is shown as the server wrote
// it. View values are the engine's own (`fixtures/actions.json`); the fixture server has no
// pack and no skill installed, so one of each is added to a copy of its view by the view's
// own shape (`AdminContentView`).

import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import "../../../i18n"
import { ACTION_FIXTURE, TestRoom, resultBody } from "../room.testkit"
import ContentScreen from "./ContentScreen"

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
})

function content() {
  const view = structuredClone(ACTION_FIXTURE.adminContent) as Record<string, unknown[]>
  view.packs = [{ id: "harbor", title: "The Harbour", version: "1.2.0", enabled: false }]
  view.skills = [
    { id: "harbor-lore", title: "Harbour lore", enabled: true, source: { kind: "pack", id: "harbor" } },
  ]
  return view
}

async function open() {
  room = await TestRoom.open("admin")
  await room.actionViews("admin")
  render(<ContentScreen onBack={() => {}} />)
  await room.view("admin/content", content())
  return room
}

function item(name: string): HTMLElement {
  return screen.getByText(name).closest("li") as HTMLElement
}

describe("ContentScreen", () => {
  it("lists packs, rule systems and skills with what this room has on", async () => {
    await open()
    expect(within(item("The Harbour")).getByRole("checkbox")).not.toBeChecked()
    expect(within(item("CoC")).getByRole("radio")).toBeChecked()
    expect(within(item("Harbour lore")).getByRole("checkbox")).toBeChecked()
    expect(item("Harbour lore")).toHaveTextContent("harbor")
    expect(item("DnD5e")).toHaveTextContent("built in")
  })

  it("turns a pack on, switches the rule system and turns a skill off, each by its command", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.click(within(item("The Harbour")).getByRole("checkbox"))
    expect(r.commands().at(-1)).toEqual({ id: "pack", args: { op: "enable", id: "harbor" } })
    await r.answer({ ok: true, text: "The Harbour is on in this room." })
    await user.click(within(item("DnD5e")).getByRole("radio"))
    expect(r.commands().at(-1)).toEqual({ id: "rule", args: { system: "dnd5e" } })
    await r.answer({ ok: true, text: "This room now plays DnD5e." })
    await user.click(within(item("Harbour lore")).getByRole("checkbox"))
    expect(r.commands().at(-1)).toEqual({ id: "skill", args: { op: "disable", id: "harbor-lore" } })
    await r.answer(resultBody("skillEnable"))
    expect(screen.getByRole("alert")).toHaveTextContent("This room has no skill x to enable.")
  })

  it("installs from a ref and shows the server's answer as it wrote it", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Where it is"), "gh:harbor/pack@v1.2.0")
    await user.click(screen.getByRole("button", { name: "Install" }))
    expect(r.commands().at(-1)).toEqual({ id: "pack", args: { op: "install", ref: "gh:harbor/pack@v1.2.0" } })
    expect(screen.getByRole("button", { name: "Installing…" })).toBeDisabled()
    await r.answer(resultBody("packInstallBad"))
    expect(screen.getByRole("alert")).toHaveTextContent("This server does not install packs from chat.")
  })
})
