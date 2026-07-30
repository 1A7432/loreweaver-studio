// SillyTavern character-card parsing — a TypeScript mirror of the engine's
// `core/charcard.py` (JSON cards + PNG-embedded `chara`/`ccv3` text chunks),
// so what the studio splits is exactly what the server would import. Caps are
// copied from the engine: cards are untrusted input here too.

export const MAX_CARD_FILE_BYTES = 16 * 1024 * 1024
export const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Parse failures carry an i18n key (rendered by the UI) + a detail string. */
export class CardParseError extends Error {
  readonly key: string

  constructor(key: string, detail = "") {
    super(detail ? `${key}: ${detail}` : key)
    this.key = key
  }
}

/** The engine's `CharacterCard` shape (camelCased); `raw` keeps the full JSON. */
export interface StCharacterCard {
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
  mesExample: string
  creatorNotes: string
  tags: string[]
  characterBook: Record<string, unknown>[]
  raw: Record<string, unknown>
}

export function asText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  // The engine `str()`s exotic values; for the one shape seen in the wild
  // (`creator_notes_multilingual` maps) pick a readable locale instead.
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const locale of ["en", "zh"]) {
      if (typeof record[locale] === "string") return record[locale]
    }
    const first = Object.values(record).find((v) => typeof v === "string")
    if (typeof first === "string") return first
  }
  return ""
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Mirror of `_normalize_card`: v2/v3 unwrap via `data`, tolerant field reads. */
export function normalizeCard(raw: unknown): StCharacterCard {
  if (!isRecord(raw)) throw new CardParseError("notAnObject")

  const spec = raw.spec
  const body = spec === "chara_card_v2" || spec === "chara_card_v3" ? raw.data : raw
  const fields: Record<string, unknown> = isRecord(body) ? body : {}

  const book = fields.character_book
  const rawEntries = isRecord(book) ? book.entries : undefined
  const entries = Array.isArray(rawEntries) ? rawEntries.filter(isRecord) : []

  const rawTags = Array.isArray(fields.tags) ? fields.tags : []

  return {
    name: asText(fields.name),
    description: asText(fields.description),
    personality: asText(fields.personality),
    scenario: asText(fields.scenario),
    firstMes: asText(fields.first_mes),
    mesExample: asText(fields.mes_example),
    creatorNotes: asText(fields.creator_notes) || asText(fields.creator_notes_multilingual),
    tags: rawTags.map(asText).filter((tag) => tag.length > 0),
    characterBook: entries,
    raw,
  }
}

function looksLikeJson(data: Uint8Array, filename: string): boolean {
  if (filename.toLowerCase().endsWith(".json")) return true
  let i = 0
  // Skip a UTF-8 BOM and ASCII whitespace, then look for a JSON opener.
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) i = 3
  while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d))
    i++
  return data[i] === 0x7b || data[i] === 0x5b // { or [
}

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data) // strips a leading BOM by default
}

function decodeLatin1(data: Uint8Array): string {
  return new TextDecoder("latin1").decode(data)
}

function parseJsonCard(data: Uint8Array): StCharacterCard {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(data))
  } catch {
    throw new CardParseError("unsupportedFormat")
  }
  return normalizeCard(parsed)
}

/** Inflate a zlib stream with a hard output cap (the engine's zlib-bomb guard). */
async function boundedInflate(data: Uint8Array, limit = MAX_DECOMPRESSED_BYTES): Promise<Uint8Array> {
  const stream = new Blob([data.slice().buffer]).stream().pipeThrough(new DecompressionStream("deflate"))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new CardParseError("decompressTooLarge")
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function splitAtNul(data: Uint8Array, from = 0): [Uint8Array, number] | null {
  const nul = data.indexOf(0, from)
  if (nul === -1) return null
  return [data.subarray(from, nul), nul + 1]
}

/** Read one tEXt/zTXt/iTXt chunk into `(keyword, text)`; null when unusable. */
async function readTextChunk(chunkType: string, data: Uint8Array): Promise<[string, string] | null> {
  const head = splitAtNul(data)
  if (head === null) return null
  const [keywordBytes, afterKeyword] = head
  const keyword = decodeLatin1(keywordBytes)

  if (chunkType === "tEXt") {
    return [keyword, decodeLatin1(data.subarray(afterKeyword))]
  }

  if (chunkType === "zTXt") {
    if (data.length < afterKeyword + 2) return null
    if (data[afterKeyword] !== 0) return null // compression method
    const inflated = await boundedInflate(data.subarray(afterKeyword + 1))
    return [keyword, decodeUtf8(inflated)]
  }

  // iTXt: compFlag(1) compMethod(1) language\0 translated\0 text
  if (data.length < afterKeyword + 2) return null
  const compressionFlag = data[afterKeyword]
  const compressionMethod = data[afterKeyword + 1]
  if (compressionMethod !== 0) return null
  const afterFlags = afterKeyword + 2
  const language = splitAtNul(data, afterFlags)
  if (language === null) return null
  const translated = splitAtNul(data, language[1])
  if (translated === null) return null
  let text = data.subarray(translated[1])
  if (compressionFlag) text = await boundedInflate(text)
  return [keyword, decodeUtf8(text)]
}

function decodeCardPayload(text: string): Record<string, unknown> {
  // The engine decodes with `validate=False` (non-alphabet bytes discarded);
  // atob is strict, so scrub to the base64 alphabet first.
  const scrubbed = text.replace(/[^A-Za-z0-9+/=]/g, "")
  let parsed: unknown
  try {
    const binary = atob(scrubbed)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    parsed = JSON.parse(decodeUtf8(bytes))
  } catch {
    throw new CardParseError("invalidEmbeddedPayload")
  }
  if (!isRecord(parsed)) throw new CardParseError("invalidEmbeddedPayload")
  return parsed
}

async function extractPngCardJson(data: Uint8Array): Promise<Record<string, unknown>> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = PNG_SIGNATURE.length
  while (offset + 12 <= data.length) {
    const length = view.getUint32(offset)
    const chunkType = decodeLatin1(data.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const crcEnd = dataEnd + 4
    if (crcEnd > data.length) break

    if (chunkType === "tEXt" || chunkType === "zTXt" || chunkType === "iTXt") {
      const found = await readTextChunk(chunkType, data.subarray(dataStart, dataEnd))
      if (found !== null) {
        const [keyword, text] = found
        if (keyword === "chara" || keyword === "ccv3") return decodeCardPayload(text)
      }
    }
    offset = crcEnd
  }
  throw new CardParseError("pngWithoutCard")
}

/** Mirror of `parse_card_bytes`: JSON first, then the PNG chunk walk. */
export async function parseCardBytes(data: Uint8Array, filename = ""): Promise<StCharacterCard> {
  if (data.length > MAX_CARD_FILE_BYTES) throw new CardParseError("fileTooLarge")
  if (looksLikeJson(data, filename)) return parseJsonCard(data)

  const isPng =
    data.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => data[index] === byte)
  if (isPng) return normalizeCard(await extractPngCardJson(data))

  return parseJsonCard(data)
}
