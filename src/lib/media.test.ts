// An upload is an offer on the control stream, then (unless the room already holds the bytes)
// a PUT the native side makes. Driven through a real protocol `Session`; the native steps are
// fakes. Frames are the protocol document's own (§13.2).

import { afterEach, describe, expect, it, vi } from "vitest"
import { TestRoom } from "../features/play/room.testkit"
import { ByteFailure, toByteFailure, uploadFile, type UploadSteps } from "./media"

const MAP = {
  name: "map.png",
  mime: "image/png",
  size: 48213,
  sha256: "3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
}
const STORED = { hash: MAP.sha256, size: MAP.size, mime: MAP.mime, name: MAP.name }

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
})

function steps(): UploadSteps & { prepare: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> } {
  return { prepare: vi.fn(async () => MAP), put: vi.fn(async () => STORED) }
}

describe("uploadFile", () => {
  it("offers the file with its purpose, then PUTs it under the upload id the server gave", async () => {
    room = await TestRoom.open("player")
    const native = steps()
    const done = uploadFile(room.connection, "/pics/map.png", "share", native)
    await room.feed()
    expect(native.prepare).toHaveBeenCalledWith("/pics/map.png", "share")
    expect(room.lastRequest()).toMatchObject({ method: "media.offer", params: { ...MAP, purpose: "share" } })
    await room.answer({ ok: true, data: { upload_id: "c4b3a291-8f7e-4d6c-9b5a-4f3e2d1c0b9a" } })
    await expect(done).resolves.toEqual(STORED)
    expect(native.put).toHaveBeenCalledWith(
      "/pics/map.png",
      "c4b3a291-8f7e-4d6c-9b5a-4f3e2d1c0b9a",
      MAP.sha256,
    )
  })

  it("sends nothing when the room already holds the bytes", async () => {
    room = await TestRoom.open("player")
    const native = steps()
    const done = uploadFile(room.connection, "/pics/map.png", "import", native)
    await room.feed()
    await room.answer({ ok: true, data: { existing: { ...STORED, from: "m:15b5f3445045" } } })
    await expect(done).resolves.toEqual(STORED)
    expect(native.put).not.toHaveBeenCalled()
  })

  it("rejects with the server's own words when the offer is refused", async () => {
    room = await TestRoom.open("player")
    // Caught at once: the refusal lands while the answer is being fed.
    const done = uploadFile(room.connection, "/pics/map.png", "share", steps()).catch(
      (error: unknown) => error,
    )
    await room.feed()
    await room.answer({
      ok: false,
      error: { code: "media_disabled", message: "Uploads are off in this room." },
    })
    expect(await done).toMatchObject({
      code: "media_disabled",
      message: "Uploads are off in this room.",
      server: true,
    })
  })
})

describe("toByteFailure", () => {
  it("reads the native side's structured failure", () => {
    expect(toByteFailure({ code: "media_not_found", message: "No such file.", server: true })).toMatchObject({
      code: "media_not_found",
      message: "No such file.",
      server: true,
    })
    expect(toByteFailure(new ByteFailure("too_large"))).toMatchObject({ code: "too_large", server: false })
    expect(toByteFailure(new Error("boom"))).toMatchObject({ code: "failed", server: false })
  })
})
