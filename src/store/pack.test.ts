import { beforeEach, describe, expect, it } from "vitest"
import {
  buildDraftFromState,
  classifyJson,
  initvarLeaves,
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
    expect(classifyJson({ name: "Atlas", entries: { "0": { content: "a" } } })).toBe("lorebook")
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

describe("pack store pipeline", () => {
  beforeEach(reset)

  it("classifies dropped files and locks world kind on machinery", async () => {
    const store = usePackStore.getState()
    await store.addFiles([
      file("Heavy Card.json", heavyCardJson()),
      file("world book.json", JSON.stringify({ entries: [{ content: "lore" }, { content: "x" }] })),
      file("notes.txt", "hello"),
    ])
    const items = usePackStore.getState().items
    expect(items.map((item) => item.kind)).toEqual(["card", "lorebook", "asset"])

    const card = items[0]
    expect(card.cardKind).toBe("world")
    expect(card.payloads).toEqual({ hooks: 1, initvarEntries: 1, ejsBlocks: 1, secretEntries: 0 })
    expect(card.drafts.length).toBe(2)
    expect(items[1].entryCount).toBe(2)

    // The engine's rule survives manual edits: machinery ⇒ world.
    usePackStore.getState().updateItem(card.uid, { cardKind: "character" })
    expect(usePackStore.getState().items[0].cardKind).toBe("world")
  })

  it("pins a clean card to character in both directions (v2: kind is detected, never declared)", async () => {
    const store = usePackStore.getState()
    await store.addFiles([file("npc.json", JSON.stringify({ spec: "chara_card_v2", data: { name: "NPC" } }))])
    const card = usePackStore.getState().items[0]
    expect(card.cardKind).toBe("character")
    usePackStore.getState().updateItem(card.uid, { cardKind: "world" })
    expect(usePackStore.getState().items[0].cardKind).toBe("character")
  })

  it("folds a native bundle's typed variables specs into the world detection", async () => {
    const store = usePackStore.getState()
    // A specs-only lorecard: no hooks, no [InitVar] entry, no secret lore —
    // only typed specs. `core/pack.py:644-652` forces kind: world here.
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
    await store.addFiles([file("lin-wan.lorecard.json", JSON.stringify(bundle))])
    const card = usePackStore.getState().items[0]
    expect(card.kind).toBe("card")
    expect(card.cardKind).toBe("world")
    expect(card.payloads).toEqual({ hooks: 0, initvarEntries: 2, ejsBlocks: 0, secretEntries: 0 })
  })

  it("keeps a native bundle without any machinery a character card", async () => {
    const store = usePackStore.getState()
    const bundle = {
      format: "loreweaver.card",
      format_version: 1,
      name: "阿白",
      description: "no trackers at all",
      worldbook: [{ title: "Pier", content: "plain lore" }],
    }
    await store.addFiles([file("a-bai.lorecard.json", JSON.stringify(bundle))])
    const card = usePackStore.getState().items[0]
    expect(card.cardKind).toBe("character")
    expect(card.payloads?.initvarEntries).toBe(0)
  })

  it("builds a WorldPackDraft with skills extracted and hooks removed from the card copy", async () => {
    await usePackStore.getState().addFiles([file("heavy.json", heavyCardJson())])
    const card = usePackStore.getState().items[0]
    usePackStore.getState().updateItem(card.uid, { extractSkill: true, notesZh: "备注", notesEn: "note" })

    const draft = buildDraftFromState(usePackStore.getState().items, {
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
      rulepackScriptName: "",
      rulepackScriptSource: "",
    })
    expect(draft.cards).toHaveLength(1)
    // Manifest v2: the author draft carries NO kind — detection stamps it.
    expect(draft.cards[0]).not.toHaveProperty("kind")
    expect(draft.cards[0].jsonText).not.toContain("loreweaver_hooks")
    expect(draft.skills).toHaveLength(1)
    expect(draft.skills[0].hooks).toEqual(["on('turn_start', () => {})"])
  })

  it("suggests expose lines only for player-guessed prefixes of world cards", async () => {
    await usePackStore.getState().addFiles([file("heavy.json", heavyCardJson())])
    // 理.好感度 is player-guessed; secret_flag is keeper-guessed by name.
    expect(packExposeLines(usePackStore.getState().items)).toEqual([".var expose 理"])
  })

  it("carries asset items into the draft instead of dropping them silently", async () => {
    await usePackStore.getState().addFiles([file("cover art.png", "not a png at all")])
    const items = usePackStore.getState().items
    expect(items[0].kind).toBe("asset")
    const draft = buildDraftFromState(items, {
      id: "p",
      version: "0.1.0",
      nameEn: "P",
      nameZh: "",
      descriptionEn: "d",
      descriptionZh: "",
      authors: "a",
      license: "MIT",
      rulepackPatch: "",
      rulepackId: "",
      rulepackMode: "patch" as const,
      rulepackScriptName: "",
      rulepackScriptSource: "",
    })
    expect(draft.assets).toEqual([{ fileName: items[0].fileName, base64: items[0].base64, episode: "" }])
  })

  describe("rules scripts", () => {
    const withRulepack = (yamlText: string, source: string) =>
      buildDraftFromState([], {
        id: "p",
        version: "0.1.0",
        nameEn: "P",
        nameZh: "",
        descriptionEn: "d",
        descriptionZh: "",
        authors: "a",
        license: "MIT",
        rulepackPatch: yamlText,
        rulepackId: "mysys",
        rulepackMode: "full" as const,
        rulepackScriptName: "whatever-the-picker-called-it.js",
        rulepackScriptSource: source,
      })

    it("ships the script under the name the YAML declares, not the picked one", () => {
      // `core/pack.py` reads the script by the name in `resolution.script` and
      // from NEXT TO the yaml. The file name the author happened to pick on
      // disk is not the contract; the declaration is.
      const draft = withRulepack("resolution:\n  script: grade.js\n  roll: 1d100\n", "function resolve() {}")
      expect(draft.rulepacks[0].scripts).toEqual([{ fileName: "grade.js", source: "function resolve() {}" }])
    })

    it("ships nothing when the YAML declares no script", () => {
      // An orphan file would be dead weight at best; the engine never reads a
      // script it was not pointed at.
      const draft = withRulepack("extends: coc7\n", "function resolve() {}")
      expect(draft.rulepacks[0].scripts).toEqual([])
    })

    it("ships nothing when the declaration has no source behind it", () => {
      const draft = withRulepack("resolution:\n  script: grade.js\n  roll: 1d100\n", "   ")
      expect(draft.rulepacks[0].scripts).toEqual([])
    })
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
    rulepackScriptName: "",
    rulepackScriptSource: "",
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
    const draft = buildDraftFromState([], metadata, null, [], kit)
    expect(draft.presentation).toBe(kit)

    const issues = packValidationIssues([], metadata, null, [], kit)
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
    rulepackScriptName: "",
    rulepackScriptSource: "",
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

    const blocked = packValidationIssues(usePackStore.getState().items, metadata)
    expect(blocked.map((issue) => issue.key)).toContain("packItemNeedsBytes")

    usePackStore
      .getState()
      .reattachItem(item.uid, { name: "cover.png", path: null, bytes: encoder.encode("\x89PNG") })
    const after = usePackStore.getState().items[0]
    expect(after.needsBytes).toBe(false)
    expect(after.base64).not.toBe("")
    expect(
      packValidationIssues(usePackStore.getState().items, metadata).map((issue) => issue.key),
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
    usePackStore.getState().setCandidates([{ kind: "python-module", program: "py", args: [], cwd: null }])
    usePackStore.getState().setRunResult({ code: 0, stdout: "x".repeat(1000), stderr: "", timedOut: false })
    const written = persisted()
    expect(written.candidates).toBeUndefined()
    expect(written.runResult).toBeUndefined()
    // The build RESULT does survive — "Test now" is one click away after a reload.
    expect(written).toHaveProperty("packResult")
  })
})
