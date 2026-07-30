import { describe, expect, it } from "vitest"
import { CardParseError, normalizeCard, parseCardBytes } from "./charcard"

const encoder = new TextEncoder()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(encoder.encode(type), 4)
  out.set(data, 8)
  const crcInput = out.subarray(4, 8 + data.length)
  view.setUint32(8 + data.length, crc32(crcInput))
  return out
}

function pngWithText(keyword: string, text: string): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const keywordBytes = encoder.encode(keyword)
  const textBytes = encoder.encode(text)
  const chunkData = new Uint8Array(keywordBytes.length + 1 + textBytes.length)
  chunkData.set(keywordBytes, 0)
  chunkData.set(textBytes, keywordBytes.length + 1)
  const textChunk = pngChunk("tEXt", chunkData)
  const iend = pngChunk("IEND", new Uint8Array(0))
  const out = new Uint8Array(signature.length + textChunk.length + iend.length)
  out.set(signature, 0)
  out.set(textChunk, signature.length)
  out.set(iend, signature.length + textChunk.length)
  return out
}

function toBase64(text: string): string {
  const bytes = encoder.encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

describe("normalizeCard", () => {
  it("unwraps v2/v3 data envelopes and tolerates missing fields", () => {
    const card = normalizeCard({
      spec: "chara_card_v2",
      data: {
        name: "Mara",
        character_book: { entries: [{ comment: "e1" }, "not a dict"] },
        tags: ["a", "", 3],
      },
    })
    expect(card.name).toBe("Mara")
    expect(card.characterBook).toEqual([{ comment: "e1" }])
    expect(card.tags).toEqual(["a", "3"])
  })

  it("reads a bare (spec-less) card at the root", () => {
    const card = normalizeCard({ name: "Root", description: "d" })
    expect(card.name).toBe("Root")
    expect(card.description).toBe("d")
  })

  it("prefers creator_notes and falls back to the multilingual map", () => {
    const card = normalizeCard({ name: "n", creator_notes_multilingual: { zh: "中文", fr: "fr" } })
    expect(card.creatorNotes).toBe("中文")
  })
})

describe("parseCardBytes", () => {
  it("parses a UTF-8 JSON card (with BOM)", async () => {
    const body = JSON.stringify({ name: "Json Card", description: "desc" })
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(body)])
    const card = await parseCardBytes(bytes, "card.json")
    expect(card.name).toBe("Json Card")
  })

  it("extracts a base64 chara payload from a PNG tEXt chunk", async () => {
    const payload = JSON.stringify({
      spec: "chara_card_v3",
      data: { name: "深渊之主", description: "海港" },
    })
    const png = pngWithText("chara", toBase64(payload))
    const card = await parseCardBytes(png, "card.png")
    expect(card.name).toBe("深渊之主")
    expect(card.description).toBe("海港")
  })

  it("rejects a PNG without an embedded card", async () => {
    const png = pngWithText("comment", "not a card")
    await expect(parseCardBytes(png, "art.png")).rejects.toThrow(CardParseError)
  })

  it("rejects non-card bytes", async () => {
    await expect(parseCardBytes(encoder.encode("plain text"), "x.txt")).rejects.toThrow(CardParseError)
  })
})
