// PNG tavern-card writing — the inverse of split/charcard.ts's chunk walk.
// A V3 card JSON is embedded into a base PNG as two tEXt chunks before IEND:
// `chara` (a chara_card_v2 shell around the same data, for old readers) and
// `ccv3` (the V3 card verbatim). Any card chunks already on the base image are
// stripped first, so re-exporting over an existing card never double-embeds.
// Pure byte-level TS (tEXt is uncompressed — no zlib needed); the counterpart
// parser in charcard.ts is the round-trip oracle in tests.

import { bytesToBase64 } from "../../lib/native"
import { isRecord } from "./split/charcard"

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CARD_KEYWORDS = new Set(["chara", "ccv3"])
const TEXT_CHUNK_TYPES = new Set(["tEXt", "zTXt", "iTXt"])

/** Standard PNG CRC-32 (polynomial 0xedb88320), table-driven. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0xff) throw new Error(`non-latin1 char in chunk payload: ${text[i]}`)
    out[i] = code
  }
  return out
}

/** Assemble one PNG chunk: length + type + data + CRC(type+data). */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = encodeLatin1(type)
  if (typeBytes.length !== 4) throw new Error(`chunk type must be 4 bytes: ${type}`)
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(typeBytes, 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

interface RawChunk {
  type: string
  /** The whole chunk span (length + type + data + crc). */
  bytes: Uint8Array
  /** First NUL-terminated keyword for text chunks, "" otherwise. */
  keyword: string
}

function decodeLatin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes)
}

/** Walk a PNG into raw chunks; throws when the signature or layout is broken. */
function walkChunks(png: Uint8Array): RawChunk[] {
  const isPng =
    png.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => png[index] === byte)
  if (!isPng) throw new Error("not a PNG file")
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunks: RawChunk[] = []
  let offset = PNG_SIGNATURE.length
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset)
    const end = offset + 12 + length
    if (end > png.length) throw new Error("truncated PNG chunk")
    const type = decodeLatin1(png.subarray(offset + 4, offset + 8))
    let keyword = ""
    if (TEXT_CHUNK_TYPES.has(type)) {
      const data = png.subarray(offset + 8, offset + 8 + length)
      const nul = data.indexOf(0)
      keyword = decodeLatin1(nul === -1 ? data : data.subarray(0, nul))
    }
    chunks.push({ type, bytes: png.subarray(offset, end), keyword })
    offset = end
    if (type === "IEND") break
  }
  if (chunks.at(-1)?.type !== "IEND") throw new Error("PNG has no IEND chunk")
  return chunks
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = PNG_SIGNATURE.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  out.set(PNG_SIGNATURE, 0)
  let offset = PNG_SIGNATURE.length
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function cardTextChunk(keyword: string, card: Record<string, unknown>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(card))
  const payload = bytesToBase64(json)
  const keywordBytes = encodeLatin1(keyword)
  const data = new Uint8Array(keywordBytes.length + 1 + payload.length)
  data.set(keywordBytes, 0)
  data[keywordBytes.length] = 0
  data.set(encodeLatin1(payload), keywordBytes.length + 1)
  return pngChunk("tEXt", data)
}

/** Embed a V3 card into `basePng`: existing chara/ccv3 chunks are stripped,
 * fresh `chara` (V2 shell) + `ccv3` (V3 verbatim) land right before IEND. */
export function embedCardIntoPng(basePng: Uint8Array, v3Card: Record<string, unknown>): Uint8Array {
  const data = isRecord(v3Card.data) ? v3Card.data : {}
  const v2Shell = { spec: "chara_card_v2", spec_version: "2.0", data }
  const kept = walkChunks(basePng)
    .filter((chunk) => !(TEXT_CHUNK_TYPES.has(chunk.type) && CARD_KEYWORDS.has(chunk.keyword)))
    .map((chunk) => chunk.bytes)
  const iend = kept.pop()
  if (iend === undefined) throw new Error("PNG has no IEND chunk")
  return concatChunks([...kept, cardTextChunk("chara", v2Shell), cardTextChunk("ccv3", v3Card), iend])
}
