// The room's lifecycle: a save file out and in (an import ends every connection — said before
// it is sent), a reset armed then confirmed within the server's window, and an undo — each
// asked for before it acts. Results are the engine's own (`fixtures/actions.json`).
//
// A save travels on the byte channel: the export's answer names a file, which the native side
// fetches and writes (`save_fetch`); a restore is prepared and sent natively (`save_prepare`,
// `save_upload`) around a `media.offer {purpose: "save"}`. Here the native side is a double that
// records what it was asked; the page itself never holds the save's bytes.

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"

const native = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn(), open: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, convertFileSrc: (path: string) => path }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save, open: native.open }))

import { flush } from "../../../lib/connection.testkit"
import { MAX_SAVE_BYTES } from "../../../lib/roomSave"
import { ACTION_FIXTURE, TestRoom, actionResult, resultBody } from "../room.testkit"
import RoomLifecycle, { RESET_CONFIRM_MS } from "./RoomLifecycle"

/** The file the engine's export named (`fixtures/actions.json`). */
const EXPORTED = ACTION_FIXTURE.results.saveExport.data.media
/** A save file picked to restore, as the native side describes it. */
const PICKED = {
  name: "night.json",
  mime: "application/json",
  size: 12_582_912,
  sha256: "9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab",
}
const UPLOAD_ID = "c4b3a291-8f7e-4d6c-9b5a-4f3e2d1c0b9a"
/** The offer's answer when the room already holds those bytes. */
const EXISTING = {
  existing: { hash: PICKED.sha256, size: PICKED.size, mime: PICKED.mime, name: PICKED.name, from: "m-root" },
}

let room: TestRoom | null = null
const shell = window as unknown as { __TAURI_INTERNALS__?: unknown }
beforeEach(() => {
  native.invoke.mockReset()
  native.save.mockReset().mockResolvedValue("/saves/night.json")
  native.open.mockReset().mockResolvedValue("/saves/night.json")
  shell.__TAURI_INTERNALS__ = {}
})
afterEach(() => {
  vi.useRealTimers()
  delete shell.__TAURI_INTERNALS__
  room?.close()
  room = null
})

async function open() {
  room = await TestRoom.open("admin")
  await room.actionViews("admin")
  render(<RoomLifecycle onBack={() => {}} />)
  return room
}

function exportAnswer(media: Record<string, unknown> = EXPORTED) {
  const body = resultBody("saveExport") as { ok: true; text: string; data: Record<string, unknown> }
  return { ...body, data: { ...body.data, media } }
}

describe("RoomLifecycle", () => {
  it("asks where first, then fetches the file the export names and writes it there", async () => {
    const r = await open()
    native.invoke.mockResolvedValue(EXPORTED.size)
    await userEvent.setup().click(screen.getByRole("button", { name: "Save to a file…" }))
    expect(native.save).toHaveBeenCalledWith({
      defaultPath: expect.stringMatching(/^loreweaver-main-.*\.json$/),
      filters: [{ name: "Save files", extensions: ["json"] }],
    })
    expect(r.commands()).toEqual([{ id: "save", args: { op: "export" } }])
    await r.answer(exportAnswer())
    await act(async () => flush(10))
    expect(native.invoke).toHaveBeenCalledTimes(1)
    expect(native.invoke).toHaveBeenCalledWith("save_fetch", {
      hash: EXPORTED.hash,
      size: EXPORTED.size,
      path: "/saves/night.json",
    })
    expect(screen.getByText("Saved (100 B).")).toBeInTheDocument()
    // The server's own answer, as it wrote it.
    expect(screen.getByText(ACTION_FIXTURE.results.saveExport.text)).toBeInTheDocument()
  })

  it("exports nothing when the admin cancels the dialog, and nothing outside the app", async () => {
    const r = await open()
    native.save.mockResolvedValue(null)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Save to a file…" }))
    expect(r.commands()).toEqual([])
    delete shell.__TAURI_INTERNALS__
    await user.click(screen.getByRole("button", { name: "Save to a file…" }))
    expect(r.commands()).toEqual([])
    expect(screen.getByRole("alert")).toHaveTextContent("Saving a file needs the desktop app.")
    expect(native.invoke).not.toHaveBeenCalled()
  })

  it("refuses, in its own words, a save larger than it fetches", async () => {
    const r = await open()
    await userEvent.setup().click(screen.getByRole("button", { name: "Save to a file…" }))
    await r.answer(exportAnswer({ ...EXPORTED, size: MAX_SAVE_BYTES + 1 }))
    await act(async () => flush(10))
    expect(native.invoke).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("A save file may be at most 256 MB.")
  })

  it("shows a refused export and a refused fetch in the server's words, a bad file in its own", async () => {
    const r = await open()
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Save to a file…" }))
    await r.answer({ ok: false, error: { code: "no_media", message: "This server keeps no files." } })
    await act(async () => flush(10))
    expect(native.invoke).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("This server keeps no files.")

    native.invoke.mockRejectedValue({
      code: "media_not_found",
      message: "No such file in this room.",
      server: true,
    })
    await user.click(screen.getByRole("button", { name: "Save to a file…" }))
    await r.answer(exportAnswer())
    await act(async () => flush(10))
    expect(screen.getByText("No such file in this room.")).toBeInTheDocument()

    native.invoke.mockRejectedValue({ code: "hash_mismatch", message: "detail", server: false })
    await user.click(screen.getByRole("button", { name: "Save to a file…" }))
    await r.answer(exportAnswer())
    await act(async () => flush(10))
    expect(screen.getByText("The file did not match its checksum.")).toBeInTheDocument()
  })

  it("restores: says an import ends everyone's connection, then offers, sends and imports by hash", async () => {
    const r = await open()
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "save_prepare") return PICKED
      if (command === "save_upload")
        return { hash: PICKED.sha256, size: PICKED.size, mime: PICKED.mime, name: PICKED.name }
      throw new Error(command)
    })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Load a save file…" }))
    expect(native.invoke).toHaveBeenCalledWith("save_prepare", { path: "/saves/night.json" })
    expect(screen.getByRole("alert")).toHaveTextContent("Load night.json (12.0 MB)?")
    expect(screen.getByRole("alert")).toHaveTextContent("disconnects everyone in it — you too")
    expect(r.requests().filter((frame) => frame.type === "call" && frame.method === "media.offer")).toEqual(
      [],
    )
    expect(r.commands()).toEqual([])
    await user.click(screen.getByRole("button", { name: "Replace the room" }))
    await r.feed()
    expect(r.lastRequest()).toMatchObject({ method: "media.offer", params: { ...PICKED, purpose: "save" } })
    await r.answer({ ok: true, data: { upload_id: UPLOAD_ID } })
    await act(async () => flush(10))
    expect(native.invoke).toHaveBeenCalledWith("save_upload", {
      path: "/saves/night.json",
      uploadId: UPLOAD_ID,
      expectedSha256: PICKED.sha256,
    })
    expect(r.commands()).toEqual([{ id: "save", args: { op: "import", file: PICKED.sha256 } }])
  })

  it("sends nothing when the server already holds the save, and imports it", async () => {
    const r = await open()
    native.invoke.mockResolvedValue(PICKED)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Load a save file…" }))
    await user.click(screen.getByRole("button", { name: "Replace the room" }))
    await r.feed()
    await r.answer({ ok: true, data: EXISTING })
    await act(async () => flush(10))
    expect(native.invoke).not.toHaveBeenCalledWith("save_upload", expect.anything())
    expect(r.commands()).toEqual([{ id: "save", args: { op: "import", file: PICKED.sha256 } }])
  })

  it("refuses a file that is not a save file, or is too large, without sending anything", async () => {
    const r = await open()
    native.open.mockResolvedValue("/x/list.json")
    native.invoke.mockRejectedValue({ code: "not_a_save", message: "detail", server: false })
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Load a save file…" }))
    expect(screen.getByRole("alert")).toHaveTextContent("list.json is not a save file.")
    native.invoke.mockRejectedValue({ code: "too_large", message: "detail", server: false })
    await user.click(screen.getByRole("button", { name: "Load a save file…" }))
    expect(screen.getByRole("alert")).toHaveTextContent("A save file may be at most 256 MB.")
    expect(
      r.requests().filter((frame) => frame.type === "call" && frame.method !== "view.subscribe"),
    ).toEqual([])
  })

  it("shows a refused offer and a refused import in the server's words", async () => {
    const r = await open()
    native.invoke.mockResolvedValue(PICKED)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Load a save file…" }))
    await user.click(screen.getByRole("button", { name: "Replace the room" }))
    await r.feed()
    await r.answer({ ok: false, error: { code: "media_disabled", message: "Uploads are off in this room." } })
    await act(async () => flush(10))
    expect(screen.getByRole("alert")).toHaveTextContent("Uploads are off in this room.")
    expect(r.commands()).toEqual([])

    await user.click(screen.getByRole("button", { name: "Load a save file…" }))
    await user.click(screen.getByRole("button", { name: "Replace the room" }))
    await r.feed()
    await r.answer({ ok: true, data: EXISTING })
    await act(async () => flush(10))
    await r.answer(resultBody("saveImportNotUploaded"))
    expect(screen.getByRole("alert")).toHaveTextContent(
      (actionResult("saveImportNotUploaded") as { error: { message: string } }).error.message,
    )
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
