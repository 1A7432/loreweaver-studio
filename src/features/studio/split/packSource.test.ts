import { parse } from "yaml"
import { describe, expect, it } from "vitest"
import {
  buildManifestYaml,
  buildPackSourcePlan,
  buildPresentationYaml,
  buildSkillMd,
  moduleIdMentioned,
  safeFileName,
  validatePackDraft,
  type PackPresentationDraft,
  type WorldPackDraft,
} from "./packSource"

// Unit tests assert on the TEXT Studio writes. That the engine accepts it is proven by the
// round-trip gate (`scripts/check_roundtrip.sh`), which builds and installs a pack written by
// this same `buildPackSourcePlan` with the real 3.0 engine.

const PNG = "iVBORw0KGgo="

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
        kind: "world",
        notesEn: "Run `.var expose 理` after import.",
        notesZh: "导入后运行 `.var expose 理`。",
      },
    ],
    skills: [],
    rulepacks: [],
    modules: [],
    assets: [],
    episodes: [],
    panels: null,
    presentation: null,
    ...overrides,
  }
}

const MODULE_SOURCE = `import { defineModule } from "loreweaver/module";
export default defineModule({ id: "tide", views: { level: { schema: { type: "integer" }, for: () => 1 } } });
`

const PANELS_YAML = `panels:
  - id: hud
    title: {en: HUD, zh: 状态板}
    slot: sidebar
    views: {me: me, tide: tide/level}
    blocks:
      - {kind: meter, label: {en: Tide, zh: 潮位}, value: {$view: tide}, min: 0, max: 10}
      - {kind: image, src: ui/map.png}
      - repeat:
          each: me.character.resources
          block: {kind: stat, label: {$view: item.label}, value: {$view: item.value}}
  - id: case-board
    title: {en: Case Board, zh: 案情板}
    slot: modal
    audience: admin
    views: {tide: tide/level}
    entry: ui/case-board.html
    fallback:
      - {kind: text, text: {$view: tide}, visible_when: "tide > 3"}
`

function panelsDraft(yaml = PANELS_YAML) {
  return {
    yamlText: yaml,
    files: [
      { path: "ui/map.png", base64: PNG },
      { path: "ui/case-board.html", contents: "<!doctype html><main></main>" },
    ],
  }
}

function keys(value: WorldPackDraft): string[] {
  return validatePackDraft(value).map((issue) => issue.key)
}

describe("validatePackDraft", () => {
  it("passes a well-formed draft", () => {
    expect(validatePackDraft(draft())).toEqual([])
  })

  it("enforces slug / semver / required metadata", () => {
    const issues = keys(
      draft({ id: "Bad Id", version: "1.0", nameEn: "", nameZh: "", license: " ", authors: [" "] }),
    )
    expect(issues).toEqual(
      expect.arrayContaining([
        "packIdInvalid",
        "packVersionInvalid",
        "packNameRequired",
        "packLicenseRequired",
        "packAuthorsRequired",
      ]),
    )
  })

  it("holds skill ids, rule-system ids and card file names to the engine's rules", () => {
    expect(
      keys(draft({ skills: [{ slug: "ends-", nameEn: "", descriptionEn: "", descriptionZh: "" }] })),
    ).toContain("packSkillSlugInvalid")
    expect(keys(draft({ rulepacks: [{ id: "Bad_Rules", yamlText: "extends: coc7" }] }))).toContain(
      "packRulepackIdInvalid",
    )
    expect(
      keys(
        draft({
          cards: [{ fileName: "notes.txt", jsonText: "{}", kind: "character", notesEn: "", notesZh: "" }],
        }),
      ),
    ).toContain("packCardFileName")
  })

  it("refuses a rule pack that names a rules script: 3.0 has no rules-script lane", () => {
    const yamlText = "names: [x]\nresolution:\n  roll: 1d20\n  script: grade.js\n"
    expect(keys(draft({ rulepacks: [{ id: "scripted", yamlText }] }))).toContain("packRulepackScript")
  })

  it("refuses an asset that is neither a picture nor a sound", () => {
    expect(keys(draft({ assets: [{ fileName: "notes.json", base64: "e30=" }] }))).toContain("packAssetType")
    expect(keys(draft({ assets: [{ fileName: "bell.ogg", base64: "T2dnUw==" }] }))).not.toContain(
      "packAssetType",
    )
  })

  it("finds two names that are one file on a case-insensitive filesystem", () => {
    const issues = validatePackDraft(
      draft({
        assets: [
          { fileName: "Map.png", base64: PNG },
          { fileName: "map.png", base64: PNG },
        ],
      }),
    )
    expect(issues.map((issue) => issue.key)).toContain("packDuplicatePath")
  })
})

describe("buildManifestYaml", () => {
  it("writes manifest 3: the version, the engine minimum and `kind` on every card", () => {
    const manifest = parse(buildManifestYaml(draft())) as Record<string, unknown>
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.engine).toEqual({ protocol: "3.0" })
    expect(manifest.name).toEqual({ en: "Deep Pier", zh: "深渊码头" })
    expect(manifest.contents).toEqual({
      cards: [
        {
          path: "cards/deep-pier.st.json",
          kind: "world",
          notes: { en: "Run `.var expose 理` after import.", zh: "导入后运行 `.var expose 理`。" },
        },
      ],
    })
    // Nothing a 2.x builder generated, and no kind 3.0 refuses.
    for (const key of ["trust", "files", "lorebooks", "presets", "prep"]) {
      expect(manifest).not.toHaveProperty(key)
      expect(manifest.contents).not.toHaveProperty(key)
    }
  })

  it("writes a card with no notes as {path, kind}", () => {
    const manifest = parse(
      buildManifestYaml(
        draft({
          cards: [{ fileName: "hana.png", base64: PNG, kind: "character", notesEn: "", notesZh: "" }],
        }),
      ),
    ) as { contents: { cards: unknown } }
    expect(manifest.contents.cards).toEqual([{ path: "cards/hana.png", kind: "character" }])
  })

  it("declares each module by id with its source entry under src/", () => {
    const withModule = draft({
      modules: [{ uid: "m", id: "tide", fileName: "tide.ts", source: MODULE_SOURCE }],
    })
    expect(validatePackDraft(withModule)).toEqual([])
    const manifest = parse(buildManifestYaml(withModule)) as { modules: unknown }
    expect(manifest.modules).toEqual([{ id: "tide", entry: "src/tide.ts" }])
  })

  it("leaves out an empty contents block", () => {
    const manifest = parse(buildManifestYaml(draft({ cards: [] }))) as Record<string, unknown>
    expect(manifest).not.toHaveProperty("contents")
  })
})

describe("modules", () => {
  function moduleKeys(module: { id: string; fileName: string; source: string }): string[] {
    return keys(draft({ modules: [{ uid: "m", ...module }] }))
  }

  it("holds the id, the entry file and the source to the engine's rules", () => {
    expect(moduleKeys({ id: "Tide", fileName: "tide.ts", source: MODULE_SOURCE })).toContain(
      "packModuleIdInvalid",
    )
    expect(moduleKeys({ id: "tide", fileName: "tide.py", source: MODULE_SOURCE })).toContain(
      "packModuleFileName",
    )
    expect(moduleKeys({ id: "tide", fileName: "lib/tide.ts", source: MODULE_SOURCE })).toContain(
      "packModuleFileName",
    )
    expect(moduleKeys({ id: "tide", fileName: "tide.ts", source: "  " })).toContain("packModuleEmpty")
    expect(moduleKeys({ id: "tide", fileName: "tide.mjs", source: MODULE_SOURCE })).toEqual([])
  })

  it("refuses two modules of one id, and more than sixteen", () => {
    const twice = draft({
      modules: [
        { uid: "a", id: "tide", fileName: "a.ts", source: MODULE_SOURCE },
        { uid: "b", id: "tide", fileName: "b.ts", source: MODULE_SOURCE },
      ],
    })
    expect(keys(twice)).toContain("packModuleIdDuplicate")
    const many = draft({
      modules: Array.from({ length: 17 }, (_, index) => ({
        uid: `m${index}`,
        id: `m${index}`,
        fileName: `m${index}.ts`,
        source: MODULE_SOURCE,
      })),
    })
    expect(keys(many)).toContain("packModulesTooMany")
  })

  it("writes the source under src/, newline-terminated", () => {
    const plan = buildPackSourcePlan(
      draft({ modules: [{ uid: "m", id: "tide", fileName: "tide.ts", source: "export default 1" }] }),
    )
    expect(plan.files).toContainEqual({ path: "src/tide.ts", contents: "export default 1\n" })
  })

  it("notices a source that does not pass its id to defineModule", () => {
    expect(moduleIdMentioned(MODULE_SOURCE, "tide")).toBe(true)
    expect(moduleIdMentioned(MODULE_SOURCE, "clock")).toBe(false)
    expect(moduleIdMentioned("defineModule({ id: 'clock' })", "clock")).toBe(true)
    // An id the author is still typing is never a regex error.
    expect(moduleIdMentioned(MODULE_SOURCE, "(")).toBe(false)
  })
})

describe("buildSkillMd / buildPackSourcePlan", () => {
  it("emits SKILL.md front matter the engine's skill reader takes", () => {
    const text = buildSkillMd({
      slug: "harbor",
      nameEn: "Harbor",
      descriptionEn: "Run the harbor.",
      descriptionZh: "",
    })
    expect(text.startsWith("---\n")).toBe(true)
    const front = parse(text.split("---\n")[1]) as Record<string, unknown>
    expect(front).toEqual({ name: "Harbor", description: "Run the harbor.", metadata: { scope: "room" } })
  })

  it("ships a hand-written SKILL.md verbatim and flags one without front matter", () => {
    const custom = "---\nname: X\ndescription: y\n---\n\nBody"
    expect(
      buildSkillMd({ slug: "x", nameEn: "", descriptionEn: "", descriptionZh: "", skillMd: custom }),
    ).toBe(`${custom}\n`)
    expect(
      keys(
        draft({
          skills: [{ slug: "x", nameEn: "", descriptionEn: "", descriptionZh: "", skillMd: "Body only" }],
        }),
      ),
    ).toContain("packSkillMdNoFrontmatter")
  })

  it("lays out the tree: one SKILL.md per skill and nothing beside it", () => {
    const plan = buildPackSourcePlan(
      draft({
        skills: [{ slug: "harbor", nameEn: "Harbor", descriptionEn: "d", descriptionZh: "" }],
        rulepacks: [{ id: "harbor-rules", yamlText: "extends: coc7\n" }],
      }),
    )
    const paths = plan.files.map((file) => file.path)
    expect(paths).toEqual([
      "pack.yaml",
      "cards/deep-pier.st.json",
      "skills/harbor/SKILL.md",
      "rulepacks/harbor-rules.yaml",
    ])
    expect(paths.some((path) => path.endsWith("hooks.js"))).toBe(false)
  })

  it("routes PNG cards and assets through the binary list", () => {
    const plan = buildPackSourcePlan(
      draft({
        cards: [{ fileName: "hana.png", base64: PNG, kind: "character", notesEn: "", notesZh: "" }],
        assets: [{ fileName: "cover.png", base64: PNG }],
      }),
    )
    expect(plan.binaries).toEqual([
      { path: "cards/hana.png", base64: PNG },
      { path: "assets/cover.png", base64: PNG },
    ])
    const manifest = parse(plan.files[0].contents) as { assets: unknown }
    expect(manifest.assets).toEqual([{ path: "assets/cover.png" }])
  })
})

describe("panels 3.0", () => {
  it("accepts views, bindings, a repeat, a page with a fallback, and plans ui/ into the tree", () => {
    const withPanels = draft({ panels: panelsDraft() })
    expect(validatePackDraft(withPanels)).toEqual([])
    const plan = buildPackSourcePlan(withPanels)
    expect(plan.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["ui/panels.yaml", "ui/case-board.html"]),
    )
    expect(plan.binaries).toContainEqual({ path: "ui/map.png", base64: PNG })
    const manifest = parse(plan.files[0].contents) as { contents: Record<string, unknown> }
    expect(manifest.contents.panels).toEqual(["ui/panels.yaml"])
  })

  it("omits contents.panels when the pack ships none", () => {
    const manifest = parse(buildManifestYaml(draft())) as { contents: Record<string, unknown> }
    expect(manifest.contents.panels).toBeUndefined()
  })

  it("reports the engine's own problem codes, at the engine's paths", () => {
    const yaml = `panels:
  - id: hud
    title: HUD
    slot: sidebar
    views: {me: me, vars: variables}
    blocks:
      - {kind: stat, label: Name, value: {$view: you.name}}
`
    const issues = validatePackDraft(draft({ panels: { yamlText: yaml, files: [] } }))
    const panel = issues.filter((issue) => issue.key === "packPanelInvalid").map((issue) => issue.params)
    expect(panel).toContainEqual({
      code: "unknown_handle",
      at: "panels.0.blocks.0.value.$view",
      detail: "you",
    })
  })

  it("flags a 1.x field the migration left (the engine refuses it as replaced_2x)", () => {
    const yaml = `panels:
  - id: hud
    title: HUD
    slot: sidebar
    audience: keeper
    blocks:
      - {kind: meter, label: Fear, value: {$var: fear.level}, min: 0, max: 10}
`
    const codes = validatePackDraft(draft({ panels: { yamlText: yaml, files: [] } }))
      .filter((issue) => issue.key === "packPanelInvalid")
      .map((issue) => issue.params?.code)
    expect(codes).toEqual(["replaced_2x", "replaced_2x"])
  })

  it("names a page or picture the pack does not ship, and a file no panel names", () => {
    const issues = validatePackDraft(
      draft({ panels: { yamlText: PANELS_YAML, files: [{ path: "ui/old.png", base64: PNG }] } }),
    )
    const missing = issues
      .filter((issue) => issue.key === "packPanelMissingFile")
      .map((issue) => issue.params?.file)
    expect(missing).toEqual(expect.arrayContaining(["ui/map.png", "ui/case-board.html"]))
    expect(issues.map((issue) => issue.key)).toContain("packPanelFileOrphan")
  })

  it("lets a panel picture be a dropped asset, not only a panel file", () => {
    const yaml = PANELS_YAML.replace("src: ui/map.png", "src: assets/map.png")
    const issues = validatePackDraft(
      draft({
        assets: [{ fileName: "map.png", base64: PNG }],
        panels: { yamlText: yaml, files: [{ path: "ui/case-board.html", contents: "<main></main>" }] },
      }),
    )
    expect(issues).toEqual([])
  })

  it("refuses a script beside a page: a page is one self-contained HTML file", () => {
    const issues = validatePackDraft(
      draft({
        panels: { ...panelsDraft(), files: [...panelsDraft().files, { path: "ui/app.js", contents: "1" }] },
      }),
    )
    expect(issues.map((issue) => issue.key)).toContain("packPanelScriptFile")
  })
})

describe("safeFileName", () => {
  it("keeps unicode letters and falls back when nothing survives", () => {
    expect(safeFileName("深渊 码头!", "x")).toBe("深渊_码头")
    expect(safeFileName("!!!", "fallback")).toBe("fallback")
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

  it("emits the exact kit shape the engine's kit reader parses, wired into manifest + plan", () => {
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
    // Listed for a readable manifest (the builder takes them along listed or not).
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
    // The engine reads an empty allowlist as all shapes allowed. Writing
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

describe("serialized modules (连载模组)", () => {
  const EPISODES = [
    { id: "ep1", ordinal: 1, title: "雨夜", summary: "第一夜。", releaseNotes: "首次发布。" },
    { id: "ep2", ordinal: 2, title: "第五层", summary: "楼梯尽头。", releaseNotes: "新增第五层。" },
  ]

  function serialized(buildUpTo: number): WorldPackDraft {
    return draft({
      episodes: EPISODES,
      buildUpTo,
      cards: [
        {
          fileName: "keeper.lorecard.json",
          jsonText: JSON.stringify({
            format: "loreweaver.card",
            worldbook: [
              { title: "雨夜的规则", content: "雨夜才有第五层。" },
              { title: "第五层的住户", content: "他早已不是人类。", episode: "ep2" },
            ],
          }),
          kind: "world",
          notesEn: "",
          notesZh: "",
        },
        {
          fileName: "later.json",
          jsonText: "{}",
          kind: "character",
          notesEn: "",
          notesZh: "",
          episode: "ep2",
        },
      ],
      assets: [
        { fileName: "cover.png", base64: PNG },
        { fileName: "stairwell.png", base64: PNG, episode: "ep2" },
      ],
    })
  }

  it("leaves every future-episode file out of the source tree AND the manifest", () => {
    // The file circulating at episode 1 contains nothing of episode 2.
    const plan = buildPackSourcePlan(serialized(1))
    const paths = [...plan.files.map((f) => f.path), ...plan.binaries.map((b) => b.path)]
    expect(paths).toContain("cards/keeper.lorecard.json")
    expect(paths).toContain("assets/cover.png")
    expect(paths).not.toContain("cards/later.json")
    expect(paths).not.toContain("assets/stairwell.png")
    const manifest = parse(plan.files[0].contents) as {
      contents: Record<string, unknown>
      assets: { path: string }[]
    }
    expect(manifest.contents.cards).toEqual([{ path: "cards/keeper.lorecard.json", kind: "world" }])
    expect(manifest.assets).toEqual([{ path: "assets/cover.png" }])
  })

  it("leaves a future-episode ENTRY out of a card that does ship", () => {
    const plan = buildPackSourcePlan(serialized(1))
    const card = plan.files.find((file) => file.path === "cards/keeper.lorecard.json")!
    expect(card.contents).toContain("雨夜才有第五层")
    expect(card.contents).not.toContain("他早已不是人类")
    expect(card.contents).not.toContain("episode")
  })

  it("ships everything once the horizon reaches it", () => {
    const plan = buildPackSourcePlan(serialized(2))
    const paths = [...plan.files.map((f) => f.path), ...plan.binaries.map((b) => b.path)]
    expect(paths).toContain("cards/later.json")
    expect(paths).toContain("assets/stairwell.png")
    const card = plan.files.find((file) => file.path === "cards/keeper.lorecard.json")!
    expect(card.contents).toContain("他早已不是人类")
  })

  it("writes CHANGELOG.md (never named by the manifest) from the release-notes chain of this build only", () => {
    const plan = buildPackSourcePlan(serialized(1))
    const changelog = plan.files.find((file) => file.path === "CHANGELOG.md")
    expect(changelog?.contents).toContain("首次发布。")
    expect(changelog?.contents).not.toContain("新增第五层。")
    expect(plan.files[0].contents).not.toContain("CHANGELOG")
  })

  it("writes no CHANGELOG.md for an ordinary one-shot pack", () => {
    const plan = buildPackSourcePlan(draft())
    expect(plan.files.map((file) => file.path)).not.toContain("CHANGELOG.md")
  })
})
