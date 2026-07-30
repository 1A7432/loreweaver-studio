import { describe, expect, it } from "vitest"
import { draftToPackMetadata, draftToProject, extractJsonBlock } from "./schemas"

describe("extractJsonBlock", () => {
  it("reads a fenced block, a bare object, and prose-wrapped JSON", () => {
    expect(extractJsonBlock('```json\n{"a": 1}\n```')).toEqual({ a: 1 })
    expect(extractJsonBlock('{"a": 1}')).toEqual({ a: 1 })
    expect(extractJsonBlock('Sure! Here is the card:\n{"a": {"b": "}"}} trailing')).toEqual({
      a: { b: "}" },
    })
    expect(extractJsonBlock("no json here")).toBeNull()
  })
})

describe("draftToProject", () => {
  const goodDraft = {
    name: "Deep Pier",
    description: "A drowned harbor.",
    tags: ["horror", "coc"],
    variables: [
      {
        id: "suspicion",
        kind: "number",
        visibility: "player",
        label_en: "Suspicion",
        label_zh: "怀疑度",
        minimum: 0,
        maximum: 10,
        default: 0,
      },
      { id: "stage", kind: "enum", options: ["calm", "storm"], label_en: "Stage", label_zh: "阶段" },
    ],
    worldbook: [
      {
        title: "The Well",
        content: "Do not touch it.",
        keys: ["well", "井"],
        secret: true,
        condition: "suspicion >= 5",
      },
    ],
    hooks: "on('turn_start', () => {})",
  }

  it("accepts a clean draft and lands it as a validated project", () => {
    const { project, problems } = draftToProject(goodDraft)
    expect(problems).toEqual([])
    expect(project).not.toBeNull()
    expect(project?.name).toBe("Deep Pier")
    expect(project?.variables).toHaveLength(2)
    expect(project?.variables[1].options).toBe("calm\nstorm")
    expect(project?.lorebook[0].keys).toBe("well, 井")
    expect(project?.lorebook[0].secret).toBe(true)
  })

  it("rejects bad kinds/ids with problems the model can act on", () => {
    const { project, problems } = draftToProject({
      name: "x",
      variables: [
        { id: "BAD ID!", kind: "number" },
        { id: "dup", kind: "float" },
        { id: "dup", kind: "bool" },
      ],
    })
    expect(project).toBeNull()
    expect(problems.some((problem) => problem.includes("variables[1].kind"))).toBe(true)
    expect(problems.some((problem) => problem.includes("idDuplicate"))).toBe(true)
  })

  it("rejects a non-object reply outright", () => {
    expect(draftToProject([1, 2]).problems).toEqual(["reply must be a single JSON object"])
  })
})

describe("draftToPackMetadata", () => {
  it("accepts bilingual metadata and defaults the version", () => {
    const { metadata, problems } = draftToPackMetadata({
      id: "deep-pier",
      name: { en: "Deep Pier", zh: "深渊码头" },
      description: { en: "d", zh: "描述" },
      authors: ["someone"],
      license: "MIT",
      card_notes: { en: "Run `.var expose 理`.", zh: "运行 `.var expose 理`。" },
    })
    expect(problems).toEqual([])
    expect(metadata?.version).toBe("0.1.0")
    expect(metadata?.cardNotesZh).toContain("理")
  })

  it("rejects a bad slug and missing localization", () => {
    const { metadata, problems } = draftToPackMetadata({ id: "Bad Slug", version: "x" })
    expect(metadata).toBeNull()
    expect(problems.length).toBeGreaterThanOrEqual(3)
  })
})
