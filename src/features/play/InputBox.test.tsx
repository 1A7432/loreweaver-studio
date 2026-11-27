// The input line: one `input` per line, and what its result says shown under the field.
// The frames are protocol.md §13.1's (steps 4–6).
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import "../../i18n"
import InputBox from "./InputBox"
import { TestRoom } from "./room.testkit"

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
})

async function open() {
  room = await TestRoom.open("player", { views: false })
  return room
}

const field = () => screen.getByLabelText("Speak, act, or type a command…")

describe("InputBox", () => {
  it("sends the typed line as one `input` and clears the field — no local echo", async () => {
    const r = await open()
    const user = userEvent.setup()
    const { container } = render(<InputBox />)
    // `[[` is how user-event types one `[`.
    await user.type(field(), "  I light the lantern. [[[[1d6]]  {Enter}")
    expect(r.lastRequest()).toMatchObject({ type: "input", text: "I light the lantern. [[1d6]]" })
    expect(field()).toHaveValue("")
    await r.answer({ ok: true })
    // Speech says nothing back here: its event is the table's.
    expect(container.querySelector(".command-feedback")).toBeNull()
  })

  it("shows a command's answer for this person", async () => {
    const r = await open()
    const user = userEvent.setup()
    render(<InputBox />)
    await user.type(field(), ".help{Enter}")
    await r.answer({ ok: true, text: "Commands: roll, check, sheet…" })
    expect(screen.getByRole("status")).toHaveTextContent("Commands: roll, check, sheet…")
  })

  it("shows a refusal's message as the server wrote it, not re-translated from its code", async () => {
    const r = await open()
    const user = userEvent.setup()
    render(<InputBox />)
    await user.type(field(), ".undo{Enter}")
    await r.answer({ ok: false, error: { code: "forbidden", message: "That is for the room admin." } })
    expect(screen.getByRole("alert")).toHaveTextContent("That is for the room admin.")
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("puts a line that never reached the room back in the field, and says so", async () => {
    const r = await open()
    const user = userEvent.setup()
    render(<InputBox />)
    await user.type(field(), "I wait.{Enter}")
    await r.drop()
    expect(screen.getByRole("alert")).toHaveTextContent(/Nothing was sent/)
    expect(field()).toHaveValue("I wait.")
  })

  it("does not send a blank line", async () => {
    const r = await open()
    const user = userEvent.setup()
    render(<InputBox />)
    await user.type(field(), "   {Enter}")
    expect(r.requests().filter((frame) => frame.type === "input")).toEqual([])
  })

  it("is disabled unless the session is online", async () => {
    const r = await open()
    await r.drop()
    render(<InputBox />)
    expect(field()).toBeDisabled()
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
  })
})
