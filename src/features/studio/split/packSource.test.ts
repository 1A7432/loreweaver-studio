import { parse } from "yaml"
import { describe, expect, it } from "vitest"
import {
  buildManifestYaml,
  buildPackSourcePlan,
  buildPresentationYaml,
  buildSkillMd,
  safeFileName,
  validatePackDraft,
  type PackPresentationDraft,
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
        jsonText: "{}",
        notesEn: "Run `.var expose 理` after import.",
        notesZh: "导入后运行 `.var expose 理`。",
      },
    ],
    lorebooks: [],
    skills: [],
    rulepacks: [],
    assets: [],
    panels: null,
    presentation: null,
    ...overrides,
  }
}

const PANELS_YAML = `panels:
  - id: hud
    title: {en: HUD, zh: 状态板}
    slot: sidebar
    blocks:
      - {kind: meter, label: {en: Fear, zh: 恐慌}, value: {$var: fear}, min: 0, max: 10}
  - id: case-board
    title: {en: Case Board, zh: 案情板}
    slot: modal
    audience: all
    entry: ui/case-board/index.html
    assets:
      - ui/case-board/index.html
      - ui/case-board/app.js
    fallback:
      - {kind: text, text: {en: "Rich client only.", zh: "请在富客户端查看。"}}
`

function panelsDraft(yaml = PANELS_YAML) {
  return {
    yamlText: yaml,
    files: [
      { path: "ui/case-board/index.html", contents: "<main></main>" },
      { path: "ui/case-board/app.js", contents: "console.log(1)" },
    ],
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
  it("emits the v2 author shape: localized fields, notes mapping, no trust/files/kind", () => {
    const manifest = parse(buildManifestYaml(draft())) as Record<string, unknown>
    expect(manifest.id).toBe("deep-pier")
    expect(manifest.name).toEqual({ en: "Deep Pier", zh: "深渊码头" })
    // Generated at pack time or detection-stamped: never hand-written.
    expect(manifest.trust).toBeUndefined()
    expect(manifest.files).toBeUndefined()
    expect(manifest.manifest_version).toBeUndefined()
    // Minimum-version block, mirroring the flagship reference pack.
    expect(manifest.engine).toEqual({ protocol: "2.0" })
    const contents = manifest.contents as Record<string, unknown>
    // Manifest v2: authors never declare `kind` — a noted card carries
    // exactly {path, notes}; the build stamps the detected kind.
    expect(contents.cards).toEqual([
      {
        path: "cards/deep-pier.st.json",
        notes: {
          en: "Run `.var expose 理` after import.",
          zh: "导入后运行 `.var expose 理`。",
        },
      },
    ])
  })

  it("dumps a card with no notes as a bare path string", () => {
    const manifest = parse(
      buildManifestYaml(
        draft({
          cards: [
            {
              fileName: "npc.json",
              jsonText: "{}",
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
            base64: "aGk=",
            notesEn: "",
            notesZh: "",
          },
        ],
      }),
    )
    expect(plan.binaries).toEqual([{ path: "cards/heavy.png", base64: "aGk=" }])
  })
})

describe("panels (M15)", () => {
  it("accepts a well-formed panels draft and plans ui/ into the source tree", () => {
    const withPanels = draft({ panels: panelsDraft() })
    expect(validatePackDraft(withPanels)).toEqual([])

    const plan = buildPackSourcePlan(withPanels)
    const paths = plan.files.map((file) => file.path)
    expect(paths).toContain("ui/panels.yaml")
    expect(paths).toContain("ui/case-board/index.html")
    expect(paths).toContain("ui/case-board/app.js")

    const manifest = parse(plan.files[0].contents) as { contents: Record<string, unknown> }
    expect(manifest.contents.panels).toEqual(["ui/panels.yaml"])
  })

  it("omits contents.panels entirely when the pack ships none", () => {
    const manifest = parse(buildManifestYaml(draft())) as { contents: Record<string, unknown> }
    expect("panels" in manifest.contents).toBe(false)
  })

  it("flags YAML that does not parse, with the first error line as detail", () => {
    const issues = validatePackDraft(draft({ panels: { yamlText: "panels: [", files: [] } }))
    expect(issues.map((issue) => issue.key)).toContain("packPanelsYamlInvalid")
  })

  it("mirrors the engine's structural rules (tier-2 fallback, asset confinement, missing files)", () => {
    const badYaml = `panels:
  - id: Case_Board
    title: Board
    slot: nowhere
    entry: ui/case-board/index.html
    assets:
      - ui/case-board/index.html
      - ui/elsewhere/app.js
`
    const issues = validatePackDraft(
      draft({
        panels: {
          yamlText: badYaml,
          files: [{ path: "ui/case-board/index.html", contents: "<main></main>" }],
        },
      }),
    )
    const keys = issues.map((issue) => issue.key)
    expect(keys).toContain("packPanelInvalid")
    expect(keys).toContain("packPanelMissingFile")
    const details = issues
      .filter((issue) => issue.key === "packPanelInvalid")
      .map((issue) => String(issue.params?.detail))
    expect(details.some((detail) => detail.includes("slug"))).toBe(true)
    expect(details.some((detail) => detail.includes("slot"))).toBe(true)
    expect(details.some((detail) => detail.includes("fallback"))).toBe(true)
    expect(details.some((detail) => detail.includes("outside the entry's directory"))).toBe(true)
  })

  it("flags shipped panel files no panel references, and paths outside ui/", () => {
    const issues = validatePackDraft(
      draft({
        panels: {
          yamlText: PANELS_YAML,
          files: [
            { path: "ui/case-board/index.html", contents: "<main></main>" },
            { path: "ui/case-board/app.js", contents: "x" },
            { path: "ui/stray.css", contents: "x" },
            { path: "elsewhere/evil.js", contents: "x" },
          ],
        },
      }),
    )
    const keys = issues.map((issue) => issue.key)
    expect(keys).toContain("packPanelFileOrphan")
    expect(keys).toContain("packPanelPathInvalid")
  })

  it("ships a hand-written SKILL.md verbatim and flags one without frontmatter", () => {
    const custom =
      "---\nname: Direction\ndescription: Keeper craft.\nmetadata:\n  scope: room\n---\n\n# 導演台本\n"
    const md = buildSkillMd({
      slug: "direction",
      nameEn: "",
      descriptionEn: "",
      descriptionZh: "",
      hooks: [],
      skillMd: custom,
    })
    expect(md).toBe(custom)

    const issues = validatePackDraft(
      draft({
        skills: [
          {
            slug: "direction",
            nameEn: "",
            descriptionEn: "",
            descriptionZh: "",
            hooks: [],
            skillMd: "no frontmatter",
          },
        ],
      }),
    )
    expect(issues.map((issue) => issue.key)).toContain("packSkillMdNoFrontmatter")
  })
})

describe("panels 2.1 (M19): new block kinds + visible_when", () => {
  const YAML_21 = `panels:
  - id: handouts
    title: {en: Handouts, zh: 手边物}
    slot: tray
    blocks:
      - {kind: image, src: ui/handouts/page.png, caption: {en: "Torn page", zh: 残页}, alt: {en: "Nine lanterns"}}
      - {kind: letter, body: {en: "Meet at the pier."}, from: "K.", date: {en: "March 3"}}
      - {kind: clipping, headline: {en: "Nine lanterns vanish"}, body: {en: "The tide took them."}, source: {en: Gazette}}
      - {kind: map_pin, src: ui/handouts/map.png, label: {en: "Tide mark"}, x: 0.25, y: {$var: pin_y}, note: {en: "went out here"}}
      - {kind: title_card, title: {en: "The Send-Off"}, act: {en: "Act III"}, subtitle: {en: "what the tide keeps"}}
      - {kind: text, style: warning, visible_when: "祭典日 >= 3", text: {en: "Tonight they burn."}}
      - repeat: {prefix: "mvu.线索.", block: {kind: badge, label: {$leaf: label}, visible_when: "stage === 2"}}
`

  it("accepts the five new block kinds with visible_when gates", () => {
    const issues = validatePackDraft(
      draft({
        panels: {
          yamlText: YAML_21,
          files: [
            { path: "ui/handouts/page.png", base64: "eA==" },
            { path: "ui/handouts/map.png", base64: "eA==" },
          ],
        },
      }),
    )
    expect(issues).toEqual([])
  })

  it("counts an image src as a panel file reference (never orphaned, flagged when missing)", () => {
    // The engine folds image srcs into the ONE asset pipeline: a src whose
    // file the source tree does not ship fails the build
    // (`core.pack._enforce_panel_images`), so the wizard says it first.
    const missing = validatePackDraft(
      draft({
        panels: {
          yamlText: YAML_21,
          files: [{ path: "ui/handouts/page.png", base64: "eA==" }],
        },
      }),
    )
    expect(missing.map((issue) => issue.key)).toContain("packPanelMissingFile")
    expect(
      missing.some(
        (issue) => issue.key === "packPanelMissingFile" && issue.params?.file === "ui/handouts/map.png",
      ),
    ).toBe(true)

    const orphan = validatePackDraft(
      draft({
        panels: {
          yamlText: YAML_21,
          files: [
            { path: "ui/handouts/page.png", base64: "eA==" },
            { path: "ui/handouts/map.png", base64: "eA==" },
            { path: "ui/handouts/stray.png", base64: "eA==" },
          ],
        },
      }),
    )
    expect(orphan.map((issue) => issue.key)).toEqual(["packPanelFileOrphan"])
    expect(orphan[0].params?.file).toBe("ui/handouts/stray.png")
  })

  it("flags a new-kind block missing a required field, with the engine's field names", () => {
    const issues = validatePackDraft(
      draft({
        panels: {
          yamlText: `panels:
  - id: handouts
    title: Handouts
    slot: tray
    blocks:
      - {kind: clipping, headline: {en: "Nine lanterns vanish"}}
      - {kind: map_pin, src: ui/m.png, label: {en: Pin}, x: 0.5}
      - {kind: image, caption: {en: "no src"}}
`,
          files: [],
        },
      }),
    )
    const details = issues
      .filter((issue) => issue.key === "packPanelInvalid")
      .map((issue) => String(issue.params?.detail))
    expect(details.some((detail) => detail.includes("blocks[0]: missing body"))).toBe(true)
    expect(details.some((detail) => detail.includes("blocks[1]: missing y"))).toBe(true)
    expect(details.some((detail) => detail.includes("blocks[2].src"))).toBe(true)
  })

  it("catches out-of-subset visible_when BEFORE the engine build — repeat inner blocks included", () => {
    const issues = validatePackDraft(
      draft({
        panels: {
          yamlText: `panels:
  - id: gated
    title: Gated
    slot: sidebar
    blocks:
      - {kind: text, text: hi, visible_when: "day + 1 > 46"}
      - repeat: {prefix: "mvu.", block: {kind: badge, label: x, visible_when: "clues[0] === 'ash'"}}
`,
          files: [],
        },
      }),
    )
    const details = issues
      .filter((issue) => issue.key === "packPanelInvalid")
      .map((issue) => String(issue.params?.detail))
      .filter((detail) => detail.includes("visible_when"))
    expect(details).toHaveLength(2)
    expect(details[0]).toContain("blocks[0].visible_when")
    expect(details[1]).toContain("repeat.block")
    expect(details[0]).toContain("portable subset")
  })

  it("validates a tier-2 panel's fallback blocks the same way", () => {
    const issues = validatePackDraft(
      draft({
        panels: {
          yamlText: `panels:
  - id: board
    title: Board
    slot: modal
    entry: ui/board/index.html
    assets: [ui/board/index.html]
    fallback:
      - {kind: letter, from: "K."}
`,
          files: [{ path: "ui/board/index.html", contents: "<main></main>" }],
        },
      }),
    )
    const details = issues
      .filter((issue) => issue.key === "packPanelInvalid")
      .map((issue) => String(issue.params?.detail))
    expect(details.some((detail) => detail.includes("fallback[0]: missing body"))).toBe(true)
  })
})

describe("safeFileName", () => {
  it("keeps unicode letters and falls back when nothing survives", () => {
    expect(safeFileName("深渊码头 v2", "card")).toBe("深渊码头_v2")
    expect(safeFileName("///", "card")).toBe("card")
  })
})

describe("presentation kit (M19)", () => {
  function presentationDraft(overrides: Partial<PackPresentationDraft> = {}): PackPresentationDraft {
    return {
      generation: "allow",
      templates: [],
      keywordsEn: "ink wash, muted indigo",
      keywordsZh: "水墨, 靛青",
      bannedText: "text overlays\nmodern clothing",
      paletteText: "",
      subjects: [
        {
          uid: "s1",
          id: "wantang",
          kind: "npc",
          nameEn: "Gu Wantang",
          nameZh: "顾晚棠",
          refFileName: "wantang.png",
          refBase64: "aGk=",
          prompt: "a woman in her thirties, plain dark coat, wet hair",
        },
        {
          uid: "s2",
          id: "the-quay",
          kind: "location",
          nameEn: "The quay",
          nameZh: "石埠",
          refFileName: "",
          refBase64: "",
          prompt: "",
        },
      ],
      audio: [
        {
          uid: "a1",
          id: "tide",
          layer: "bgm",
          assetFileName: "tide.mp3",
          assetBase64: "bXA=",
          title: "潮涌",
        },
      ],
      ...overrides,
    }
  }

  it("emits the exact kit shape `core/presentation.py` parses, wired into manifest + plan", () => {
    const kit = presentationDraft()
    expect(parse(buildPresentationYaml(kit))).toEqual({
      version: 2,
      generation: "allow",
      style: {
        keywords: { en: "ink wash, muted indigo", zh: "水墨, 靛青" },
        banned: ["text overlays", "modern clothing"],
      },
      subjects: [
        {
          id: "wantang",
          kind: "npc",
          name: { en: "Gu Wantang", zh: "顾晚棠" },
          ref: "assets/wantang.png",
          prompt: "a woman in her thirties, plain dark coat, wet hair",
        },
        // Ref-less is LEGAL (nameable, never generated) — no ref/prompt keys.
        { id: "the-quay", kind: "location", name: { en: "The quay", zh: "石埠" } },
      ],
      audio: [{ id: "tide", layer: "bgm", asset: "assets/tide.mp3", title: "潮涌" }],
    })

    const withKit = draft({ presentation: kit })
    expect(validatePackDraft(withKit)).toEqual([])
    const manifest = parse(buildManifestYaml(withKit)) as {
      contents: Record<string, unknown>
      assets: unknown
    }
    expect(manifest.contents.presentation).toEqual(["ui/presentation.yaml"])
    // Refs/cues MUST join the asset block (`core/pack.py::_enforce_kit_assets`).
    expect(manifest.assets).toEqual([{ path: "assets/wantang.png" }, { path: "assets/tide.mp3" }])

    const plan = buildPackSourcePlan(withKit)
    expect(plan.files.map((file) => file.path)).toContain("ui/presentation.yaml")
    expect(plan.binaries).toContainEqual({ path: "assets/wantang.png", base64: "aGk=" })
    expect(plan.binaries).toContainEqual({ path: "assets/tide.mp3", base64: "bXA=" })
  })

  it("reproduces the flagship kit (汐浦送灯 ui/presentation.yaml) exactly", () => {
    // VENDORED from the engine repo's flagship module (tests never read
    // outside this repo) — the full-surface reference: subjects with and
    // without refs, bilingual style, banned list, three audio layers.
    const FLAGSHIP_YAML = `version: 2
generation: allow
style:
  keywords:
    zh: "水墨淡彩, 靛青与赭石, 一九二五年浙东渔镇, 湿冷海雾, 纸本质感"
    en: "ink wash with muted color, indigo and ochre, 1925 coastal Zhejiang fishing town, damp sea fog, paper grain"
  banned:
    - text overlays
    - modern clothing
    - photographic realism
    - visible light sources beyond lanterns
subjects:
  - id: gu-wantang
    kind: npc
    name: {zh: 顾晚棠, en: Gu Wantang}
    ref: assets/gu-wantang.png
    prompt: "a woman in her thirties, dark plain jacket over a pale collar, hair damp, standing very still"
  - id: bai-yusheng
    kind: npc
    name: {zh: 白榆生, en: Bai Yusheng}
    ref: assets/bai-yusheng.png
    prompt: "a slight young scholar in a worn long gown, ink-stained fingers, glasses fogged by sea air"
  - id: chen-jiuli
    kind: npc
    name: {zh: 陈九鲤, en: Chen Jiuli}
    ref: assets/chen-jiuli.png
    prompt: "a weathered boatman past fifty, oilskin cape, one hand always on a mooring rope"
  - id: shipu
    kind: location
    name: {zh: 石埠, en: The stone quay}
  - id: zhu-deng
    kind: item
    name: {zh: 主灯, en: The head lantern}
audio:
  - {id: chao-yong, layer: bgm, asset: assets/chao-yong.mp3, title: 潮涌}
  - {id: ye-wu, layer: ambience, asset: assets/ye-wu.mp3, title: 夜雾港湾}
  - {id: jing-xian, layer: sfx, asset: assets/jing-xian.mp3, title: 惊弦}
`
    const npc = (uid: string, id: string, zh: string, en: string, prompt: string) => ({
      uid,
      id,
      kind: "npc",
      nameEn: en,
      nameZh: zh,
      refFileName: `${id}.png`,
      refBase64: "cG5n",
      prompt,
    })
    const flagship = presentationDraft({
      keywordsZh: "水墨淡彩, 靛青与赭石, 一九二五年浙东渔镇, 湿冷海雾, 纸本质感",
      keywordsEn:
        "ink wash with muted color, indigo and ochre, 1925 coastal Zhejiang fishing town, damp sea fog, paper grain",
      bannedText:
        "text overlays\nmodern clothing\nphotographic realism\nvisible light sources beyond lanterns",
      subjects: [
        npc(
          "s1",
          "gu-wantang",
          "顾晚棠",
          "Gu Wantang",
          "a woman in her thirties, dark plain jacket over a pale collar, hair damp, standing very still",
        ),
        npc(
          "s2",
          "bai-yusheng",
          "白榆生",
          "Bai Yusheng",
          "a slight young scholar in a worn long gown, ink-stained fingers, glasses fogged by sea air",
        ),
        npc(
          "s3",
          "chen-jiuli",
          "陈九鲤",
          "Chen Jiuli",
          "a weathered boatman past fifty, oilskin cape, one hand always on a mooring rope",
        ),
        {
          uid: "s4",
          id: "shipu",
          kind: "location",
          nameEn: "The stone quay",
          nameZh: "石埠",
          refFileName: "",
          refBase64: "",
          prompt: "",
        },
        {
          uid: "s5",
          id: "zhu-deng",
          kind: "item",
          nameEn: "The head lantern",
          nameZh: "主灯",
          refFileName: "",
          refBase64: "",
          prompt: "",
        },
      ],
      audio: [
        {
          uid: "a1",
          id: "chao-yong",
          layer: "bgm",
          assetFileName: "chao-yong.mp3",
          assetBase64: "bXAz",
          title: "潮涌",
        },
        {
          uid: "a2",
          id: "ye-wu",
          layer: "ambience",
          assetFileName: "ye-wu.mp3",
          assetBase64: "bXAz",
          title: "夜雾港湾",
        },
        {
          uid: "a3",
          id: "jing-xian",
          layer: "sfx",
          assetFileName: "jing-xian.mp3",
          assetBase64: "bXAz",
          title: "惊弦",
        },
      ],
    })
    // Emission is faithful: the wizard's kit round-trips to the flagship's own file.
    expect(parse(buildPresentationYaml(flagship))).toEqual(parse(FLAGSHIP_YAML))
    // …and the flagship passes the author-side validator with zero issues.
    expect(validatePackDraft(draft({ presentation: flagship }))).toEqual([])
  })

  it("omits empty optional sections; keeps version + generation explicit", () => {
    const bare = presentationDraft({
      keywordsEn: "",
      keywordsZh: "",
      bannedText: "",
      subjects: [],
      audio: [],
      generation: "pack_only",
    })
    expect(parse(buildPresentationYaml(bare))).toEqual({ version: 2, generation: "pack_only" })
    const zhOnly = presentationDraft({ keywordsEn: "", subjects: [], audio: [] })
    expect(parse(buildPresentationYaml(zhOnly))).toEqual({
      version: 2,
      generation: "allow",
      style: { keywords: { zh: "水墨, 靛青" }, banned: ["text overlays", "modern clothing"] },
    })
  })

  it("emits the v2 additions: the templates allowlist and style.palette", () => {
    const kit = presentationDraft({
      templates: ["title_card", "letter"],
      paletteText: "#16232e\n  wet slate blue  \n\nlantern amber\n",
      subjects: [],
      audio: [],
    })
    const emitted = parse(buildPresentationYaml(kit)) as {
      version: number
      templates: string[]
      style: { palette: string[] }
    }
    expect(emitted.version).toBe(2)
    expect(emitted.templates).toEqual(["title_card", "letter"])
    expect(emitted.style.palette).toEqual(["#16232e", "wet slate blue", "lantern amber"])
    expect(validatePackDraft(draft({ presentation: kit }))).toEqual([])
  })

  it("omits an empty templates list rather than listing every shape", () => {
    // `core/presentation.py::allows_template`: empty = all allowed. Writing
    // all five would be an allowlist the author never chose — and would then
    // silently exclude any shape a later engine version adds.
    const emitted = parse(buildPresentationYaml(presentationDraft({ templates: [] }))) as Record<
      string,
      unknown
    >
    expect(emitted).not.toHaveProperty("templates")
  })

  it("mirrors the engine's v2 template and palette rules", () => {
    const issues = validatePackDraft(
      draft({
        presentation: presentationDraft({
          templates: ["title_card", "hologram", "title_card"],
          paletteText: `${"x".repeat(81)}\n${Array.from({ length: 8 }, (_, i) => `c${i}`).join("\n")}`,
        }),
      }),
    )
    const keys = issues.map((issue) => issue.key)
    expect(keys).toContain("packPresentationTemplateKind")
    expect(keys).toContain("packPresentationTemplateDuplicate")
    expect(keys).toContain("packPresentationPaletteCount")
    expect(keys).toContain("packPresentationPaletteTooLong")
  })

  it("mirrors the engine's subject rules (slug, kind enum, name, caps, ref pairing)", () => {
    const kit = presentationDraft()
    const issues = validatePackDraft(
      draft({
        presentation: presentationDraft({
          subjects: [
            {
              ...kit.subjects[0],
              id: "Gu Wantang",
              kind: "scene",
              nameEn: "",
              nameZh: "",
              prompt: "x".repeat(1001),
            },
            { ...kit.subjects[0], uid: "s2", id: "ok-id", refFileName: "a/b.png" },
            { ...kit.subjects[0], uid: "s3", id: "ok-id-2", refFileName: "x.png", refBase64: "" },
          ],
        }),
      }),
    )
    const byField = (uid: string, field: string) =>
      issues.filter((issue) => issue.params?.uid === uid && issue.params?.field === field)
    expect(String(byField("s1", "id")[0].params?.detail)).toContain("lowercase slug")
    expect(String(byField("s1", "kind")[0].params?.detail)).toContain("npc, location, item")
    expect(String(byField("s1", "nameEn")[0].params?.detail)).toContain("at least one of en, zh")
    expect(String(byField("s1", "prompt")[0].params?.detail)).toContain("1000")
    expect(String(byField("s2", "refFileName")[0].params?.detail)).toContain("plain file name")
    expect(String(byField("s3", "ref")[0].params?.detail)).toContain("incomplete")
    // Over-long localized names flag the specific locale field.
    const longName = validatePackDraft(
      draft({
        presentation: presentationDraft({
          subjects: [{ ...kit.subjects[0], nameEn: "x".repeat(401) }],
        }),
      }),
    )
    expect(longName.some((issue) => issue.params?.field === "nameEn")).toBe(true)
  })

  it("flags duplicate ids and the subjects/audio count caps", () => {
    const kit = presentationDraft()
    const dupes = validatePackDraft(
      draft({
        presentation: presentationDraft({
          subjects: [
            { ...kit.subjects[0], uid: "s1", id: "same" },
            { ...kit.subjects[0], uid: "s2", id: "same" },
          ],
          audio: [
            { ...kit.audio[0], uid: "a1", id: "same-cue" },
            { ...kit.audio[0], uid: "a2", id: "same-cue" },
          ],
        }),
      }),
    )
    expect(dupes.map((issue) => issue.key)).toContain("packPresentationDuplicateSubject")
    expect(dupes.map((issue) => issue.key)).toContain("packPresentationDuplicateCue")

    const many = validatePackDraft(
      draft({
        presentation: presentationDraft({
          subjects: Array.from({ length: 65 }, (_, i) => ({
            ...kit.subjects[0],
            uid: `s${i}`,
            id: `sub-${i}`,
          })),
          audio: Array.from({ length: 33 }, (_, i) => ({ ...kit.audio[0], uid: `a${i}`, id: `cue-${i}` })),
        }),
      }),
    )
    const keys = many.map((issue) => issue.key)
    expect(keys).toContain("packPresentationSubjectsCount")
    expect(keys).toContain("packPresentationAudioCount")
  })

  it("mirrors the style + generation rules (keywords/banned caps, mode enum)", () => {
    const issues = validatePackDraft(
      draft({
        presentation: presentationDraft({
          generation: "sometimes",
          keywordsEn: "x".repeat(401),
          bannedText: `${"x".repeat(401)}\n${Array.from({ length: 25 }, (_, i) => `b${i}`).join("\n")}`,
        }),
      }),
    )
    const keys = issues.map((issue) => issue.key)
    expect(keys).toContain("packPresentationGeneration")
    expect(keys).toContain("packPresentationKeywordsTooLong")
    expect(keys).toContain("packPresentationBannedCount")
    expect(keys).toContain("packPresentationBannedTooLong")
  })

  it("mirrors the audio cue rules (layer enum, required asset, title cap)", () => {
    const kit = presentationDraft()
    const issues = validatePackDraft(
      draft({
        presentation: presentationDraft({
          audio: [
            { ...kit.audio[0], layer: "score", assetFileName: "", assetBase64: "", title: "x".repeat(401) },
          ],
        }),
      }),
    )
    const byField = (field: string) => issues.filter((issue) => issue.params?.field === field)
    expect(String(byField("layer")[0].params?.detail)).toContain("bgm, ambience, sfx")
    expect(String(byField("asset")[0].params?.detail)).toContain("needs its audio file")
    expect(String(byField("title")[0].params?.detail)).toContain("400")
  })

  it("flags kit files colliding with other pack paths, tagged for the presentation step", () => {
    const issues = validatePackDraft(
      draft({
        assets: [{ fileName: "wantang.png", base64: "aGk=" }],
        presentation: presentationDraft(),
      }),
    )
    const collision = issues.find((issue) => issue.key === "packDuplicatePath")
    expect(collision?.params?.file).toBe("assets/wantang.png")
    expect(collision?.params?.from).toBe("presentation")
  })
})
