import { describe, expect, it } from "vitest"
import BUILD_OK from "./fixtures/build-ok.json"
import REFUSED from "./fixtures/build-refused.stderr.txt?raw"
import {
  parseInstallJson,
  parsePackBuildJson,
  parsePacksJson,
  parseTrust,
  readCommandJson,
} from "./buildResult"

// `build-ok.json` and `build-refused.stderr.txt` are what the 3.0 engine's builder printed for
// the round-trip gate's pack (`scripts/gen_roundtrip_pack.ts`), and for the same pack with two
// cards declared the wrong kind — captured, not written by hand.

describe("parsePackBuildJson", () => {
  it("reads the builder's success object, trust card included", () => {
    const outcome = parsePackBuildJson(JSON.stringify(BUILD_OK))
    expect(outcome?.ok).toBe(true)
    if (!outcome?.ok) return
    const { result } = outcome
    expect(result.out).toBe("/out/corridor-apartment-1.0.0.lwpack")
    expect(result.bytes).toBe(BUILD_OK.bytes)
    expect(result.ignored).toEqual([])
    expect(result.trust.runsCode).toBe(true)
    expect(result.trust.modules).toEqual([
      {
        id: "corridor",
        entry: "modules/corridor.js",
        bytes: BUILD_OK.trust.modules[0].bytes,
        sha256: BUILD_OK.trust.modules[0].sha256,
      },
    ])
    expect(result.trust.ruleSystems).toEqual([{ id: "corridor-rules", extends: "coc7" }])
    expect(result.trust.cards.map((card) => [card.path, card.kind])).toEqual([
      ["cards/corridor-apartment.lorecard.json", "world"],
      ["cards/lin-wan.st.json", "character"],
      ["cards/administrator.st.json", "world"],
      ["cards/lin-wan.png", "character"],
    ])
    expect(result.trust.cards[2].machinery).toEqual({
      variableDeclarations: 1,
      templates: 1,
      secretEntries: 0,
      moduleVariables: 0,
      hooks: 1,
    })
    expect(result.trust.panels.map((panel) => [panel.id, panel.kind, panel.audience])).toEqual([
      ["handouts", "template", "all"],
      ["case-board", "page", "admin"],
    ])
    expect(result.trust.presentation).toEqual({ subjects: 1, cues: 1, generation: "allow" })
  })

  it("reads a refusal from STDERR, where the engine prints it, with every problem", () => {
    const outcome = parsePackBuildJson("", REFUSED)
    expect(outcome).toEqual({
      ok: false,
      refusal: {
        code: "invalid_pack",
        problems: [
          { code: "card_kind_mismatch", path: "cards/lin-wan.st.json", detail: "character" },
          { code: "card_kind_mismatch", path: "cards/lin-wan.png", detail: "character" },
        ],
      },
    })
  })

  it("keeps a single refusal's path and detail", () => {
    const outcome = parsePackBuildJson("", '{"ok":false,"code":"missing_file","path":"src/tide.ts"}\n')
    expect(outcome).toEqual({
      ok: false,
      refusal: { code: "missing_file", path: "src/tide.ts", problems: [] },
    })
  })

  it("answers null when neither stream is the engine's object (not a 3.0 engine)", () => {
    expect(parsePackBuildJson("usage: python -m app", "Traceback (most recent call last):")).toBeNull()
    expect(parsePackBuildJson('{"ok":true,"path":"/x"}')).toBeNull()
  })
})

describe("readCommandJson", () => {
  it("prefers stdout, then the LAST JSON line of stderr", () => {
    expect(readCommandJson('{"a":1}', '{"b":2}')).toEqual({ a: 1 })
    expect(readCommandJson("", 'warning: something\n{"b":2}\n')).toEqual({ b: 2 })
    expect(readCommandJson("", "nothing here")).toBeNull()
  })
})

describe("parseInstallJson / parsePacksJson", () => {
  it("reads the installer's answer and the listing", () => {
    const install = parseInstallJson(
      JSON.stringify({
        ok: true,
        installed: true,
        id: "corridor-apartment",
        version: "1.0.0",
        sha256: BUILD_OK.sha256,
        trust: BUILD_OK.trust,
        shadowed: { ruleSystems: [], skills: ["corridor-procedures"] },
        replaced: null,
      }),
    )
    expect(install?.ok).toBe(true)
    if (install?.ok) {
      expect(install.result.installed).toBe(true)
      expect(install.result.shadowed).toEqual({ ruleSystems: [], skills: ["corridor-procedures"] })
    }
    expect(parseInstallJson("", '{"ok":false,"code":"engine_too_old","detail":"protocol 3.1"}')).toEqual({
      ok: false,
      refusal: { code: "engine_too_old", detail: "protocol 3.1", problems: [] },
    })
    expect(
      parsePacksJson(
        '{"ok":true,"packs":[{"id":"a","version":"1.0.0","name":{"en":"A"},"sha256":"x","installedAt":1}]}',
      ),
    ).toEqual([{ id: "a", version: "1.0.0", name: { en: "A" }, sha256: "x" }])
    expect(parsePacksJson('{"ok":false,"code":"x"}')).toBeNull()
  })

  it("refuses a trust card without its code flag rather than guessing one", () => {
    expect(parseTrust({ ...BUILD_OK.trust, runsCode: undefined })).toBeNull()
  })
})
