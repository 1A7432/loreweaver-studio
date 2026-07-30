import { parse } from "yaml"
import { describe, expect, it } from "vitest"
import {
  buildManifestYaml,
  buildPackSourcePlan,
  buildSkillMd,
  safeFileName,
  validatePackDraft,
  type WorldPackDraft,
} from "./packSource"

function draft(overrides: Partial<WorldPackDraft> = {}): WorldPackDraft {
  return {
    id: "deep-pier",
    version: "0.1.0",
    nameEn: "Deep Pier",
    nameZh: "深渊码头",
    descriptionEn: "A harbor module.",
    descriptionZh: "海港模组。",
    authors: ["author"],
    license: "CC-BY-4.0",
    cards: [
      {
        fileName: "deep-pier.st.json",
        kind: "world",
        jsonText: "{}",
        hasWorldPayloads: true,
        notesEn: "Run `.var expose 理` after import.",
        notesZh: "导入后运行 `.var expose 理`。",
      },
    ],
    lorebooks: [],
    skills: [],
    rulepacks: [],
    assets: [],
    ...overrides,
  }
}

describe("validatePackDraft", () => {
  it("passes a well-formed world draft", () => {
    expect(validatePackDraft(draft())).toEqual([])
  })

  it("enforces slug / semver / required metadata", () => {
    const issues = validatePackDraft(
      draft({ id: "Bad_ID", version: "1.0", nameEn: "", nameZh: "", license: "", authors: [""] }),
    )
    const keys = issues.map((issue) => issue.key)
    expect(keys).toContain("packIdInvalid")
    expect(keys).toContain("packVersionInvalid")
    expect(keys).toContain("packNameRequired")
    expect(keys).toContain("packLicenseRequired")
    expect(keys).toContain("packAuthorsRequired")
  })

  it("mirrors the engine's kind enforcement: world machinery ⇒ kind world", () => {
    const issues = validatePackDraft(
      draft({
        cards: [
          {
            fileName: "heavy.png",
            kind: "character",
            base64: "aGk=",
            hasWorldPayloads: true,
            notesEn: "",
            notesZh: "",
          },
        ],
      }),
    )
    expect(issues.map((issue) => issue.key)).toContain("packCardKindMismatch")
  })

  it("rejects skill slugs and rulepack ids that are not slugs", () => {
    const issues = validatePackDraft(
      draft({
        skills: [{ slug: "Bad Slug", nameEn: "", descriptionEn: "", descriptionZh: "", hooks: [] }],
        rulepacks: [{ id: "No_good", yamlText: "extends: coc7" }],
      }),
    )
    const keys = issues.map((issue) => issue.key)
    expect(keys).toContain("packSkillSlugInvalid")
    expect(keys).toContain("packRulepackIdInvalid")
  })
})

describe("buildManifestYaml", () => {
  it("emits the engine manifest shape: localized fields, card mapping, no trust block", () => {
    const manifest = parse(buildManifestYaml(draft())) as Record<string, unknown>
    expect(manifest.id).toBe("deep-pier")
    expect(manifest.name).toEqual({ en: "Deep Pier", zh: "深渊码头" })
    expect(manifest.trust).toBeUndefined()
    const contents = manifest.contents as Record<string, unknown>
    expect(contents.cards).toEqual([
      {
        path: "cards/deep-pier.st.json",
        kind: "world",
        notes: {
          en: "Run `.var expose 理` after import.",
          zh: "导入后运行 `.var expose 理`。",
        },
      },
    ])
  })

  it("dumps a plain character card with no notes as a bare path string", () => {
    const manifest = parse(
      buildManifestYaml(
        draft({
          cards: [
            {
              fileName: "npc.json",
              kind: "character",
              jsonText: "{}",
              hasWorldPayloads: false,
              notesEn: "",
              notesZh: "",
            },
          ],
        }),
      ),
    ) as Record<string, { cards: unknown[] }>
    expect(manifest.contents.cards).toEqual(["cards/npc.json"])
  })
})

describe("buildSkillMd / buildPackSourcePlan", () => {
  it("emits SKILL.md frontmatter that parse_skill_text accepts (fenced YAML mapping)", () => {
    const md = buildSkillMd({
      slug: "pier-hooks",
      nameEn: "Pier Hooks",
      descriptionEn: "Extracted from the card.",
      descriptionZh: "从卡中抽取。",
      hooks: ["on('turn_start', f)"],
    })
    expect(md.startsWith("---\n")).toBe(true)
    const [, frontmatter] = md.split("---\n")
    const parsed = parse(frontmatter) as Record<string, unknown>
    expect(parsed.name).toBe("Pier Hooks")
    expect(parsed.metadata).toEqual({ scope: "room" })
  })

  it("lays out the full source tree with hooks joined into one hooks.js", () => {
    const plan = buildPackSourcePlan(
      draft({
        skills: [
          {
            slug: "pier-hooks",
            nameEn: "Pier Hooks",
            descriptionEn: "d",
            descriptionZh: "",
            hooks: ["one()", "two()"],
          },
        ],
        rulepacks: [{ id: "coc7-pier", yamlText: "extends: coc7\n" }],
        lorebooks: [{ fileName: "extra.json", jsonText: "{}" }],
      }),
    )
    expect(plan.dirName).toBe("deep-pier")
    const paths = plan.files.map((file) => file.path)
    expect(paths).toEqual([
      "pack.yaml",
      "cards/deep-pier.st.json",
      "lorebooks/extra.json",
      "skills/pier-hooks/SKILL.md",
      "skills/pier-hooks/hooks.js",
      "rulepacks/coc7-pier.yaml",
    ])
    const hooksJs = plan.files.find((file) => file.path.endsWith("hooks.js"))
    expect(hooksJs?.contents).toContain("// --- hook 1 ---")
    expect(hooksJs?.contents).toContain("two()")
  })

  it("declares assets by path only and ships their bytes as binaries", () => {
    const plan = buildPackSourcePlan(draft({ assets: [{ fileName: "map.png", base64: "aGk=" }] }))
    const manifest = parse(plan.files[0].contents) as { assets?: unknown }
    // Integrity fields are the engine's to fill at build time.
    expect(manifest.assets).toEqual([{ path: "assets/map.png" }])
    expect(plan.binaries).toContainEqual({ path: "assets/map.png", base64: "aGk=" })
  })

  it("routes PNG cards through the binary list", () => {
    const plan = buildPackSourcePlan(
      draft({
        cards: [
          {
            fileName: "heavy.png",
            kind: "world",
            base64: "aGk=",
            hasWorldPayloads: true,
            notesEn: "",
            notesZh: "",
          },
        ],
      }),
    )
    expect(plan.binaries).toEqual([{ path: "cards/heavy.png", base64: "aGk=" }])
  })
})

describe("safeFileName", () => {
  it("keeps unicode letters and falls back when nothing survives", () => {
    expect(safeFileName("深渊码头 v2", "card")).toBe("深渊码头_v2")
    expect(safeFileName("///", "card")).toBe("card")
  })
})
