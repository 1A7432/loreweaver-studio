// The pictures card: a gallery derived from the log the session holds, sharing a file by an
// upload with purpose `share`, the room's upload switch read from the `room` view and turned by
// the room admin with `uploads`. Frames from the protocol document (§13.2); views and results
// the engine's own (`fixtures/actions.json`).

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, convertFileSrc: (path: string) => path }))
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  pickUploadPath: vi.fn(async () => "/pics/map.png"),
}))
vi.mock("./panels/assets", () => ({
  assetFetch: vi.fn(async () => 4),
  assetReadBase64: vi.fn(async () => "aGVsbG8="),
}))

import { clearDataUrlCache } from "../../lib/dataUrlCache"
import { flush } from "../../lib/connection.testkit"
import MediaDeck from "./MediaDeck"
import { ACTION_FIXTURE, TestRoom, resultBody } from "./room.testkit"

const MAP = {
  name: "map.png",
  mime: "image/png",
  size: 48213,
  sha256: "3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
}
const SHARED = {
  type: "event",
  seq: 9,
  id: "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
  ts: 1764240040000,
  kind: "media",
  data: { hash: MAP.sha256, mime: "image/png", size: 48213, name: "map.png", from: "m:15b5f3445045" },
}

let room: TestRoom | null = null
beforeEach(() => {
  native.invoke.mockReset()
  clearDataUrlCache()
})
afterEach(() => {
  room?.close()
  room = null
})

async function open(role: "player" | "admin" | "observer") {
  room = await TestRoom.open(role, { head: 9 })
  if (role !== "observer") await room.actionViews(role)
  return room
}

describe("MediaDeck", () => {
  it("shows what was shared, fetched by its hash", async () => {
    const r = await open("player")
    await r.feed(SHARED)
    render(<MediaDeck />)
    expect(await screen.findByRole("img", { name: "map.png" })).toHaveAttribute(
      "src",
      "data:image/png;base64,aGVsbG8=",
    )
  })

  it("shares a file: offered with purpose share, PUT natively, said here", async () => {
    const r = await open("player")
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "media_prepare") return MAP
      if (command === "media_upload")
        return { hash: MAP.sha256, size: MAP.size, mime: MAP.mime, name: MAP.name }
      throw new Error(command)
    })
    render(<MediaDeck />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Share a file…" }))
    await r.feed()
    expect(native.invoke).toHaveBeenCalledWith("media_prepare", { path: "/pics/map.png", purpose: "share" })
    expect(r.lastRequest()).toMatchObject({ method: "media.offer", params: { ...MAP, purpose: "share" } })
    await r.answer({ ok: true, data: { upload_id: "c4b3a291-8f7e-4d6c-9b5a-4f3e2d1c0b9a" } })
    await act(async () => flush(10))
    expect(screen.getByRole("status")).toHaveTextContent("Shared map.png.")
  })

  it("shows a refused offer in the server's words", async () => {
    const r = await open("player")
    native.invoke.mockResolvedValue(MAP)
    render(<MediaDeck />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Share a file…" }))
    await r.feed()
    await r.answer({
      ok: false,
      error: { code: "media_rate_limited", message: "Too many uploads: wait a minute." },
    })
    await act(async () => flush(10))
    expect(screen.getByRole("alert")).toHaveTextContent("Too many uploads: wait a minute.")
  })

  it("offers no upload while the room's switch is off, and none to an observer", async () => {
    const r = await open("player")
    await r.view("room", structuredClone(ACTION_FIXTURE.roomUploadsOff))
    render(<MediaDeck />)
    expect(screen.queryByRole("button", { name: "Share a file…" })).toBeNull()
    expect(screen.getByText("Uploads are off in this room.")).toBeInTheDocument()
    r.close()
    room = null
    const watcher = await open("observer")
    await watcher.feed(SHARED)
    expect(screen.queryByRole("button", { name: "Share a file…" })).toBeNull()
  })

  it("lets the room admin turn uploads off with the uploads command", async () => {
    const r = await open("admin")
    render(<MediaDeck />)
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Members may upload" }))
    expect(r.commands()).toEqual([{ id: "uploads", args: { on: false } }])
    await r.answer(resultBody("uploadsOff"))
    await r.view("room", structuredClone(ACTION_FIXTURE.roomUploadsOff))
    expect(screen.getByRole("checkbox", { name: "Members may upload" })).not.toBeChecked()
  })
})
