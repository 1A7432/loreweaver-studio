import { describe, expect, it } from "vitest"
import type { EventFrame } from "loreweaver-protocol/v3"
import { galleryOf, isPicture } from "./gallery"

// The `media` event of the protocol document (§13.2), and a `blocks` event of its block table (§8.3).
const MAP = "3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"
const PIN = "a".repeat(64)
const media = {
  type: "event",
  seq: 9,
  id: "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
  ts: 1764240040000,
  kind: "media",
  data: { hash: MAP, mime: "image/png", size: 48213, name: "map.png", from: "m:15b5f3445045" },
} as EventFrame
const blocks = {
  type: "event",
  seq: 10,
  id: "b-10",
  ts: 1764240041000,
  kind: "blocks",
  data: {
    blocks: [
      { kind: "image", hash: MAP, caption: "The harbour" },
      { kind: "map_pin", hash: PIN, label: "The lighthouse", x: 0.4, y: 0.2 },
      { kind: "text", text: "The fog thickens." },
    ],
  },
} as EventFrame

describe("galleryOf", () => {
  it("lists every picture once, newest first, from shares and from the story's blocks", () => {
    expect(galleryOf([media, blocks])).toEqual([
      { hash: PIN, mime: undefined, label: "The lighthouse", seq: 10, shared: false },
      { hash: MAP, mime: undefined, label: "The harbour", seq: 10, shared: false },
    ])
    expect(galleryOf([media])).toEqual([
      { hash: MAP, mime: "image/png", label: "map.png", seq: 9, shared: true },
    ])
  })

  it("tells a picture from a sound by its type", () => {
    expect(isPicture("image/png")).toBe(true)
    expect(isPicture(undefined)).toBe(true)
    expect(isPicture("audio/ogg")).toBe(false)
  })
})
