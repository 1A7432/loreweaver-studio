import { describe, expect, it, vi } from "vitest"

vi.mock("./panels/assets", () => ({
  assetFetch: vi.fn(),
  assetReadBase64: vi.fn(),
}))

import { assetFetch, assetReadBase64 } from "./panels/assets"
import {
  BASE64_DECODE_CHUNK_CHARS,
  bytesFromBase64,
  cachedAudioUrl,
  objectUrlFromBase64,
} from "./audioPlayback"

function encodeStd(bytes: Uint8Array): string {
  let binary = ""
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

describe("bytesFromBase64", () => {
  it("round-trips a known vector and does not keep a data-URL prefix", () => {
    expect(Array.from(bytesFromBase64("aGVsbG8="))).toEqual([104, 101, 108, 108, 111])
  })

  it("returns empty bytes for empty input", () => {
    expect(bytesFromBase64("").length).toBe(0)
  })

  it("honours one- and two-byte padding and an unpadded last quantum", () => {
    expect(Array.from(bytesFromBase64("YQ=="))).toEqual([97])
    expect(Array.from(bytesFromBase64("YWI="))).toEqual([97, 98])
    expect(Array.from(bytesFromBase64("YWJj"))).toEqual([97, 98, 99])
  })

  it("decodes a payload that spans more than one atob chunk, padding on the last", () => {
    // One extra byte past a full chunk of output so the last quartet is `xx==`.
    const raw = Uint8Array.from({ length: (BASE64_DECODE_CHUNK_CHARS / 4) * 3 + 1 }, (_, i) => i % 251)
    const encoded = encodeStd(raw)
    expect(encoded.length).toBeGreaterThan(BASE64_DECODE_CHUNK_CHARS)
    expect(encoded.endsWith("==")).toBe(true)
    expect(Array.from(bytesFromBase64(encoded))).toEqual(Array.from(raw))
  })

  it("decodes a two-byte remainder that lands in the second chunk", () => {
    const raw = Uint8Array.from({ length: (BASE64_DECODE_CHUNK_CHARS / 4) * 3 + 2 }, (_, i) => (i * 7) % 256)
    const encoded = encodeStd(raw)
    expect(encoded.endsWith("=") && !encoded.endsWith("==")).toBe(true)
    expect(Array.from(bytesFromBase64(encoded))).toEqual(Array.from(raw))
  })

  it("rejects a length that is not a multiple of 4", () => {
    expect(() => bytesFromBase64("YQ")).toThrow(/invalid base64/)
    expect(() => bytesFromBase64("YWJ")).toThrow(/invalid base64/)
  })

  it("rejects illegal alphabet, mid-string padding, and over-padding", () => {
    expect(() => bytesFromBase64("@@@@")).toThrow(/invalid base64/)
    expect(() => bytesFromBase64("YQ==YQ==")).toThrow(/invalid base64/)
    expect(() => bytesFromBase64("Y===")).toThrow(/invalid base64/)
    expect(() => bytesFromBase64("YQ==\n")).toThrow(/invalid base64/)
  })
})

describe("objectUrlFromBase64", () => {
  it("hands the browser a blob URL, not a second 4/3 data URL", () => {
    const created: Blob[] = []
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      created.push(blob as Blob)
      return "blob:test/audio-1"
    })
    expect(objectUrlFromBase64("aGVsbG8=", "audio/mpeg")).toBe("blob:test/audio-1")
    expect(create).toHaveBeenCalledOnce()
    expect(created[0].type).toBe("audio/mpeg")
    expect(created[0].size).toBe(5)
    create.mockRestore()
  })

  it("does not build a URL from illegal base64", () => {
    expect(() => objectUrlFromBase64("YQ", "audio/mpeg")).toThrow(/invalid base64/)
  })
})

describe("cachedAudioUrl", () => {
  it("fetches the verified cache then builds a blob URL from the read", async () => {
    vi.mocked(assetFetch).mockResolvedValue(5)
    vi.mocked(assetReadBase64).mockResolvedValue("aGVsbG8=")
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test/audio-2")
    await expect(cachedAudioUrl("abc", "audio/ogg")).resolves.toBe("blob:test/audio-2")
    expect(assetFetch).toHaveBeenCalledWith("abc")
    expect(assetReadBase64).toHaveBeenCalledWith("abc")
    create.mockRestore()
  })

  it("surfaces a fetch failure instead of returning a silent URL", async () => {
    vi.mocked(assetFetch).mockRejectedValue(new Error("blob exceeds the client cap"))
    await expect(cachedAudioUrl("abc", "audio/mpeg")).rejects.toThrow(/client cap/)
  })
})
