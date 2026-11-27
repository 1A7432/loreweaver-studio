// Reading a save export's answer: the file it names, or nothing (`docs/protocol.md` §6.7). The
// answer is the engine's own (`features/play/fixtures/actions.json`).

import { describe, expect, it } from "vitest"
import type { Result } from "loreweaver-protocol/v3"
import { ACTION_FIXTURE } from "../features/play/room.testkit"
import { MAX_SAVE_BYTES, SAVE_LIMIT_MB, savedFile, sizeLabel } from "./roomSave"

const ANSWER = ACTION_FIXTURE.results.saveExport
const answer = (data: unknown): Result => ({ ok: true, text: ANSWER.text, data }) as Result

describe("savedFile", () => {
  it("names the file of the engine's own answer", () => {
    expect(savedFile(answer(ANSWER.data))).toEqual({
      hash: ANSWER.data.media.hash,
      size: ANSWER.data.media.size,
      name: ANSWER.data.media.name,
    })
  })

  it("is nothing for a refusal, another command's answer, or a file that is not a save", () => {
    const media = ANSWER.data.media
    expect(savedFile(null)).toBeNull()
    expect(savedFile({ ok: false, error: { code: "no_media", message: "m" } } as Result)).toBeNull()
    expect(savedFile(answer({ format: "loreweaver-room", version: 1 }))).toBeNull()
    expect(savedFile(answer({ ...ANSWER.data, media: { ...media, mime: "text/html" } }))).toBeNull()
    expect(savedFile(answer({ ...ANSWER.data, media: { ...media, hash: "cafe" } }))).toBeNull()
    expect(savedFile(answer({ ...ANSWER.data, media: { ...media, size: -1 } }))).toBeNull()
    expect(savedFile(answer({ ...ANSWER.data, documents: "0" }))).toBeNull()
  })
})

describe("the limit", () => {
  it("is the server's default for one save file, in the unit a person reads", () => {
    expect(MAX_SAVE_BYTES).toBe(256 * 1024 * 1024)
    expect(SAVE_LIMIT_MB).toBe(256)
    expect(sizeLabel(100)).toBe("100 B")
    expect(sizeLabel(12_582_912)).toBe("12.0 MB")
  })
})
