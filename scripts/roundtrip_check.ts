// The assertions of the round-trip gate (`scripts/check_roundtrip.sh`), one subcommand per
// stage. Each prints what it checked and exits non-zero on the first mismatch.
//
//   bun scripts/roundtrip_check.ts build   <build.json> <expect.json>
//   bun scripts/roundtrip_check.ts install <install.json> <packs.json> <expect.json>
//   bun scripts/roundtrip_check.ts cards   <engine-repo> <exports-dir>
//   bun scripts/roundtrip_check.ts panels  <engine-repo> <pack-source-dir>
//
// `cards` and `panels` import the ENGINE's own functions by path from its checkout (its card
// reader, its panels reader and wire step) and run them beside Studio's on the same input.

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

function fail(message: string): never {
  console.error(`roundtrip_check: FAIL: ${message}`)
  process.exit(1)
}

function check(condition: boolean, message: string): void {
  if (!condition) fail(message)
}

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch (error) {
    fail(`${path} is not one JSON object: ${String(error)}`)
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface Expect {
  id: string
  version: string
  runsCode: boolean
  modules: string[]
  ruleSystems: string[]
  skills: string[]
  cards: Record<string, "world" | "character">
  panels: Record<string, "template" | "page">
  presentation: { subjects: number; cues: number }
}

interface Trust {
  id: string
  version: string
  runsCode: boolean
  modules: { id: string; entry: string }[]
  ruleSystems: { id: string }[]
  skills: { id: string }[]
  cards: { path: string; kind: string }[]
  panels: { id: string; kind: string }[]
  presentation: { subjects: number; cues: number } | null
  ignored: unknown[]
}

/** The trust card says exactly what Studio believes the pack is. */
function checkTrust(trust: Trust, expect: Expect, where: string): void {
  check(
    trust.id === expect.id && trust.version === expect.version,
    `${where}: id/version ${trust.id}@${trust.version}`,
  )
  check(
    trust.runsCode === expect.runsCode,
    `${where}: runsCode is ${trust.runsCode}, the pack ships a module`,
  )
  check(
    same(
      trust.modules.map((module) => module.id),
      expect.modules,
    ),
    `${where}: modules ${JSON.stringify(trust.modules)} ≠ ${JSON.stringify(expect.modules)}`,
  )
  check(
    trust.modules.every((module) => module.entry === `modules/${module.id}.js`),
    `${where}: a module entry is not the builder's bundle: ${JSON.stringify(trust.modules)}`,
  )
  check(
    same(
      trust.ruleSystems.map((system) => system.id),
      expect.ruleSystems,
    ),
    `${where}: rule systems ${JSON.stringify(trust.ruleSystems)}`,
  )
  check(
    same(
      trust.skills.map((skill) => skill.id),
      expect.skills,
    ),
    `${where}: skills ${JSON.stringify(trust.skills)}`,
  )
  const cards = Object.fromEntries(trust.cards.map((card) => [card.path, card.kind]))
  check(
    same(cards, expect.cards),
    `${where}: card kinds ${JSON.stringify(cards)} ≠ Studio's ${JSON.stringify(expect.cards)}`,
  )
  const panels = Object.fromEntries(trust.panels.map((panel) => [panel.id, panel.kind]))
  check(same(panels, expect.panels), `${where}: panels ${JSON.stringify(panels)}`)
  check(
    trust.presentation !== null &&
      trust.presentation.subjects === expect.presentation.subjects &&
      trust.presentation.cues === expect.presentation.cues,
    `${where}: presentation ${JSON.stringify(trust.presentation)}`,
  )
  check(
    trust.ignored.length === 0,
    `${where}: the trust card lists ignored files ${JSON.stringify(trust.ignored)}`,
  )
}

function stageBuild(buildPath: string, expectPath: string): void {
  const build = readJson(buildPath)
  const expect = readJson(expectPath) as unknown as Expect
  check(build.ok === true, `the builder refused the pack: ${JSON.stringify(build)}`)
  check(typeof build.out === "string" && typeof build.sha256 === "string", `the build JSON has no out/sha256`)
  check(
    Array.isArray(build.ignored) && build.ignored.length === 0,
    `the builder ignored ${JSON.stringify(build.ignored)}`,
  )
  checkTrust(build.trust as Trust, expect, "build")
  console.log(
    `ok: built ${String(build.out)} (${String(build.bytes)} bytes, sha256 ${String(build.sha256).slice(0, 16)}…)`,
  )
  console.log(
    `ok: trust card — runs code (${expect.modules.join(", ")}), ${Object.keys(expect.cards).length} cards with Studio's kinds, ${Object.keys(expect.panels).length} panels, kit ${expect.presentation.subjects}/${expect.presentation.cues}, nothing ignored`,
  )
}

function stageInstall(installPath: string, packsPath: string, expectPath: string): void {
  const install = readJson(installPath)
  const packs = readJson(packsPath)
  const expect = readJson(expectPath) as unknown as Expect
  check(
    install.ok === true && install.installed === true,
    `the installer refused the pack: ${JSON.stringify(install)}`,
  )
  check(
    install.id === expect.id && install.version === expect.version,
    `installed ${String(install.id)}@${String(install.version)}`,
  )
  const shadowed = install.shadowed as { ruleSystems: unknown[]; skills: unknown[] }
  check(
    shadowed.ruleSystems.length === 0 && shadowed.skills.length === 0,
    `ids shadowed: ${JSON.stringify(shadowed)}`,
  )
  checkTrust(install.trust as Trust, expect, "install")
  const listed = packs.packs as { id: string; version: string; sha256: string }[]
  check(packs.ok === true && Array.isArray(listed), `packs did not list: ${JSON.stringify(packs)}`)
  check(
    listed.length === 1 &&
      listed[0].id === expect.id &&
      listed[0].version === expect.version &&
      listed[0].sha256 === install.sha256,
    `the installed listing is ${JSON.stringify(listed)}`,
  )
  console.log(
    `ok: installed ${expect.id}@${expect.version} into the scratch data directory; packs lists exactly it`,
  )
}

interface StudioReading {
  name: string
  kind: string
  entries: number
  kept: number
  declarations: number
  secret: number
  moduleVariables: number
}

async function stageCards(engine: string, dir: string): Promise<void> {
  const card = await import(join(engine, "server/src/core/card/index.ts"))
  const expect = readJson(join(dir, "expect.json")) as unknown as Record<string, StudioReading>
  const names = readdirSync(dir).filter((name) => name !== "expect.json")
  check(names.length === Object.keys(expect).length, `exports ${JSON.stringify(names)} ≠ expectations`)
  for (const name of names) {
    const bytes = new Uint8Array(readFileSync(join(dir, name)))
    let imported
    try {
      imported = card.parseCard(bytes, name)
    } catch (error) {
      fail(`the engine's card reader refused Studio's ${name}: ${String(error)}`)
    }
    const split = card.splitCard(imported)
    const engineReading: StudioReading = {
      name: imported.card.name,
      kind: split.kind,
      entries: imported.card.book.length,
      kept: split.character.book.length,
      declarations: split.machinery.variableDeclarations,
      secret: split.machinery.secretEntries,
      moduleVariables: split.machinery.moduleVariables,
    }
    check(
      same(engineReading, expect[name]),
      `${name}: the engine reads ${JSON.stringify(engineReading)}, Studio ${JSON.stringify(expect[name])}`,
    )
    check(
      split.machinery.unsupportedHooks === 0,
      `${name}: Studio wrote ${split.machinery.unsupportedHooks} hook script(s)`,
    )
    if (imported.lorecard !== null) {
      check(imported.lorecard.pregens.length === 0, `${name}: Studio wrote a pregenerated cast`)
    }
    console.log(
      `ok: ${name} — ${engineReading.kind}, ${engineReading.entries} entries (${engineReading.kept} kept for a player)`,
    )
  }
}

/** Sample view values: the engine's own view values from Studio's play fixture, plus the
 * module view the gate's panels read. */
function sampleValues(role: "player" | "admin"): Map<string, unknown> {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "../src/features/play/fixtures/views.json"), "utf8"),
  )
  const values = new Map<string, unknown>(Object.entries(fixture[role] as Record<string, unknown>))
  values.set("corridor/tide", { level: 4, max: 10 })
  const variables = values.get("variables") as { module: { id: string; value: unknown }[] } | undefined
  // A declared `理智` low enough for the gated block to show — and one run without it.
  values.set("variables", {
    module: [...(variables?.module ?? []), { id: "理智", kind: "number", label: "理智", value: 20 }],
    tree: [],
  })
  return values
}

async function stagePanels(engine: string, source: string): Promise<void> {
  const panels = await import(join(engine, "server/src/core/panels/index.ts"))
  const wire = await import(join(engine, "server/src/core/panels/wire.ts"))
  const protocol = await import(join(engine, "clients/protocol/src/v3/index.ts"))
  const { parsePanelsYaml } = await import("../src/features/studio/pack/panelsModel")
  const { checkPanelsText } = await import("../src/features/studio/pack/panelsCheck")
  const { previewBlocks, imageMime } = await import("../src/features/studio/pack/panelsPreview")

  const text = readFileSync(join(source, "ui/panels.yaml"), "utf8")
  const parsed = panels.parsePanels(text)
  check(parsed.ok, `the engine's panels reader refused Studio's panels: ${JSON.stringify(parsed.problems)}`)
  const studioCheck = checkPanelsText(text)
  check(
    studioCheck.problems.length === 0,
    `Studio's checks disagree (they flag ${JSON.stringify(studioCheck.problems)})`,
  )
  const studio = parsePanelsYaml(text)
  check(studio.error === null, `Studio's editor cannot read its own panels: ${studio.error}`)
  check(studio.document.panels.length === parsed.panels.length, `panel counts differ`)

  let compared = 0
  for (const [index, spec] of parsed.panels.entries()) {
    const draft = studio.document.panels[index]
    check(draft.id === spec.id, `panel ${index}: ${draft.id} ≠ ${spec.id}`)
    // The engine's wire step, with each picture's "hash" standing for its pack path — what the
    // preview substitutes, since it has file names, not a media store.
    const images = new Map<string, { sha256: string; size: number; mime: string }>(
      spec.images.map((path: string) => [path, { sha256: path, size: 0, mime: imageMime(path) ?? "" }]),
    )
    const page = spec.entry === null ? null : { sha256: spec.entry, size: 0, mime: "text/html" }
    for (const locale of ["en", "zh"]) {
      const entry = wire.panelEntry("pack", spec, locale, images, page)
      check(entry !== null, `the engine could not list panel ${spec.id}`)
      for (const role of ["player", "admin"] as const) {
        for (const withVariables of [true, false]) {
          const values = sampleValues(role)
          if (!withVariables) values.delete("variables")
          const engineBlocks = protocol.panelBlocks(entry, values)
          const studioBlocks = previewBlocks(draft, locale, values)
          check(
            same(engineBlocks, studioBlocks),
            `panel ${spec.id} (${locale}, ${role}, variables ${withVariables ? "held" : "absent"}): the engine shows ${JSON.stringify(engineBlocks)}, Studio's preview ${JSON.stringify(studioBlocks)}`,
          )
          compared += 1
        }
      }
    }
    const shown = protocol.panelBlocks(
      wire.panelEntry("pack", spec, "en", images, page),
      sampleValues("player"),
    )
    console.log(
      `ok: panel ${spec.id} (${spec.kind}) — ${shown === null ? "no fallback" : `${shown.length} blocks`} for a player, identical in Studio's preview`,
    )
  }
  console.log(`ok: ${compared} evaluations compared (2 locales × 2 roles × variables held/absent)`)
}

const [stage, ...args] = process.argv.slice(2)
switch (stage) {
  case "build":
    stageBuild(args[0], args[1])
    break
  case "install":
    stageInstall(args[0], args[1], args[2])
    break
  case "cards":
    await stageCards(args[0], args[1])
    break
  case "panels":
    await stagePanels(args[0], args[1])
    break
  default:
    fail(`unknown stage ${String(stage)} (build | install | cards | panels)`)
}
