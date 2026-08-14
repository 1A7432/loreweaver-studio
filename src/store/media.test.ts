import { beforeEach, describe, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({
  mediaPrepare: vi.fn(async (path: string) => ({
    name: path.split("/").pop() ?? "x",
    mime: "image/png",
    size: 1024,
    sha256: "abc123",
  })),
  mediaUpload: vi.fn(async () => "abc123"),
}))
const transport = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  transportSend: vi.fn(async (frame: Record<string, unknown>) => void frame),
}))

vi.mock("../lib/media", () => native)
vi.mock("../lib/transport", () => ({ ...transport, TRANSPORT_EVENT: "loreweaver://transport" }))

import { useMediaStore } from "./media"

const IMAGE = {
  type: "media" as const,
  id: "m1",
  hash: "abc123",
  mime: "image/png",
  size: 1024,
  name: "handout.png",
  from: "Nyx",
  ts: 1,
}

describe("media store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useMediaStore.getState().reset()
  })

  it("keeps the room's picture and audio broadcasts apart", () => {
    const store = useMediaStore.getState()
    expect(store.ingest(IMAGE)).toBe(true)
    expect(
      store.ingest({
        type: "audio_library_item",
        id: "a1",
        hash: "def456",
        mime: "audio/mpeg",
        size: 4096,
        name: "chao-yong.mp3",
        from: "Nyx",
        ts: 2,
        title: "潮涌",
      }),
    ).toBe(true)
    expect(useMediaStore.getState().images).toHaveLength(1)
    expect(useMediaStore.getState().audio[0].title).toBe("潮涌")
  })

  it("records the keeper's upload switch, and starts not knowing it", () => {
    expect(useMediaStore.getState().uploadsEnabled).toBeNull()
    useMediaStore.getState().ingest({ type: "media_enabled", enabled: false })
    expect(useMediaStore.getState().uploadsEnabled).toBe(false)
  })

  it("offers a file with what the native side measured, then PUTs on accept", async () => {
    await useMediaStore.getState().upload("/tmp/handout.png")
    expect(transport.transportSend).toHaveBeenCalledWith({
      type: "media_offer",
      name: "handout.png",
      mime: "image/png",
      size: 1024,
      sha256: "abc123",
    })
    expect(useMediaStore.getState().uploads.abc123.phase).toBe("offering")

    useMediaStore.getState().ingest({ type: "media_accept", upload_id: "u-7" })
    await vi.waitFor(() => expect(useMediaStore.getState().uploads.abc123.phase).toBe("done"))
    expect(native.mediaUpload).toHaveBeenCalledWith("/tmp/handout.png", "u-7", "abc123")
  })

  it("sends no bytes when the room already holds them", async () => {
    // `{upload_id:"", existing:true, media}` — the accept carries the metadata
    // and the server broadcasts nothing new, so the picture has to land here.
    await useMediaStore.getState().upload("/tmp/handout.png")
    useMediaStore.getState().ingest({ type: "media_accept", upload_id: "", existing: true, media: IMAGE })

    await vi.waitFor(() => expect(useMediaStore.getState().uploads.abc123.phase).toBe("done"))
    expect(native.mediaUpload).not.toHaveBeenCalled()
    expect(useMediaStore.getState().images).toHaveLength(1)
  })

  it("keeps the native failure message on the row it belongs to", async () => {
    native.mediaUpload.mockRejectedValueOnce(new Error("media_too_large: over the per-file cap"))
    await useMediaStore.getState().upload("/tmp/handout.png")
    useMediaStore.getState().ingest({ type: "media_accept", upload_id: "u-7" })

    await vi.waitFor(() => expect(useMediaStore.getState().uploads.abc123.phase).toBe("error"))
    expect(useMediaStore.getState().uploads.abc123.error).toContain("media_too_large")
  })

  it("lets a refused file surface where the picker is, not as a pending row", async () => {
    native.mediaPrepare.mockRejectedValueOnce(new Error("notes.txt: not an image or audio format"))
    await expect(useMediaStore.getState().upload("/tmp/notes.txt")).rejects.toThrow(/not an image/)
    expect(useMediaStore.getState().uploads).toEqual({})
  })

  it("sends the keeper switch and the avatar binding as their own frames", () => {
    useMediaStore.getState().setUploadsEnabled(false)
    expect(transport.transportSend).toHaveBeenCalledWith({ type: "media_set_enabled", enabled: false })
    useMediaStore.getState().setAvatar("abc123")
    expect(transport.transportSend).toHaveBeenCalledWith({ type: "avatar_set", hash: "abc123" })
  })

  it("ignores frames from the other families", () => {
    expect(useMediaStore.getState().ingest({ type: "system", level: "info", text: "x" })).toBe(false)
  })
})
