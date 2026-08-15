import { describe, expect, it } from "vitest"
import {
  buildInitVarContent,
  exportFileName,
  exportNativeBundle,
  exportSillyTavernCard,
  SELECTIVE_LOGIC_TO_INT,
} from "./exporters"
import { newLoreEntry, newPregen, newProject, validateProject, type ForgeVariable } from "./model"
import { newVariable } from "./model"
import { EPISODE_FIELD, filterEpisodeContent, type PackEpisode } from "./split/episodes"
import { embedCardIntoPng, pngChunk } from "./pngCard"
import { parseCardBytes } from "./split/charcard"

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The smallest thing `embedCardIntoPng` will accept, as in pngCard.test.ts. */
function minimalPng(): Uint8Array {
  const chunks = [
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("IDAT", new Uint8Array([1, 2, 3])),
    pngChunk("IEND", new Uint8Array(0)),
  ]
  const out = new Uint8Array(PNG_SIGNATURE.length + chunks.reduce((sum, c) => sum + c.length, 0))
  out.set(PNG_SIGNATURE, 0)
  let offset = PNG_SIGNATURE.length
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function project() {
  const p = newProject("Deep Pier")
  const suspicion: ForgeVariable = {
    ...newVariable(),
    id: "suspicion",
    kind: "number",
    labelEn: "Suspicion",
    minimum: "0",
    maximum: "10",
  }
  const ritual: ForgeVariable = {
    ...newVariable(),
    id: "ritual_stage",
    kind: "number",
    visibility: "keeper",
  }
  p.variables = [suspicion, ritual]
  p.lorebook = [
    {
      ...newLoreEntry(),
      title: "The Well",
      content: "Do not touch the well.",
      keys: "well, 井",
      secondaryKeys: "night",
      selectiveLogic: "not_all",
      condition: "suspicion >= 5",
      position: "before",
      probability: 80,
    },
    {
      ...newLoreEntry(),
      title: "Keeper truth",
      content: "The priest did it.",
      secret: true,
    },
  ]
  p.hooks = "on('turn_start', () => {})"
  p.tags = "coc, horror"
  return p
}

describe("native bundle export", () => {
  it("is lossless: keeper vars, secret lore, hooks, and trigger fields all ride", () => {
    const p = project()
    const { specs } = validateProject(p)
    const bundle = exportNativeBundle(p, specs) as Record<string, never>
    expect(bundle).toMatchObject({ format: "loreweaver.card", format_version: 1, name: "Deep Pier" })
    expect(bundle["tags"]).toEqual(["coc", "horror"])

    const variables = bundle["variables"] as Record<string, unknown>[]
    expect(variables).toHaveLength(2)
    expect(variables[1]).toMatchObject({ id: "ritual_stage", visibility: "keeper" })

    const worldbook = bundle["worldbook"] as Record<string, unknown>[]
    expect(worldbook).toHaveLength(2)
    expect(worldbook[0]).toMatchObject({
      title: "The Well",
      keys: ["well", "井"],
      secondary_keys: ["night"],
      selective_logic: "not_all",
      condition: "suspicion >= 5",
      position: "before",
      probability: 80,
    })
    expect(worldbook[1]).toMatchObject({ secret: true })
    // v1: hooks are the first-class top-level list, not an extensions key.
    expect(bundle["hooks"]).toEqual(["on('turn_start', () => {})"])
    expect(bundle).not.toHaveProperty("extensions")
  })

  it("uses the v1 prose field names", () => {
    const p = project()
    p.firstMes = "潮水拍打着栈桥。"
    p.mesExample = "<START>……"
    p.creatorNotes = "keeper first"
    const bundle = exportNativeBundle(p, validateProject(p).specs)
    expect(bundle["opening"]).toBe("潮水拍打着栈桥。")
    expect(bundle["dialogue_examples"]).toBe("<START>……")
    expect(bundle["author_notes"]).toBe("keeper first")
    for (const legacy of ["first_mes", "mes_example", "creator_notes", "alternate_greetings"]) {
      expect(bundle).not.toHaveProperty(legacy)
    }
  })

  it("omits the hooks and pregens keys when empty", () => {
    const p = project()
    p.hooks = "  "
    const bundle = exportNativeBundle(p, validateProject(p).specs)
    expect(bundle).not.toHaveProperty("hooks")
    expect(bundle).not.toHaveProperty("pregens")
  })

  it("rides a non-empty stable entry id and omits it otherwise", () => {
    const p = project()
    p.lorebook[0].stableId = "the-well"
    const bundle = exportNativeBundle(p, validateProject(p).specs)
    const worldbook = bundle["worldbook"] as Record<string, unknown>[]
    expect(worldbook[0]["id"]).toBe("the-well")
    expect(worldbook[1]).not.toHaveProperty("id")
  })

  it("exports the pregen cast with parsed skill overrides", () => {
    const p = project()
    p.pregens = [
      {
        ...newPregen(),
        name: "林晚",
        concept: "放不下的退休刑警",
        notes: "知道得太多。",
        skillsText: "侦查 60\n图书馆使用 55\njunk line\n斗殴 -5",
      },
      { ...newPregen(), name: "阿灿" },
    ]
    const bundle = exportNativeBundle(p, validateProject(p).specs)
    expect(bundle["pregens"]).toEqual([
      {
        name: "林晚",
        concept: "放不下的退休刑警",
        notes: "知道得太多。",
        // The junk line drops out here; validateProject surfaces it instead.
        skills: { 侦查: 60, 图书馆使用: 55, 斗殴: -5 },
      },
      { name: "阿灿" },
    ])
  })
})

describe("[InitVar] generation", () => {
  it("emits only player-visible specs as MVU value/description pairs", () => {
    const { specs } = validateProject(project())
    const content = JSON.parse(buildInitVarContent(specs)) as Record<string, [unknown, string]>
    expect(Object.keys(content)).toEqual(["suspicion"])
    expect(content.suspicion[0]).toBe(0)
    expect(content.suspicion[1]).toContain("range 0..10")
  })
})

describe("SillyTavern V3 export", () => {
  it("produces a V3 card with [InitVar], @@if decorators, and no secrets", () => {
    const p = project()
    const { specs } = validateProject(p)
    const card = exportSillyTavernCard(p, specs) as {
      spec: string
      spec_version: string
      data: Record<string, never>
    }
    expect(card.spec).toBe("chara_card_v3")
    expect(card.spec_version).toBe("3.0")
    expect(card.data["name"]).toBe("Deep Pier")
    expect(card.data["extensions"]).toEqual({ loreweaver_hooks: ["on('turn_start', () => {})"] })

    const book = card.data["character_book"] as { entries: Record<string, never>[] }
    // [InitVar] + The Well; the secret entry must be gone.
    expect(book.entries).toHaveLength(2)
    const [initvar, well] = book.entries
    expect(initvar["comment"]).toBe("[InitVar]")
    expect(initvar["constant"]).toBe(true)
    expect(JSON.parse(initvar["content"] as string)).toHaveProperty("suspicion")

    expect(well["comment"]).toBe("The Well")
    expect(well["content"]).toBe("@@if suspicion >= 5\nDo not touch the well.")
    expect(well["selective"]).toBe(true)
    expect(well["position"]).toBe("before_char")
    const ext = well["extensions"] as Record<string, unknown>
    expect(ext.selectiveLogic).toBe(SELECTIVE_LOGIC_TO_INT.not_all)
    expect(ext.probability).toBe(80)
    expect(JSON.stringify(card)).not.toContain("The priest did it")
  })

  it("omits the @@if line when there is no condition", () => {
    const p = project()
    p.lorebook[0].condition = ""
    const { specs } = validateProject(p)
    const card = exportSillyTavernCard(p, specs) as {
      data: { character_book: { entries: { content: string }[] } }
    }
    expect(card.data.character_book.entries[1].content).toBe("Do not touch the well.")
  })
})

describe("alternate greetings", () => {
  it("rides in both flavors, dropping blank entries", () => {
    const p = project()
    p.alternateGreetings = ["涨潮那晚。", "   "]
    const { specs } = validateProject(p)
    const native = exportNativeBundle(p, specs) as { alternate_openings: string[] }
    expect(native.alternate_openings).toEqual(["涨潮那晚。"])
    const st = exportSillyTavernCard(p, specs) as { data: { alternate_greetings: string[] } }
    expect(st.data.alternate_greetings).toEqual(["涨潮那晚。"])
  })

  it("tolerates projects persisted before the field existed", () => {
    const p = project()
    const legacy = { ...p } as Record<string, unknown>
    delete legacy.alternateGreetings
    const { specs } = validateProject(p)
    const st = exportSillyTavernCard(legacy as unknown as typeof p, specs) as {
      data: { alternate_greetings: string[] }
    }
    expect(st.data.alternate_greetings).toEqual([])
  })
})

describe("SillyTavern tavern-release options", () => {
  it("keeps secret lore when includeSecret is on", () => {
    const p = project()
    const { specs } = validateProject(p)
    const card = exportSillyTavernCard(p, specs, { includeSecret: true })
    const flat = JSON.stringify(card)
    expect(flat).toContain("The priest did it")
    const book = (card as { data: { character_book: { entries: { comment: string }[] } } }).data
      .character_book
    expect(book.entries.map((e) => e.comment)).toEqual(["[InitVar]", "The Well", "Keeper truth"])
  })

  it("rides the wizard's [InitVar] YAML verbatim instead of the flat synthesis", () => {
    const p = project()
    const { specs } = validateProject(p)
    const yaml = "理:\n  好感度: [0, '好感 [0,100]']\n  暗线: [0, '守秘人侧']\n"
    const card = exportSillyTavernCard(p, specs, { initvarSource: yaml }) as {
      data: { character_book: { entries: { comment: string; content: string }[] } }
    }
    const initvar = card.data.character_book.entries[0]
    expect(initvar.comment).toBe("[InitVar]")
    // Verbatim: hierarchy, CJK keys and keeper-side leaves all ride.
    expect(initvar.content).toBe(yaml)
  })

  it("lands update rules as the conventional constant entry after [InitVar]", () => {
    const p = project()
    const { specs } = validateProject(p)
    const card = exportSillyTavernCard(p, specs, { updateRules: "好感度:实质帮助 +1" }) as {
      data: { character_book: { entries: { comment: string; content: string; constant: boolean }[] } }
    }
    const [initvar, rules] = card.data.character_book.entries
    expect(initvar.comment).toBe("[InitVar]")
    expect(rules).toMatchObject({ comment: "变量更新规则", content: "好感度:实质帮助 +1", constant: true })
  })
})

describe("the serialized-module invariant holds on every deliverable path", () => {
  // Not "the tag is written" — that could be true while the release filter
  // still passed the entry through. This runs the REAL exporters into the REAL
  // filter, because the promise is about the file that circulates.
  const EPISODES: PackEpisode[] = [
    { id: "ep1", ordinal: 1, title: "第一章", summary: "", releaseNotes: "" },
    { id: "ep2", ordinal: 2, title: "第二章", summary: "", releaseNotes: "" },
  ]

  function tagged() {
    const p = project()
    p.lorebook = [
      { ...newLoreEntry(), title: "第一章的规则", content: "雨夜才有第五层。", episode: "ep1" },
      { ...newLoreEntry(), title: "第五层的住户", content: "他早已不是人类。", episode: "ep2" },
    ]
    return p
  }

  it("keeps chapter-2 lore out of an up-to-chapter-1 ST card", () => {
    const p = tagged()
    const { specs } = validateProject(p)
    const built = filterEpisodeContent(JSON.stringify(exportSillyTavernCard(p, specs)), EPISODES, 1)
    expect(built).not.toContain("他早已不是人类")
    expect(built).toContain("雨夜才有第五层")
    // …and the studio's own tag never reaches the circulating file.
    expect(built).not.toContain(`"${EPISODE_FIELD}"`)
  })

  it("keeps chapter-2 lore out of an up-to-chapter-1 native bundle", () => {
    const p = tagged()
    const { specs } = validateProject(p)
    const built = filterEpisodeContent(JSON.stringify(exportNativeBundle(p, specs)), EPISODES, 1)
    expect(built).not.toContain("他早已不是人类")
    expect(built).not.toContain(`"${EPISODE_FIELD}"`)
  })

  it("carries the tag through a PNG round trip, so an embedded card filters too", async () => {
    // A PNG is the shape a community editor hands around; it is the ST JSON in
    // a tEXt chunk, so it inherits the tag — but only if the JSON has one.
    const p = tagged()
    const { specs } = validateProject(p)
    const png = embedCardIntoPng(minimalPng(), exportSillyTavernCard(p, specs))
    const recovered = await parseCardBytes(png, "card.png")
    const built = filterEpisodeContent(JSON.stringify(recovered.raw), EPISODES, 1)
    expect(built).not.toContain("他早已不是人类")
    expect(built).toContain("雨夜才有第五层")
  })
})

describe("export file names", () => {
  it("sanitizes the project name per flavor", () => {
    const p = project()
    p.name = "Deep Pier: 深渊/试炼"
    expect(exportFileName(p, "native")).toBe("Deep_Pier_深渊_试炼.lorecard.json")
    expect(exportFileName(p, "st")).toBe("Deep_Pier_深渊_试炼.st.json")
  })
})
