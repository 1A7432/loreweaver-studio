import { describe, expect, it } from "vitest"
import {
  buildChangelog,
  episodesUpTo,
  filterEpisodeContent,
  includedInBuild,
  latestOrdinal,
  ordinalOf,
  suggestedVersion,
  versionMatchesConvention,
  type PackEpisode,
} from "./episodes"

const EPISODES: PackEpisode[] = [
  { id: "ep1", ordinal: 1, title: "雨夜", summary: "第一夜。", releaseNotes: "首次发布。" },
  { id: "ep2", ordinal: 2, title: "第五层", summary: "楼梯尽头。", releaseNotes: "新增第五层。" },
  { id: "ep3", ordinal: 3, title: "名册", summary: "湿掉的一行字。", releaseNotes: "" },
]

describe("episode ordinals", () => {
  it("reads an untagged item as evergreen", () => {
    expect(ordinalOf(EPISODES, undefined)).toBe(1)
    expect(ordinalOf(EPISODES, "  ")).toBe(1)
    expect(ordinalOf(EPISODES, "ep2")).toBe(2)
  })

  it("reports an unknown tag rather than guessing an ordinal", () => {
    expect(ordinalOf(EPISODES, "ep9")).toBeNull()
  })

  it("INCLUDES an unknown tag in the build", () => {
    // Dropping content is the one failure a build cannot be forgiven for: a
    // typo would silently ship a hole. The lint says so instead.
    expect(includedInBuild(EPISODES, { episode: "typo" }, 1)).toBe(true)
    expect(includedInBuild(EPISODES, {}, 1)).toBe(true)
    expect(includedInBuild(EPISODES, { episode: "ep2" }, 1)).toBe(false)
    expect(includedInBuild(EPISODES, { episode: "ep2" }, 2)).toBe(true)
  })

  it("knows the latest ordinal and the slice up to one", () => {
    expect(latestOrdinal(EPISODES)).toBe(3)
    expect(latestOrdinal([])).toBe(0)
    expect(episodesUpTo(EPISODES, 2).map((e) => e.id)).toEqual(["ep1", "ep2"])
  })
})

describe("the version convention", () => {
  it("suggests MINOR = episode without touching major or patch", () => {
    expect(suggestedVersion("1.0.0", 4)).toBe("1.4.0")
    expect(suggestedVersion("2.1.7-beta", 3)).toBe("2.3.7-beta")
  })

  it("leaves a version it does not understand exactly as written", () => {
    // Surfaced, never enforced: an author who versions differently is not
    // wrong, and a build that refused them would invent a rule the engine has
    // no notion of.
    expect(suggestedVersion("nightly", 2)).toBe("nightly")
  })

  it("recognizes a version already following it", () => {
    expect(versionMatchesConvention("1.2.0", 2)).toBe(true)
    expect(versionMatchesConvention("1.0.0", 2)).toBe(false)
    expect(versionMatchesConvention("nightly", 2)).toBe(false)
  })
})

describe("buildChangelog", () => {
  it("writes the release-notes chain newest first, stamping only this release", () => {
    const text = buildChangelog("回廊公寓", "1.2.0", EPISODES, 2)
    expect(text.indexOf("## 2.")).toBeLessThan(text.indexOf("## 1."))
    expect(text).toContain("## 2. 第五层 — 1.2.0")
    // Episode 1 shipped under its own version; stamping it 1.2.0 would be a lie.
    expect(text).toContain("## 1. 雨夜")
    expect(text).not.toContain("## 1. 雨夜 — 1.2.0")
    expect(text).toContain("新增第五层。")
    // Nothing past the horizon, not even its title.
    expect(text).not.toContain("名册")
  })

  it("writes nothing at all when no included episode has notes", () => {
    // An empty changelog is worse than none; the lint asks for the notes.
    expect(buildChangelog("x", "1.3.0", [EPISODES[2]], 3)).toBe("")
    expect(buildChangelog("x", "1.0.0", [], 1)).toBe("")
  })
})

describe("filterEpisodeContent", () => {
  const lorecard = JSON.stringify({
    format: "loreweaver.card",
    format_version: 1,
    name: "回廊公寓",
    worldbook: [
      { title: "雨夜的规则", content: "雨夜才有第五层。" },
      { title: "第五层的住户", content: "他早已不是人类。", episode: "ep2" },
    ],
    pregens: [{ name: "林晚" }, { name: "陈九鲤", episode: "ep2" }],
  })

  it("removes future-episode entries and pregens from the artifact", () => {
    const filtered = JSON.parse(filterEpisodeContent(lorecard, EPISODES, 1)) as {
      worldbook: { title: string }[]
      pregens: { name: string }[]
    }
    expect(filtered.worldbook.map((e) => e.title)).toEqual(["雨夜的规则"])
    expect(filtered.pregens.map((p) => p.name)).toEqual(["林晚"])
    // The whole point: the circulating file has no trace of the later chapter.
    expect(filterEpisodeContent(lorecard, EPISODES, 1)).not.toContain("他早已不是人类")
    expect(filterEpisodeContent(lorecard, EPISODES, 1)).not.toContain("陈九鲤")
  })

  it("strips the studio's own tag from what survives", () => {
    const text = filterEpisodeContent(lorecard, EPISODES, 2)
    expect(text).toContain("他早已不是人类")
    // No built artifact ever carries the tag — it is a studio-side concept.
    expect(JSON.parse(text)).toEqual({
      format: "loreweaver.card",
      format_version: 1,
      name: "回廊公寓",
      worldbook: [
        { title: "雨夜的规则", content: "雨夜才有第五层。" },
        { title: "第五层的住户", content: "他早已不是人类。" },
      ],
      pregens: [{ name: "林晚" }, { name: "陈九鲤" }],
    })
  })

  it("handles a SillyTavern card and a world-info export too", () => {
    const st = JSON.stringify({
      spec: "chara_card_v3",
      data: { character_book: { entries: [{ comment: "a" }, { comment: "b", episode: "ep2" }] } },
    })
    const filteredSt = JSON.parse(filterEpisodeContent(st, EPISODES, 1)) as {
      data: { character_book: { entries: { comment: string }[] } }
    }
    expect(filteredSt.data.character_book.entries.map((e) => e.comment)).toEqual(["a"])

    // An index-keyed world-info map keeps its keys.
    const wi = JSON.stringify({ entries: { "0": { comment: "a" }, "1": { comment: "b", episode: "ep2" } } })
    expect(JSON.parse(filterEpisodeContent(wi, EPISODES, 1))).toEqual({ entries: { "0": { comment: "a" } } })
  })

  it("leaves a one-shot pack's bytes exactly as they were", () => {
    // A pack that never heard of episodes must build byte-identically.
    expect(filterEpisodeContent(lorecard, [], 1)).toBe(lorecard)
    const untagged = JSON.stringify({ worldbook: [{ title: "a" }] })
    expect(filterEpisodeContent(untagged, EPISODES, 1)).toBe(untagged)
  })

  it("passes through anything that is not a JSON object", () => {
    expect(filterEpisodeContent("not json", EPISODES, 1)).toBe("not json")
    expect(filterEpisodeContent("[1,2]", EPISODES, 1)).toBe("[1,2]")
  })
})
