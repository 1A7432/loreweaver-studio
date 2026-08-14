import { describe, expect, it } from "vitest"
import i18n from "../../i18n"
import { describeImportFailure, describeInitvarFailure } from "./importErrors"
import { CardParseError, parseCardBytes } from "./split/charcard"
import { lorecardToProject } from "./split/lorecard"

const encoder = new TextEncoder()

/** The sentence the UI actually shows, so a missing key or an unfilled param
 * fails the test rather than shipping "studio.importErr.x" to an author. */
function rendered(problem: { key: string; params?: Record<string, unknown> }): string {
  return i18n.t(`studio.${problem.key}`, problem.params)
}

describe("describeImportFailure", () => {
  it("says what was expected and what was found, for every parse failure", async () => {
    const cases: [Uint8Array, string, RegExp][] = [
      [encoder.encode("not json at all"), "notes.json", /SillyTavern JSON \(v2\/v3\)/],
      [encoder.encode('"a string"'), "weird.json", /top level is something else/],
    ]
    for (const [bytes, name, expected] of cases) {
      const problem = await parseCardBytes(bytes, name).then(
        () => null,
        (cause: unknown) => describeImportFailure(cause, name),
      )
      expect(problem, name).not.toBeNull()
      const message = rendered(problem!)
      expect(message, name).toMatch(expected)
      // Always names the file: a batch drop must say WHICH one failed.
      expect(message, name).toContain(name)
    }
  })

  it("explains a PNG that carries no card, which is the common real failure", async () => {
    // A minimal valid PNG (signature + IHDR + IEND) — exactly what an image
    // editor produces after stripping the card's text chunk.
    const png = await parseCardBytes(minimalPng(), "avatar.png").then(
      () => null,
      (cause: unknown) => describeImportFailure(cause, "avatar.png"),
    )
    expect(png).not.toBeNull()
    expect(rendered(png!)).toMatch(/carries no embedded card/)
    expect(rendered(png!)).toMatch(/image editor/)
  })

  it("tells a SillyTavern card apart from a native bundle by name", () => {
    const problem = (() => {
      try {
        lorecardToProject({ spec: "chara_card_v3", data: { name: "X" } })
        return null
      } catch (cause) {
        return describeImportFailure(cause, "hana.json")
      }
    })()
    expect(rendered(problem!)).toMatch(/not a Loreweaver native bundle/)
    expect(rendered(problem!)).toMatch(/card splitter/)
  })

  it("names the version when a native bundle declares one we do not read", () => {
    const problem = (() => {
      try {
        lorecardToProject({ format: "loreweaver.card", format_version: 99 })
        return null
      } catch (cause) {
        return describeImportFailure(cause, "old.lorecard.json")
      }
    })()
    expect(rendered(problem!)).toMatch(/format_version 99/)
  })

  it("shows an unrecognized failure verbatim rather than inventing a cause", () => {
    const problem = describeImportFailure(new Error("EACCES: permission denied"), "x.json")
    expect(problem.key).toBe("importErr.unknown")
    expect(rendered(problem)).toContain("EACCES: permission denied")
  })

  it("maps a typed key straight into the message namespace", () => {
    expect(describeImportFailure(new CardParseError("fileTooLarge"), "big.png").key).toBe(
      "importErr.fileTooLarge",
    )
  })
})

describe("describeInitvarFailure", () => {
  it("reports nothing for a block that parses", () => {
    expect(describeInitvarFailure('{"a": 1}', "[InitVar]")).toBeNull()
    expect(describeInitvarFailure("理:\n  好感度: 0\n", "[InitVar]")).toBeNull()
  })

  it("gives the line and the parser's reason for a syntax error", () => {
    const problem = describeInitvarFailure("理:\n  好感度: 0\n : : :\n", "[InitVar] 主卡")
    expect(problem).not.toBeNull()
    expect(problem!.key).toBe("importErr.initvar.syntaxAt")
    expect(problem!.params?.line).toBeGreaterThan(0)
    const message = rendered(problem!)
    expect(message).toContain("[InitVar] 主卡")
    expect(message).toMatch(/line \d+/)
    expect(message).toMatch(/No variables were taken from it/)
  })

  it("distinguishes a refused anchor from a syntax error", () => {
    const problem = describeInitvarFailure("a: &x 1\nb: *x\n", "[InitVar]")
    expect(problem!.key).toBe("importErr.initvar.alias")
    expect(rendered(problem!)).toMatch(/anchors\/aliases/)
  })

  it("distinguishes a non-mapping top level", () => {
    const problem = describeInitvarFailure("- one\n- two\n", "[InitVar]")
    expect(problem!.key).toBe("importErr.initvar.notAMapping")
  })
})

/** Signature + a well-formed IHDR + IEND, and nothing else. */
function minimalPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (bytes: Uint8Array) => {
    let c = 0xffffffff
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Uint8Array) => {
    const typed = new Uint8Array([...encoder.encode(type), ...body])
    const out = new Uint8Array(8 + body.length + 4)
    const view = new DataView(out.buffer)
    view.setUint32(0, body.length)
    out.set(typed, 4)
    view.setUint32(8 + body.length, crc32(typed))
    return out
  }
  const ihdrBody = new Uint8Array(13)
  new DataView(ihdrBody.buffer).setUint32(0, 1)
  new DataView(ihdrBody.buffer).setUint32(4, 1)
  ihdrBody[8] = 8
  ihdrBody[9] = 6
  const ihdr = chunk("IHDR", ihdrBody)
  const iend = chunk("IEND", new Uint8Array(0))
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...iend])
}
