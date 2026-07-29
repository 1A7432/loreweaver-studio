import { describe, expect, it } from "vitest"
import {
  buildInitVarContent,
  exportFileName,
  exportNativeBundle,
  exportSillyTavernCard,
  SELECTIVE_LOGIC_TO_INT,
} from "./exporters"
import { newLoreEntry, newProject, validateProject, type ForgeVariable } from "./model"
import { newVariable } from "./model"

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
    expect(bundle).toMatchObject({ format: "loreweaver.card", format_version: 0, name: "Deep Pier" })
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
    expect(bundle["extensions"]).toEqual({ loreweaver_hooks: ["on('turn_start', () => {})"] })
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

describe("export file names", () => {
  it("sanitizes the project name per flavor", () => {
    const p = project()
    p.name = "Deep Pier: 深渊/试炼"
    expect(exportFileName(p, "native")).toBe("Deep_Pier_深渊_试炼.lorecard.json")
    expect(exportFileName(p, "st")).toBe("Deep_Pier_深渊_试炼.st.json")
  })
})
