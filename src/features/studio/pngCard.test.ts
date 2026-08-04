import { describe, expect, it } from "vitest"
import { newProject, validateProject } from "./model"
import { exportSillyTavernCard } from "./exporters"
import { parseCardBytes } from "./split/charcard"
import { embedCardIntoPng, pngChunk } from "./pngCard"

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function assemble(...chunks: Uint8Array[]): Uint8Array {
  const total = SIGNATURE.length + chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  out.set(SIGNATURE, 0)
  let offset = SIGNATURE.length
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function minimalPng(): Uint8Array {
  return assemble(
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("IDAT", new Uint8Array([1, 2, 3])),
    pngChunk("IEND", new Uint8Array(0)),
  )
}

function cardFor(name: string): Record<string, unknown> {
  const project = newProject(name)
  project.description = "疤从左眉切到颧骨。"
  project.firstMes = "钟敲了四下。"
  project.alternateGreetings = ["另一个开场。"]
  const { specs } = validateProject(project)
  return exportSillyTavernCard(project, specs)
}

function keywordCount(png: Uint8Array, keyword: string): number {
  const text = new TextDecoder("latin1").decode(png)
  return text.split(`${keyword}\u0000`).length - 1
}

describe("embedCardIntoPng", () => {
  it("round-trips through the split parser (chara + ccv3 both land)", async () => {
    const png = embedCardIntoPng(minimalPng(), cardFor("阿理"))
    expect(keywordCount(png, "chara")).toBe(1)
    expect(keywordCount(png, "ccv3")).toBe(1)

    const parsed = await parseCardBytes(png, "阿理.st.png")
    expect(parsed.name).toBe("阿理")
    expect(parsed.description).toBe("疤从左眉切到颧骨。")
    expect(parsed.firstMes).toBe("钟敲了四下。")
    // The raw payload keeps V3-only fields like alternate_greetings.
    const raw = parsed.raw as { data?: { alternate_greetings?: string[] } }
    expect(raw.data?.alternate_greetings).toEqual(["另一个开场。"])
  })

  it("strips existing card chunks before embedding (re-export never doubles)", async () => {
    const first = embedCardIntoPng(minimalPng(), cardFor("旧卡"))
    const second = embedCardIntoPng(first, cardFor("新卡"))
    expect(keywordCount(second, "chara")).toBe(1)
    expect(keywordCount(second, "ccv3")).toBe(1)
    const parsed = await parseCardBytes(second, "x.png")
    expect(parsed.name).toBe("新卡")
  })

  it("rejects non-PNG bytes and PNGs without IEND", () => {
    const card = cardFor("x")
    expect(() => embedCardIntoPng(new Uint8Array([1, 2, 3]), card)).toThrow(/not a PNG/)
    const noIend = assemble(pngChunk("IHDR", new Uint8Array(13)))
    expect(() => embedCardIntoPng(noIend, card)).toThrow(/IEND/)
  })
})
