import { beforeEach, describe, expect, it } from "vitest"
import {
  buildDraftFromState,
  classifyJson,
  initvarLeaves,
  migratePackSession,
  packExposeLines,
  packValidationIssues,
  usePackStore,
} from "./pack"

const encoder = new TextEncoder()

function heavyCardJson(): string {
  return JSON.stringify({
    spec: "chara_card_v3",
    spec_version: "3.0",
    data: {
      name: "深渊之主",
      description: "harbor <%= getvar('mood') %>",
      creator_notes: "by someone",
      extensions: { loreweaver_hooks: ["on('turn_start', () => {})"] },
      character_book: {
        entries: [
          { comment: "[InitVar]", content: '{"理": {"好感度": [10, "0..100"]}, "secret_flag": true}' },
          { comment: "Pier", content: "plain lore" },
        ],
      },
    },
  })
}

function file(name: string, contents: string) {
  return { name, bytes: encoder.encode(contents), path: null }
}

function reset() {
  usePackStore.getState().reset()
}

describe("classifyJson", () => {
  it("tells cards, lorebooks and other JSON apart deterministically", () => {
    expect(classifyJson(JSON.parse(heavyCardJson()))).toBe("card")
    expect(classifyJson({ name: "X", description: "d" })).toBe("card")
    expect(classifyJson({ entries: [{ content: "a" }] })).toBe("lorebook")
    expect(classifyJson({ character_book: { entries: [] } })).toBe("lorebook")
    // A stock ST world-info export carries name+description NEXT TO entries;
    // the root-level entries collection must beat the loose card heuristic.
    expect(classifyJson({ name: "Atlas", description: "city color", entries: [{ content: "a" }] })).toBe(
      "lorebook",
    )
    expect(classifyJson({ something: 1 })).toBe("asset")
    expect(classifyJson([1])).toBe("asset")
  })
})

describe("initvarLeaves", () => {
  it("strips decorators, merges multiple entries without overwriting", () => {
    const { leaves } = initvarLeaves([
      { content: '@@initial_variables\n{"a": 1, "n": {"x": 1}}' },
      { content: '{"a": 999, "b": 2, "n": {"y": 2}}' },
    ])
    // Insertion order: `n` was created by the first entry, so its subtree
    // (including the merged-in y) flattens before the second entry's new `b`.
    expect(leaves).toEqual([
      { path: "a", value: 1, description: "" },
      { path: "n.x", value: 1, description: "" },
      { path: "n.y", value: 2, description: "" },
      { path: "b", value: 2, description: "" },
    ])
  })
})

const METADATA = {
  id: "deep-pier",
  version: "0.1.0",
  nameEn: "Deep Pier",
  nameZh: "深渊码头",
  descriptionEn: "d",
  descriptionZh: "描述",
  authors: "someone",
  license: "MIT",
  rulepackPatch: "",
  rulepackId: "",
  rulepackMode: "patch" as const,
}

describe("pack store pipeline", () => {
  beforeEach(reset)

  it("classifies dropped files and pins the world kind on machinery", async () => {
    const store = usePackStore.getState()
    await store.addFiles([file("Heavy Card.json", heavyCardJson()), file("notes.txt", "hello")])
    const items = usePackStore.getState().items
    expect(items.map((item) => item.kind)).toEqual(["card", "asset"])

    const card = items[0]
    expect(card.cardKind).toBe("world")
    expect(card.payloads).toEqual({ hooks: 1, initvarEntries: 1, ejsBlocks: 1, secretEntries: 0 })
    // The hook script is kept for display (it makes the card a world card; 3.0 never runs it).
    expect(card.hooks).toEqual(["on('turn_start', () => {})"])
    expect(card.drafts.length).toBe(2)

    // The kind is what the card IS, whatever an edit says.
    usePackStore.getState().updateItem(card.uid, { cardKind: "character" })
    expect(usePackStore.getState().items[0].cardKind).toBe("world")
  })

  it("leaves a dropped lorebook out and says why: 3.0 packs carry lore inside a world card", async () => {
    await usePackStore
      .getState()
      .addFiles([
        file("world book.json", JSON.stringify({ entries: [{ content: "lore" }] })),
        file("npc.json", "{}"),
      ])
    const state = usePackStore.getState()
    expect(state.items.map((item) => item.sourceName)).toEqual(["npc.json"])
    expect(state.loadError).toEqual({ key: "pack.lorebookRefused", params: { file: "world book.json" } })
  })

  it("pins a clean card to character in both directions", async () => {
    await usePackStore
      .getState()
      .addFiles([file("npc.json", JSON.stringify({ spec: "chara_card_v2", data: { name: "NPC" } }))])
    const card = usePackStore.getState().items[0]
    expect(card.cardKind).toBe("character")
    usePackStore.getState().updateItem(card.uid, { cardKind: "world" })
    expect(usePackStore.getState().items[0].cardKind).toBe("character")
  })

  it("folds a native bundle's typed variables into the world detection", async () => {
    // A specs-only lorecard: the engine counts typed variables as world machinery.
    const bundle = {
      format: "loreweaver.card",
      format_version: 1,
      name: "林晚",
      description: "a plain persona with trackers",
      opening: "雨夜。",
      variables: [
        { id: "heat", kind: "number", minimum: 0, maximum: 10, default: 1 },
        { id: "mood", kind: "enum", options: ["calm", "tense"] },
        { id: "heat", kind: "number" }, // duplicate id — the engine skips it
      ],
      worldbook: [{ title: "Pier", content: "plain lore" }],
    }
    await usePackStore.getState().addFiles([file("lin-wan.lorecard.json", JSON.stringify(bundle))])
    const card = usePackStore.getState().items[0]
    expect(card.kind).toBe("card")
    expect(card.cardKind).toBe("world")
    expect(card.payloads).toEqual({ hooks: 0, initvarEntries: 2, ejsBlocks: 0, secretEntries: 0 })
  })

  it("keeps a native bundle without any machinery a character card", async () => {
    const bundle = {
      format: "loreweaver.card",
      format_version: 1,
      name: "阿白",
      description: "no trackers at all",
      worldbook: [{ title: "Pier", content: "plain lore" }],
    }
    await usePackStore.getState().addFiles([file("a-bai.lorecard.json", JSON.stringify(bundle))])
    expect(usePackStore.getState().items[0].cardKind).toBe("character")
  })

  it("builds a draft whose cards carry their detected kind and their original text", async () => {
    await usePackStore.getState().addFiles([file("heavy.json", heavyCardJson())])
    const card = usePackStore.getState().items[0]
    usePackStore.getState().updateItem(card.uid, { notesZh: "备注", notesEn: "note" })
    const draft = buildDraftFromState({ items: usePackStore.getState().items, metadata: METADATA })
    expect(draft.cards).toHaveLength(1)
    expect(draft.cards[0].kind).toBe("world")
    // The card ships as dropped: its hooks are counted by the engine, never run.
    expect(draft.cards[0].jsonText).toBe(heavyCardJson())
    expect(draft.skills).toEqual([])
  })

  it("suggests expose lines only for player-guessed prefixes of world cards", async () => {
    await usePackStore.getState().addFiles([file("heavy.json", heavyCardJson())])
    expect(packExposeLines(usePackStore.getState().items)).toEqual([".var expose 理"])
  })

  it("carries asset items into the draft instead of dropping them silently", async () => {
    await usePackStore.getState().addFiles([file("cover art.png", "not a png at all")])
    const items = usePackStore.getState().items
    expect(items[0].kind).toBe("asset")
    const draft = buildDraftFromState({ items, metadata: METADATA })
    expect(draft.assets).toEqual([{ fileName: items[0].fileName, base64: items[0].base64, episode: "" }])
  })

  it("names the rule pack after its id, or `<pack id>-rules`", () => {
    const named = buildDraftFromState({
      items: [],
      metadata: { ...METADATA, rulepackPatch: "extends: coc7\n", rulepackId: "pier" },
    })
    expect(named.rulepacks).toEqual([{ id: "pier", yamlText: "extends: coc7\n" }])
    const unnamed = buildDraftFromState({
      items: [],
      metadata: { ...METADATA, rulepackPatch: "extends: coc7\n" },
    })
    expect(unnamed.rulepacks[0].id).toBe("deep-pier-rules")
  })
})

describe("modules", () => {
  beforeEach(reset)

  it("adds a module with a starter source whose id is the module's", () => {
    usePackStore.getState().addModule()
    usePackStore.getState().addModule()
    const [first, second] = usePackStore.getState().modules
    expect(first.id).toBe("main")
    expect(first.fileName).toBe("main.ts")
    expect(first.source).toContain('id: "main"')
    expect(first.source).toContain('from "loreweaver/module"')
    expect(second.id).not.toBe(first.id)
  })

  it("edits and removes one, and the removal can be undone", () => {
    usePackStore.getState().addModule()
    const module = usePackStore.getState().modules[0]
    usePackStore.getState().updateModule(module.uid, { id: "tide", source: "export default 1" })
    expect(usePackStore.getState().modules[0]).toMatchObject({ id: "tide", source: "export default 1" })
    usePackStore.getState().removeModule(module.uid)
    expect(usePackStore.getState().modules).toEqual([])
  })

  it("flows into the draft, and its issues gate the build", () => {
    usePackStore.getState().addModule()
    const module = usePackStore.getState().modules[0]
    usePackStore.getState().updateModule(module.uid, { id: "Bad" })
    const input = { items: [], metadata: METADATA, modules: usePackStore.getState().modules }
    expect(buildDraftFromState(input).modules).toHaveLength(1)
    expect(packValidationIssues(input).map((issue) => issue.key)).toContain("packModuleIdInvalid")
  })
})

describe("presentation kit (M19) store actions", () => {
  beforeEach(reset)

  const metadata = {
    id: "stagekit",
    version: "0.1.0",
    nameEn: "Stage Kit",
    nameZh: "演出资料包",
    descriptionEn: "d",
    descriptionZh: "描述",
    authors: "tests",
    license: "MIT",
    rulepackPatch: "",
    rulepackId: "",
    rulepackMode: "patch" as const,
  }

  it("opts in explicitly (null by default), and addPresentation is idempotent", () => {
    expect(usePackStore.getState().presentation).toBeNull()
    usePackStore.getState().addPresentation()
    const kit = usePackStore.getState().presentation
    expect(kit).toEqual({
      generation: "allow",
      // Kit v2: an EMPTY allowlist means every performance shape is allowed,
      // so a fresh kit must not arrive with the boxes pre-ticked.
      templates: [],
      keywordsEn: "",
      keywordsZh: "",
      bannedText: "",
      paletteText: "",
      subjects: [],
      audio: [],
    })
    usePackStore.getState().updatePresentation({ generation: "pack_only" })
    usePackStore.getState().addPresentation()
    // A second add must NOT reset the author's veto.
    expect(usePackStore.getState().presentation?.generation).toBe("pack_only")
  })

  it("edits subjects: upload names the ref like an asset item, clear removes both halves", () => {
    usePackStore.getState().addPresentation()
    usePackStore.getState().addPresentationSubject()
    const subject = usePackStore.getState().presentation!.subjects[0]
    expect(subject.kind).toBe("npc")

    usePackStore.getState().updatePresentationSubject(subject.uid, { id: "gu-wantang", nameZh: "顾晚棠" })
    usePackStore.getState().setPresentationSubjectRef(subject.uid, {
      name: "Gu Wantang.PNG",
      bytes: encoder.encode("png-bytes"),
      path: null,
    })
    const withRef = usePackStore.getState().presentation!.subjects[0]
    expect(withRef.refFileName).toBe("Gu_Wantang.png")
    expect(withRef.refBase64).not.toBe("")

    usePackStore.getState().clearPresentationSubjectRef(subject.uid)
    const cleared = usePackStore.getState().presentation!.subjects[0]
    expect(cleared.refFileName).toBe("")
    expect(cleared.refBase64).toBe("")

    usePackStore.getState().removePresentationSubject(subject.uid)
    expect(usePackStore.getState().presentation!.subjects).toEqual([])
  })

  it("edits audio cues: asset upload/remove and per-cue updates", () => {
    usePackStore.getState().addPresentation()
    usePackStore.getState().addPresentationCue()
    const cue = usePackStore.getState().presentation!.audio[0]
    expect(cue.layer).toBe("bgm")

    usePackStore.getState().updatePresentationCue(cue.uid, { id: "chao-yong", title: "潮涌" })
    usePackStore.getState().setPresentationCueAsset(cue.uid, {
      name: "潮涌 Theme.MP3",
      bytes: encoder.encode("mp3-bytes"),
      path: null,
    })
    const withAsset = usePackStore.getState().presentation!.audio[0]
    expect(withAsset.assetFileName).toBe("潮涌_Theme.mp3")

    usePackStore.getState().clearPresentationCueAsset(cue.uid)
    expect(usePackStore.getState().presentation!.audio[0].assetBase64).toBe("")
    usePackStore.getState().removePresentationCue(cue.uid)
    expect(usePackStore.getState().presentation!.audio).toEqual([])
  })

  it("carries the kit into the draft and its issues carry uid/field for inline display", () => {
    usePackStore.getState().addPresentation()
    usePackStore.getState().addPresentationSubject()
    const subject = usePackStore.getState().presentation!.subjects[0]
    usePackStore.getState().updatePresentationSubject(subject.uid, { id: "Bad ID" })

    const kit = usePackStore.getState().presentation!
    const draft = buildDraftFromState({ items: [], metadata, presentation: kit })
    expect(draft.presentation).toBe(kit)

    const issues = packValidationIssues({ items: [], metadata, presentation: kit })
    const idIssue = issues.find((issue) => issue.key === "packPresentationSubjectInvalid")
    expect(idIssue?.params?.uid).toBe(subject.uid)
    expect(idIssue?.params?.field).toBe("id")
    expect(idIssue?.params?.subject).toBe("Bad ID")
  })

  it("reset drops the kit", () => {
    usePackStore.getState().addPresentation()
    usePackStore.getState().reset()
    expect(usePackStore.getState().presentation).toBeNull()
  })
})

describe("pack session persistence", () => {
  beforeEach(reset)

  const metadata = {
    id: "corridor",
    version: "0.1.0",
    nameEn: "Corridor",
    nameZh: "走廊",
    descriptionEn: "d",
    descriptionZh: "描述",
    authors: "tests",
    license: "MIT",
    rulepackPatch: "",
    rulepackId: "",
    rulepackMode: "patch" as const,
  }

  /** What zustand's `persist` would write, without going through localStorage. */
  function persisted() {
    return usePackStore.persist.getOptions().partialize?.(usePackStore.getState()) as {
      items: { fileName: string; base64: string; needsBytes: boolean; jsonText: string | null }[]
      panels: { files: { path: string; base64?: string; contents?: string }[] } | null
      presentation: { subjects: { refBase64: string }[]; audio: { assetBase64: string }[] } | null
      metadata: { id: string }
      packResult: unknown
      runResult?: unknown
      candidates?: unknown
    }
  }

  it("keeps a JSON item's text but drops a binary item's bytes", async () => {
    await usePackStore
      .getState()
      .addFiles([file("heavy.json", heavyCardJson()), file("cover.png", "\x89PNG")])
    const written = persisted()
    const [card, cover] = written.items
    // The card's own text IS its bytes, so nothing is lost keeping it.
    expect(card.jsonText).toContain("深渊之主")
    expect(card.needsBytes).toBe(false)
    // The PNG's are megabytes of localStorage for something one click restores.
    expect(cover.base64).toBe("")
    expect(cover.needsBytes).toBe(true)
    // …and the name survives, so the author knows which file to hand back.
    expect(cover.fileName).toBe("cover.png")
  })

  it("blocks the build while an item is missing its bytes, and unblocks on re-attach", async () => {
    await usePackStore.getState().addFiles([file("cover.png", "\x89PNG")])
    const item = usePackStore.getState().items[0]
    usePackStore.getState().updateItem(item.uid, { needsBytes: true, base64: "" })

    const blocked = packValidationIssues({ items: usePackStore.getState().items, metadata })
    expect(blocked.map((issue) => issue.key)).toContain("packItemNeedsBytes")

    usePackStore
      .getState()
      .reattachItem(item.uid, { name: "cover.png", path: null, bytes: encoder.encode("\x89PNG") })
    const after = usePackStore.getState().items[0]
    expect(after.needsBytes).toBe(false)
    expect(after.base64).not.toBe("")
    expect(
      packValidationIssues({ items: usePackStore.getState().items, metadata }).map((issue) => issue.key),
    ).not.toContain("packItemNeedsBytes")
  })

  it("keeps panel TEXT files whole and drops only the binary ones", () => {
    usePackStore.getState().setPanelsYaml("panels: []")
    usePackStore
      .getState()
      .addPanelFiles([file("view.html", "<p>hi</p>"), file("map.png", "\x89PNG")], "board")
    const written = persisted()
    expect(written.panels?.files).toEqual([
      { path: "ui/board/view.html", contents: "<p>hi</p>" },
      { path: "ui/board/map.png" },
    ])
  })

  it("keeps the kit's structure and drops only its media bytes", () => {
    usePackStore.getState().addPresentation()
    usePackStore.getState().addPresentationSubject()
    const subject = usePackStore.getState().presentation!.subjects[0]
    usePackStore.getState().updatePresentationSubject(subject.uid, { id: "wen", nameZh: "温" })
    usePackStore.getState().setPresentationSubjectRef(subject.uid, file("wen.png", "\x89PNG"))

    const written = persisted()
    expect(written.presentation?.subjects[0]).toMatchObject({
      id: "wen",
      nameZh: "温",
      refFileName: "wen.png",
    })
    expect(written.presentation?.subjects[0].refBase64).toBe("")
  })

  it("does not persist the engine probe or the last run's terminal output", async () => {
    usePackStore
      .getState()
      .setCandidates([
        { kind: "binary", program: "loreweaver", args: [], cwd: null, version: "3.0.0", problem: null },
      ])
    usePackStore.getState().setRunResult({ code: 0, stdout: "x".repeat(1000), stderr: "", timedOut: false })
    const written = persisted()
    expect(written.candidates).toBeUndefined()
    expect(written.runResult).toBeUndefined()
    // The build RESULT does survive — "Verify" is one click away after a reload.
    expect(written).toHaveProperty("packResult")
  })

  it("migrates a stored 2.x draft: drops what 3.0 refuses, converts the panels, says so once", async () => {
    // A session as the 2.x bench persisted it (version 2): a lorebook item, a card whose
    // hooks were extracted into a skill, a skill with a hooks.js, a rule-pack script, a
    // prep script, a preset, and 1.x panels.
    const stale = {
      version: 2,
      state: {
        step: "metadata",
        items: [
          {
            uid: "c1",
            fileName: "heavy.json",
            sourceName: "heavy.json",
            kind: "card",
            base64: "",
            jsonText: heavyCardJson(),
            size: 10,
            needsBytes: false,
            card: null,
            payloads: { hooks: 1, initvarEntries: 1, ejsBlocks: 1, secretEntries: 0 },
            cardKind: "world",
            hooks: ["on('turn_start', () => {})"],
            leaves: [],
            leavesTruncated: false,
            initvarProblems: [],
            episode: "",
            drafts: [],
            extractSkill: true,
            notesEn: "",
            notesZh: "",
            entryCount: 0,
          },
          {
            uid: "l1",
            fileName: "book.json",
            sourceName: "book.json",
            kind: "lorebook",
            jsonText: "{}",
            entryCount: 2,
          },
        ],
        metadata: {
          id: "old-pack",
          version: "0.1.0",
          nameEn: "Old",
          rulepackPatch: "resolution:\n  script: grade.js\n",
          rulepackScriptName: "grade.js",
          rulepackScriptSource: "function resolve() {}",
        },
        panels: {
          yamlText:
            "panels:\n  - id: hud\n    title: HUD\n    slot: sidebar\n    audience: keeper\n    blocks:\n      - {kind: meter, label: Fear, value: {$var: fear}, min: 0, max: 10}\n",
          files: [],
        },
        manualSkills: [
          {
            slug: "pier",
            nameEn: "",
            descriptionEn: "",
            descriptionZh: "",
            hooks: ["on('x', () => {})"],
            skillMd: "",
          },
        ],
        prepScripts: [{ fileName: "setup.js", source: "plan('a', {})" }],
        packPresets: [{ fileName: "keeper.json", jsonText: "{}" }],
        episodes: [],
        buildUpTo: 0,
        outputDir: "/out",
        writtenDir: "/out/old-pack",
        installAfterBuild: true,
        packResult: { path: "/out/old.lwpack", trust: { skills: 1 } },
        builtPackPath: "/out/old.lwpack",
      },
    }
    localStorage.setItem("loreweaver-studio-pack", JSON.stringify(stale))
    await usePackStore.persist.rehydrate()
    const state = usePackStore.getState()

    expect(state.items.map((item) => item.fileName)).toEqual(["heavy.json"])
    expect(state.items[0]).not.toHaveProperty("extractSkill")
    expect(state.items[0]).not.toHaveProperty("entryCount")
    expect(state.metadata).toEqual({
      id: "old-pack",
      version: "0.1.0",
      nameEn: "Old",
      nameZh: "",
      descriptionEn: "",
      descriptionZh: "",
      authors: "",
      license: "",
      rulepackPatch: "resolution:\n  script: grade.js\n",
      rulepackId: "",
      rulepackMode: "patch",
    })
    expect(state.manualSkills).toEqual([
      { slug: "pier", nameEn: "", descriptionEn: "", descriptionZh: "", skillMd: "" },
    ])
    expect(state.modules).toEqual([])
    // The panels are 3.0 now: the variable reads through the variables view, keeper → admin.
    expect(state.panels?.yamlText).toContain("$view: vars.module.fear.value")
    expect(state.panels?.yamlText).toContain("vars: variables")
    expect(state.panels?.yamlText).toContain("audience: admin")
    // A 2.x build is not kept: it describes a pack 3.0 refuses.
    expect(state.packResult).toBeNull()
    expect(state.builtPackPath).toBeNull()
    expect(state.writtenDir).toBeNull()
    expect(state.outputDir).toBe("/out")
    // …and the author is told what happened, once.
    expect(state.migrationNotes.map((note) => note.key)).toEqual([
      "pack.migration.lorebooks",
      "pack.migration.cardHookSkills",
      "pack.migration.rulepackScript",
      "pack.migration.skillHooks",
      "pack.migration.prepScripts",
      "pack.migration.presets",
      "pack.migration.panelsConverted",
    ])
    expect(state.migrationNotes[0].params).toEqual({ count: 1 })
    usePackStore.getState().dismissMigrationNotes()
    expect(usePackStore.getState().migrationNotes).toEqual([])
    localStorage.clear()
  })

  it("migrates a half-written older blob without leaving a field a render would trip over", async () => {
    localStorage.setItem(
      "loreweaver-studio-pack",
      JSON.stringify({ state: { step: "nowhere", metadata: { id: 7 } }, version: 1 }),
    )
    await usePackStore.persist.rehydrate()
    const state = usePackStore.getState()
    expect(state.step).toBe("input")
    expect(state.metadata.id).toBe("")
    expect(() => state.metadata.rulepackPatch.trim()).not.toThrow()
    expect(state.items).toEqual([])
    expect(state.migrationNotes).toEqual([])
    localStorage.clear()
  })

  it("flags the panels a migration could only partly convert", () => {
    const migrated = migratePackSession(
      {
        panels: {
          yamlText:
            "panels:\n  - id: hud\n    title: HUD\n    slot: sidebar\n    blocks:\n      - {kind: stat, label: X, value: {$var: mvu.party.hp}}\n",
          files: [],
        },
      },
      2,
    )
    expect(migrated.migrationNotes.map((note) => note.key)).toEqual(["pack.migration.panelsLeftover"])
    // Left exactly as written, for the author: a dotted id is a tree leaf no single path names.
    expect(migrated.panels?.yamlText).toContain("$var: mvu.party.hp")
  })

  it("rehydrates a session of the CURRENT shape rather than discarding everything", async () => {
    // The other half: the discard must be driven by the version, not by being
    // indiscriminate. A session this build wrote comes back whole.
    const current = {
      state: { step: "metadata", metadata: { ...usePackStore.getState().metadata, id: "kept-pack" } },
      version: usePackStore.persist.getOptions().version,
    }
    localStorage.setItem("loreweaver-studio-pack", JSON.stringify(current))
    await usePackStore.persist.rehydrate()

    expect(usePackStore.getState().metadata.id).toBe("kept-pack")
    localStorage.clear()
  })
})
