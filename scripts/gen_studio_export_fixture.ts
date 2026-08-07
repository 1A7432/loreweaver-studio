// Regenerates the engine repo's `tests/fixtures/studio_export.lorecard.json`
// from the REAL `exportNativeBundle` — the pinned studio→engine round-trip
// contract (trpg_kp `tests/core/test_studio_export_fixture.py`). Never edit
// that fixture by hand.
//
//   bun scripts/gen_studio_export_fixture.ts <out-path>
//
// The synthetic project ("回廊公寓") is deliberately neutral and kept in sync
// with the other two studio_export fixtures (st.json / png).

import { writeFileSync } from "node:fs"
import { exportNativeBundle } from "../src/features/studio/exporters"
import { newLoreEntry, newProject, newVariable, validateProject } from "../src/features/studio/model"

const outPath = process.argv[2]
if (!outPath) {
  console.error("usage: bun scripts/gen_studio_export_fixture.ts <out-path>")
  process.exit(2)
}

const project = newProject("回廊公寓")
project.description = "一栋只在雨夜出现第五层的公寓。"
project.scenario = "调查员受托寻找失踪的房客。"
project.firstMes = "雨声里，公寓的门牌忽明忽暗。"
project.alternateGreetings = ["你在五层的楼梯间醒来。"]
project.creatorNotes = "roundtrip fixture"
project.tags = "调查, 都市怪谈"
project.hooks = "" // the fixture carries no hooks section

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
rules.priority = 10
rules.scanDepth = 4
rules.position = "after"
const adminSecret = newLoreEntry()
adminSecret.title = "管理员的秘密"
adminSecret.content = "管理员早已不是人类。"
adminSecret.keys = "管理员"
adminSecret.secret = true
adminSecret.constant = true
adminSecret.priority = 10
adminSecret.scanDepth = 4
adminSecret.position = "after"
const roster = newLoreEntry()
roster.title = "住户名册"
roster.content = "名册末页有一行湿掉的字。"
roster.keys = "名册"
roster.secondaryKeys = "末页"
roster.condition = "世界.日 >= 2"
roster.priority = 10
roster.scanDepth = 4
roster.position = "after"
project.lorebook = [rules, adminSecret, roster]

const validation = validateProject(project)
if (validation.issueCount > 0) {
  console.error("fixture project does not validate:", JSON.stringify(validation.project))
  process.exit(1)
}

const bundle = exportNativeBundle(project, validation.specs)
writeFileSync(outPath, JSON.stringify(bundle, null, 2) + "\n", "utf8")
console.log(`wrote ${outPath}`)
