// The room's lifecycle: a save file out and in (an import ends every connection — said before
// it is sent), a reset armed then confirmed within the server's window, and an undo — each
// asked for before it acts. Results are the engine's own (`fixtures/actions.json`).

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"

const files = vi.hoisted(() => ({ saveSecretTextFile: vi.fn(), pickJsonFile: vi.fn() }))
vi.mock("../../../lib/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/files")>()),
  saveSecretTextFile: files.saveSecretTextFile,
}))
vi.mock("../../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/native")>()),
  pickJsonFile: files.pickJsonFile,
}))

import { flush } from "../../../lib/connection.testkit"
import { ACTION_FIXTURE, TestRoom, resultBody } from "../room.testkit"
import RoomLifecycle, { RESET_CONFIRM_MS } from "./RoomLifecycle"

/** A bundle of the shape the engine's export answered (its top-level fields; the contents are
 * opaque to this client and pass through untouched). */
const BUNDLE = Object.fromEntries(
  ACTION_FIXTURE.results.saveExport.dataKeys.map((key, index) => [key, index]),
)

let room: TestRoom | null = null
beforeEach(() => {
  files.saveSecretTextFile.mockReset().mockResolvedValue("saved")
  files.pickJsonFile.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  room?.close()
  room = null
})

async function open() {
  room = await TestRoom.open("admin")
  await room.actionViews("admin")
  render(<RoomLifecycle onBack={() => {}} />)
  return room
}

describe("RoomLifecycle", () => {
  it("writes an export to a file the admin picks, and nowhere else", async () => {
    const r = await open()
    await userEvent.setup().click(screen.getByRole("button", { name: "Save to a file…" }))
    expect(r.commands()).toEqual([{ id: "save", args: { op: "export" } }])
    const bundle = BUNDLE
    await r.answer({ ok: true, text: ACTION_FIXTURE.results.saveExport.text, data: bundle })
    await act(async () => flush(10))
    expect(files.saveSecretTextFile).toHaveBeenCalledWith(
      expect.stringMatching(/^loreweaver-main-.*\.json$/),
      JSON.stringify(bundle, null, 2),
    )
    expect(screen.getByText("Saved.")).toBeInTheDocument()
  })

  it("says an import ends everyone's connection before it sends it", async () => {
    const r = await open()
    const bundle = BUNDLE
    files.pickJsonFile.mockResolvedValue({
      name: "night.json",
      bytes: new TextEncoder().encode(JSON.stringify(bundle)),
      path: "/x/night.json",
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Load a save file…" }))
    expect(screen.getByRole("alert")).toHaveTextContent("disconnects everyone in it — you too")
    expect(r.commands()).toEqual([])
    await user.click(screen.getByRole("button", { name: "Replace the room" }))
    expect(r.commands()).toEqual([{ id: "save", args: { op: "import", bundle } }])
  })

  it("refuses a file that is not a save file without sending anything", async () => {
    const r = await open()
    files.pickJsonFile.mockResolvedValue({
      name: "list.json",
      bytes: new TextEncoder().encode("[1,2]"),
      path: "/x/list.json",
    })
    await userEvent.setup().click(screen.getByRole("button", { name: "Load a save file…" }))
    expect(screen.getByRole("alert")).toHaveTextContent("list.json is not a save file.")
    expect(r.commands()).toEqual([])
  })

  it("arms a reset, then confirms it within the window; the server's words both times", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Reset…" }))
    expect(r.commands()).toEqual([{ id: "reset", args: { scope: "story" } }])
    await r.answer(resultBody("resetArm"))
    expect(screen.getByRole("status")).toHaveTextContent("Send .reset confirm within 60s")
    await user.click(screen.getByRole("button", { name: /Confirm the reset \(60 s\)/ }))
    expect(r.commands().at(-1)).toEqual({ id: "reset", args: { confirm: true } })
    await r.answer(resultBody("resetConfirm"))
    expect(screen.getByRole("status")).toHaveTextContent("Reset complete")
  })

  it("stops offering the confirmation once the window has passed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    const r = await open()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(screen.getByRole("button", { name: "Reset…" }))
    await r.answer(resultBody("resetArm"))
    expect(screen.getByRole("button", { name: /Confirm the reset/ })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(RESET_CONFIRM_MS + 1000))
    expect(screen.queryByRole("button", { name: /Confirm the reset/ })).toBeNull()
    expect(screen.getByRole("button", { name: "Reset…" })).toBeInTheDocument()
  })

  it("asks before an undo, and shows its refusal", async () => {
    const r = await open()
    const user = userEvent.setup()
    const turns = screen.getByLabelText("Turns")
    await user.clear(turns)
    await user.type(turns, "5")
    await user.click(screen.getByRole("button", { name: "Undo…" }))
    expect(r.commands()).toEqual([])
    await user.click(screen.getByRole("button", { name: "Undo 5 turn(s)" }))
    expect(r.commands()).toEqual([{ id: "undo", args: { turns: 5 } }])
    await r.answer(resultBody("undoOutOfRange"))
    expect(screen.getByRole("alert")).toHaveTextContent("There is no earlier turn to go back to.")
  })
})
