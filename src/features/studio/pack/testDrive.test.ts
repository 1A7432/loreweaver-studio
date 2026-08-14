import { describe, expect, it } from "vitest"
import { planTestDrive, readInstalledManifest } from "./testDrive"

const SOURCE = {
  packId: "corridor-apartment",
  cards: [
    { path: "cards/keeper.lorecard.json", kind: "world" as const },
    { path: "cards/hana.json", kind: "character" as const },
  ],
  lorebooks: ["lorebooks/rain.json"],
}

describe("planTestDrive", () => {
  it("issues the engine's pack-relative refs, world cards first", () => {
    // Both shapes come straight from the engine: `.import <file> world`
    // (cmd_import) and `.lore import <file>` (cmd_lore), with the ref in the
    // `<packId>/<path>` form `resolve_installed_path` understands.
    expect(planTestDrive(SOURCE).commands).toEqual([
      ".import corridor-apartment/cards/keeper.lorecard.json world",
      ".lore import corridor-apartment/lorebooks/rain.json",
    ])
  })

  it("leaves character cards to the players who claim them", () => {
    const plan = planTestDrive({ ...SOURCE, cards: [{ path: "cards/hana.json", kind: "character" }] })
    expect(plan.commands).toEqual([".lore import corridor-apartment/lorebooks/rain.json"])
  })

  it("plans nothing when the pack has no importable content", () => {
    const plan = planTestDrive({ packId: "corridor-apartment", cards: [], lorebooks: [] })
    expect(plan.commands).toEqual([])
    expect(plan.emptyReason).toBe("nothing-importable")
  })

  it("refuses a pack id the engine's resolver would not accept", () => {
    // A ref outside `_SLUG_RE` never resolves pack-relative; it would silently
    // become a literal server path, which is never what the author meant.
    for (const packId of ["", "Corridor", "corridor apartment", "-corridor", "corridor/apartment"]) {
      const plan = planTestDrive({ ...SOURCE, packId })
      expect(plan.emptyReason, packId).toBe("no-pack-id")
      expect(plan.commands, packId).toEqual([])
    }
  })

  it("skips blank paths instead of emitting a broken ref", () => {
    const plan = planTestDrive({
      packId: "deep-pier",
      cards: [{ path: "  ", kind: "world" }],
      lorebooks: ["", "lorebooks/tide.json"],
    })
    expect(plan.commands).toEqual([".lore import deep-pier/lorebooks/tide.json"])
  })
})

describe("readInstalledManifest", () => {
  it("reads the built manifest's stamped card kinds", () => {
    // The exact shape `core/pack.py::_card_entry_to_yaml` writes into a BUILT
    // pack.yaml: cards are {path, kind[, notes]} mappings, lorebooks bare paths.
    const manifest = `
manifest_version: 2
id: corridor-apartment
version: 1.0.0
contents:
  cards:
    - path: cards/keeper.lorecard.json
      kind: world
      notes:
        en: Keeper only.
    - path: cards/hana.json
      kind: character
  lorebooks:
    - lorebooks/rain.json
`
    expect(readInstalledManifest(manifest)).toEqual({
      packId: "corridor-apartment",
      cards: [
        { path: "cards/keeper.lorecard.json", kind: "world" },
        { path: "cards/hana.json", kind: "character" },
      ],
      lorebooks: ["lorebooks/rain.json"],
    })
  })

  it("reads a bare-path (source) manifest as characters only", () => {
    // A SOURCE pack.yaml carries no kinds — the engine refuses a declared one.
    // Treating an unstamped card as `character` means the worst case is a world
    // card left unimported, never module machinery run by surprise.
    const source = readInstalledManifest("id: deep-pier\ncontents:\n  cards:\n    - cards/keeper.json\n")
    expect(source?.cards).toEqual([{ path: "cards/keeper.json", kind: "character" }])
    expect(planTestDrive(source!).emptyReason).toBe("nothing-importable")
  })

  it("returns null for anything that is not a manifest", () => {
    expect(readInstalledManifest("")).toBeNull()
    expect(readInstalledManifest("just: a mapping")).toBeNull()
    expect(readInstalledManifest("id: [not, a, string]")).toBeNull()
    expect(readInstalledManifest("a: b\n  c: d\n :::")).toBeNull()
  })

  it("survives a manifest with no contents at all", () => {
    expect(readInstalledManifest("id: bare\nversion: 0.1.0\n")).toEqual({
      packId: "bare",
      cards: [],
      lorebooks: [],
    })
  })
})

describe("planTestDrive — the dev-room mode", () => {
  it("is one command: the engine mounts the tree and then follows it", () => {
    // `gateway/dev_room.py`: `.dev mount <src-dir>` imports the module and
    // starts watching, so the studio has nothing else to say.
    const plan = planTestDrive(SOURCE, "mount-source", "/Users/nyx/packs/corridor-apartment")
    expect(plan.commands).toEqual([".dev mount /Users/nyx/packs/corridor-apartment"])
    expect(plan.emptyReason).toBeNull()
  })

  it("needs a source tree on disk, and says which is missing", () => {
    const plan = planTestDrive(SOURCE, "mount-source", "   ")
    expect(plan.commands).toEqual([])
    expect(plan.emptyReason).toBe("no-source-dir")
  })

  it("does not care about the pack id — nothing is installed to resolve against", () => {
    const plan = planTestDrive({ packId: "", cards: [], lorebooks: [] }, "mount-source", "/tmp/pack")
    expect(plan.commands).toEqual([".dev mount /tmp/pack"])
  })
})
