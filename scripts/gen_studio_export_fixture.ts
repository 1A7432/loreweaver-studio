// Writes every card shape the card forge exports, from the REAL exporters, for the round-trip
// gate to parse with the 3.0 engine's own card reader (`scripts/roundtrip_check.ts cards`):
//
//   bun scripts/gen_studio_export_fixture.ts <out-dir>
//
// Writes into <out-dir>:
//   world.lorecard.json      the native bundle (`exportNativeBundle`)
//   world.safe.st.json       the SillyTavern card, safe-to-circulate flavor (no secret lore)
//   world.release.st.json    the SillyTavern card, release flavor (secret lore included)
//   world.release.png        that card embedded in a PNG (`embedCardIntoPng`)
//   character.st.json        a persona with no world machinery at all
//   expect.json              what STUDIO reads back from each file with its own parser and
//                            splitter (kind, entry counts) — the engine must agree.
//
// The synthetic project ("回廊公寓") is deliberately neutral and kept in step with the pack
// the gate builds (`gen_roundtrip_pack.ts`).

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { exportNativeBundle, exportSillyTavernCard } from "../src/features/studio/exporters"
import { embedCardIntoPng } from "../src/features/studio/pngCard"
import { newLoreEntry, newProject, newVariable, validateProject } from "../src/features/studio/model"
import { parseCardBytes, type StCharacterCard } from "../src/features/studio/split/charcard"
import { payloadsAny, splitCard } from "../src/features/studio/split/cardSplit"
import { countVariableSpecs, looksLikeLorecard, lorecardToCard } from "../src/features/studio/split/lorecard"

const outDir = process.argv[2]
if (!outDir) {
  console.error("usage: bun scripts/gen_studio_export_fixture.ts <out-dir>")
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

const project = newProject("回廊公寓")
project.description = "一栋只在雨夜出现第五层的公寓。"
project.scenario = "调查员受托寻找失踪的房客。"
project.firstMes = "雨声里，公寓的门牌忽明忽暗。"
project.alternateGreetings = ["你在五层的楼梯间醒来。"]
project.creatorNotes = "roundtrip fixture"
project.tags = "调查, 都市怪谈"

const sanity = newVariable()
sanity.id = "理智"
sanity.kind = "number"
sanity.labelEn = "Sanity"
sanity.labelZh = "理智"
sanity.minimum = "0"
sanity.maximum = "100"
sanity.defaultValue = "80"
const truth = newVariable()
truth.id = "真相进度"
truth.kind = "number"
truth.labelEn = "Truth"
truth.labelZh = "真相进度"
truth.visibility = "keeper"
truth.minimum = "0"
truth.maximum = "5"
truth.defaultValue = "0"
project.variables = [sanity, truth]

const rules = newLoreEntry()
rules.title = "五层的规则"
rules.content = "五层只在雨夜出现。"
rules.keys = "五层, 雨夜"
rules.constant = true
const adminSecret = newLoreEntry()
adminSecret.title = "管理员的秘密"
adminSecret.content = "管理员早已不是人类。"
adminSecret.keys = "管理员"
adminSecret.secret = true
adminSecret.constant = true
const roster = newLoreEntry()
roster.title = "住户名册"
roster.content = "名册末页有一行湿掉的字。"
roster.keys = "名册"
roster.secondaryKeys = "末页"
roster.condition = "世界.日 >= 2"
project.lorebook = [rules, adminSecret, roster]

const persona = newProject("林晚")
persona.description = "回廊公寓三层的房客，总在暗房里待到深夜的摄影师。"
persona.firstMes = "暗房的红灯下，林晚把一张新照片夹上晾绳。"
const camera = newLoreEntry()
camera.title = "林晚的相机"
camera.content = "那台老式胶片机拍下的第五层，比记忆里多一扇窗。"
camera.keys = "相机, 照片"
persona.lorebook = [camera]

for (const each of [project, persona]) {
  const validation = validateProject(each)
  if (validation.issueCount > 0) {
    console.error(`${each.name} does not validate:`, JSON.stringify(validation.project))
    process.exit(1)
  }
}
const specs = validateProject(project).specs
const releaseCard = exportSillyTavernCard(project, specs, { includeSecret: true })

const files: Record<string, Uint8Array> = {
  "world.lorecard.json": new TextEncoder().encode(
    JSON.stringify(exportNativeBundle(project, specs), null, 2) + "\n",
  ),
  "world.safe.st.json": new TextEncoder().encode(
    JSON.stringify(exportSillyTavernCard(project, specs), null, 2) + "\n",
  ),
  "world.release.st.json": new TextEncoder().encode(JSON.stringify(releaseCard, null, 2) + "\n"),
  "world.release.png": embedCardIntoPng(new Uint8Array(Buffer.from(PNG_1X1, "base64")), releaseCard),
  "character.st.json": new TextEncoder().encode(
    JSON.stringify(exportSillyTavernCard(persona, validateProject(persona).specs), null, 2) + "\n",
  ),
}

/** What Studio's own reader makes of one exported file — the pack bench's pipeline. */
async function studioReading(bytes: Uint8Array, fileName: string) {
  let card: StCharacterCard
  let typedVariables = 0
  const text = fileName.endsWith(".json") ? new TextDecoder().decode(bytes) : null
  const parsed: unknown = text === null ? null : JSON.parse(text)
  if (looksLikeLorecard(parsed)) {
    card = lorecardToCard(parsed as Record<string, unknown>).card
    typedVariables = countVariableSpecs(parsed as Record<string, unknown>)
  } else {
    card = await parseCardBytes(bytes, fileName)
  }
  const split = splitCard(card)
  return {
    name: card.name,
    kind: payloadsAny(split.payloads) || typedVariables > 0 ? "world" : "character",
    entries: card.characterBook.length,
    kept: split.character.characterBook.length,
    declarations: split.payloads.initvarEntries,
    secret: split.payloads.secretEntries,
    moduleVariables: typedVariables,
  }
}

const expect: Record<string, unknown> = {}
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(outDir, name), bytes)
  expect[name] = await studioReading(bytes, name)
}
writeFileSync(join(outDir, "expect.json"), JSON.stringify(expect, null, 2) + "\n")
console.log(`wrote ${Object.keys(files).length} card exports to ${outDir}`)
