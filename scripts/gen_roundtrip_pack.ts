// Builds the cross-repo round-trip PACK tree: a full-surface module pack laid
// out by the REAL `buildPackSourcePlan` from the REAL studio exporters
// (`exportNativeBundle` v1, `exportSillyTavernCard` release flavor). Nothing
// here is hand-written pack.yaml — the point is pinning the studio's emission
// against the engine's real parsers (`python -m app --pack <dir> --json`), so
// a drift on either side breaks `scripts/check_roundtrip.sh`.
//
//   bun scripts/gen_roundtrip_pack.ts <out-dir>
//
// Writes `<out-dir>/corridor-apartment/` — the source tree the engine builds.
// The synthetic module is the same neutral "回廊公寓" world as the lorecard
// fixture, extended with every content kind manifest v2 can carry.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { exportNativeBundle, exportSillyTavernCard } from "../src/features/studio/exporters"
import { embedCardIntoPng } from "../src/features/studio/pngCard"
import { newLoreEntry, newProject, newVariable, validateProject } from "../src/features/studio/model"
import {
  buildPackSourcePlan,
  validatePackDraft,
  type WorldPackDraft,
} from "../src/features/studio/split/packSource"

// The stage-E rules-script lane needs the engine's OPTIONAL `ejs` extra
// (QuickJS): `parse_rulepack_text` builds a `RulesScriptEngine` at BUILD time,
// so shipping the script rulepack unconditionally would break the gate on a
// plain `uv sync`. `check_roundtrip.sh` probes the engine and sets this; when
// it is off the lane is left out and the gate SAYS so rather than quietly
// covering less.
const RULES_SCRIPT_LANE = process.env.RULES_SCRIPT_LANE === "1"

const outDir = process.argv[2]
if (!outDir) {
  console.error("usage: bun scripts/gen_roundtrip_pack.ts <out-dir>")
  process.exit(2)
}

// 1×1 transparent PNG. The engine's pack build takes MIME from the file
// EXTENSION (`mimetypes.guess_type` in `core/pack.py` — no byte sniffing),
// but shipping a real decodable picture keeps the tree honest for any future
// sniffing and for image panels that actually render it.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

// One well-formed silent MP3 frame (ID3v2.3 tag header + one MPEG-1 Layer III
// frame: sync + 128 kbps / 44.1 kHz header, 417 bytes total). See the PNG note
// — the engine maps `.mp3` → `audio/mpeg` by extension; these bytes are for
// good faith, not for passing a sniff that does not exist.
function tinyMp3Base64(): string {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)])
  return Buffer.concat([id3, frame]).toString("base64")
}

// --- the world card (lorecard v1, must DETECT as kind: world) ---------------
// World machinery: top-level hooks + typed variable specs + a secret entry —
// all three signals `core.pack._validate_card_bytes` folds into
// `detect_world_payloads`.

const world = newProject("回廊公寓")
world.description = "一栋只在雨夜出现第五层的公寓。"
world.scenario = "调查员受托寻找失踪的房客。"
world.firstMes = "雨声里，公寓的门牌忽明忽暗。"
world.alternateGreetings = ["你在五层的楼梯间醒来。"]
world.creatorNotes = "roundtrip pack fixture"
world.tags = "调查, 都市怪谈"
world.hooks = `// 回廊公寓 room hooks — the fifth floor breathes.
on('variables_changed', () => {
  const truth = getvar('真相进度')
  if (typeof truth === 'number' && truth >= 3) {
    narrate('楼梯间的灯开始一闪一灭。')
  }
})
`

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
world.variables = [sanity, truth]

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
world.lorebook = [rules, adminSecret, roster]

const worldValidation = validateProject(world)
if (worldValidation.issueCount > 0) {
  console.error("world card project does not validate:", JSON.stringify(worldValidation.project))
  process.exit(1)
}
const worldCardText = JSON.stringify(exportNativeBundle(world, worldValidation.specs), null, 2) + "\n"

// --- the character card (ST release flavor, must DETECT as kind: character) --
// No variables, no hooks, no secret/conditioned lore: `detect_world_payloads`
// must find nothing.

const character = newProject("林晚")
character.description = "回廊公寓三层的房客，总在暗房里待到深夜的摄影师。"
character.personality = "安静，观察入微，不轻易相信肉眼所见。"
character.scenario = "林晚似乎在冲洗的照片里看到了不存在的第五层。"
character.firstMes = "暗房的红灯下，林晚把一张新照片夹上晾绳：「你也能看见这层吗？」"
character.creatorNotes = "roundtrip pack fixture"
character.tags = "调查, 都市怪谈"
character.hooks = ""
const camera = newLoreEntry()
camera.title = "林晚的相机"
camera.content = "那台老式胶片机拍下的第五层，比记忆里多一扇窗。"
camera.keys = "相机, 照片"
camera.constant = true
character.lorebook = [camera]

const characterValidation = validateProject(character)
if (characterValidation.issueCount > 0) {
  console.error("character card project does not validate:", JSON.stringify(characterValidation.project))
  process.exit(1)
}
const characterCard = exportSillyTavernCard(character, characterValidation.specs)
const characterCardText = JSON.stringify(characterCard, null, 2) + "\n"

// --- the lorebook -----------------------------------------------------------
// The studio has no standalone lorebook exporter — the pack wizard ships a
// dropped ST world-info file verbatim — so this file reuses the worldbook
// section of a REAL `exportSillyTavernCard` emission (a lore-only project:
// no variables, so no [InitVar] entry): the exact shape the wizard accepts on
// drop and `core.pack._validate_lorebook_bytes` parses.

const notices = newProject("公寓布告栏")
notices.description = "公寓公共区域的告示与传闻。"
const waterNotice = newLoreEntry()
waterNotice.title = "停水通知"
waterNotice.content = "每逢雨夜，五层以上暂停供水。"
waterNotice.keys = "通知, 停水"
waterNotice.constant = true
const elevatorNotice = newLoreEntry()
elevatorNotice.title = "电梯维修"
elevatorNotice.content = "电梯按钮没有五层，请勿在轿厢内谈论五层。"
elevatorNotice.keys = "电梯"
elevatorNotice.secondaryKeys = "维修"
notices.lorebook = [waterNotice, elevatorNotice]

const noticesValidation = validateProject(notices)
if (noticesValidation.issueCount > 0) {
  console.error("lorebook project does not validate:", JSON.stringify(noticesValidation.project))
  process.exit(1)
}
const noticesCard = exportSillyTavernCard(notices, noticesValidation.specs) as {
  data: { character_book: { entries: unknown[] } }
}
const lorebookText =
  JSON.stringify(
    {
      name: "公寓布告栏",
      description: notices.description,
      entries: noticesCard.data.character_book.entries,
    },
    null,
    2,
  ) + "\n"

// --- the world-flavored ST card (the OTHER world shape) ---------------------
// The world lorecard above is the NATIVE shape. This is the same machinery in
// a stock SillyTavern card: an `[InitVar]` declaration entry, a hooks
// extension, and an `<% … %>` EJS span in the prose. `core.pack` must detect
// all three (`kind: world`, `has_hooks`, `has_ejs`) from the ST shape too — the
// gate had no ST-flavored world card before, so engine-side world detection on
// this path was never exercised.

const stWorldCardText =
  JSON.stringify(
    {
      spec: "chara_card_v3",
      spec_version: "3.0",
      data: {
        name: "管理员",
        description: "公寓的管理员。今晚的雨势 <%= getvar('理智') %> 分。",
        personality: "沉默，答非所问。",
        scenario: "值班室的灯彻夜亮着。",
        first_mes: "「五层？这栋楼只有四层。」",
        creator_notes: "roundtrip pack fixture — ST-flavored world card",
        tags: ["调查", "都市怪谈"],
        extensions: {
          loreweaver_hooks: [
            "on('turn_start', () => { if (Number(getvar('值班')) > 0) narrate('值班室的灯闪了一下。') })",
          ],
        },
        character_book: {
          entries: [
            {
              id: 0,
              comment: "[InitVar]",
              content: '{"值班": [1, "管理员是否在岗 [0,1]"]}',
              keys: [],
              constant: true,
              enabled: true,
            },
            {
              id: 1,
              comment: "值班室",
              content: "值班室的窗永远蒙着水汽。",
              keys: ["值班室"],
              enabled: true,
            },
          ],
        },
      },
    },
    null,
    2,
  ) + "\n"

// --- the PNG-embedded card --------------------------------------------------
// `embedCardIntoPng` writes the `chara` (V2) and `ccv3` (V3) tEXt chunks into a
// real PNG. Nothing had ever pushed one of those through the ENGINE's parser,
// so the studio's chunk writer and `core.pack`'s reader had never met.

const linWanPngBase64 = Buffer.from(
  embedCardIntoPng(Buffer.from(PNG_1X1, "base64"), characterCard as Record<string, unknown>),
).toString("base64")

// --- skill / rulepack patch / panels / presentation -------------------------

const SKILL_MD = `---
name: Corridor Procedures
description: Keeper procedures for the fifth floor of 回廊公寓.
metadata:
  scope: room
---

# Corridor Procedures

When the investigators ask the administrator about the fifth floor, consult
真相进度 before answering — below 3 the administrator deflects, at 3 and
above the stairwell lights flicker on their own.

## On any fumbled roll

Narrate the hallway growing one door longer; never name the fifth floor.
`

const SKILL_HOOKS = `// Fifth-floor presence: the stairwell reacts as the truth advances.
on('variables_changed', () => {
  const truth = getvar('真相进度')
  if (typeof truth === 'number' && truth >= 3) {
    narrate('楼梯间的灯开始一闪一灭。')
  }
})
`

// One prep-phase plan script. `plan(tool, args)` is the only callable the
// sandbox exposes (`core/prep_script.py::_PRELUDE`); the keeper runs it by
// reference and previews the whole operation list before anything applies.
const PREP_SCRIPT = `// 回廊公寓 — bulk prep for the fifth-floor witnesses.
const witnesses = ["门房老周", "巡夜的李七", "更夫赵三"]
for (const name of witnesses) {
  plan("add_npc", { name: name, concept: "夜里见过五层的人" })
}
plan("define_variable", { var_id: "floor_seen", kind: "number", minimum: 0, maximum: 3 })
`

// A house-rules patch over the engine's built-in CoC7 rulepack (`extends:`
// resolves through `core.rulepacks.load_raw_rulepack_yaml` at pack build).
const RULEPACK_YAML = `# 回廊公寓 house rules — a patch over the built-in CoC7 rulepack.
extends: coc7
defaults:
  理智: 45
`

// A THIRD-PARTY-shaped rulepack carrying a stage-E rules script. Bundled packs
// stay DSL-only by doctrine (`core/rules_script.py`), so the script lane only
// ever ships the way an extension pack ships it — which is exactly why the gate
// has to build one: `has_rules_script` was pinned false and the shape was never
// exercised. The engine pre-rolls every die and hands the script plain JSON; it
// cannot roll, and its return is validated and clamped before anything applies.
const SCRIPT_RULEPACK_YAML = `# 回廊公寓 — the stairwell's own ladder (stage-E script lane).
names: [corridor-fate]
set_keys: [corridor-fate]
defaults:
  胆识: 2
  谨慎: 1
resolution:
  version: 1
  roll: 2d6
  target: dc
  compare: ">="
  script: corridor-resolver.js
labels:
  en:
    climb: [Climb]
    hold: [Hold]
    fall: [Fall]
  zh:
    climb: [登楼]
    hold: [驻足]
    fall: [坠落]
`

const RULES_SCRIPT_JS = `// One resolve(input) → rank. No callables, no state: the engine pre-rolls the
// dice, serializes them in as plain JSON, and validates everything coming back.
function resolve(input) {
  var target = input.target === null ? 7 : input.target
  var doubled = input.dice.length === 2 && input.dice[0] === input.dice[1]
  if (input.roll >= target) {
    return { rank: { id: "climb", tier: 2, success: true, critical: doubled }, margin: input.roll - target }
  }
  if (input.roll === target - 1) {
    return { rank: { id: "hold", tier: 1 }, margin: input.roll - target }
  }
  return { rank: { id: "fall", tier: 0, fumble: true }, margin: input.roll - target }
}
`

const PANELS_YAML = `panels:
  - id: handouts
    title: {en: Handouts, zh: 手边物}
    slot: tray
    blocks:
      - {kind: image, src: ui/handouts/page.png, caption: {en: "A torn directory page", zh: 撕下的名册页}, alt: {en: "The fifth floor, listed", zh: 名册上的五层}}
      - {kind: letter, body: {en: "Meet me on the fifth floor when it rains.", zh: 雨夜来五层找我。}, from: {en: "Room 502", zh: 502室}, date: {en: "undated", zh: 无日期}}
      - {kind: clipping, headline: {en: "Tenant missing for a week", zh: 房客失踪一周}, body: {en: "The administrator claims no such tenant exists.", zh: 管理员称查无此人。}, source: {en: "Corridor Gazette", zh: 回廊小报}}
      - {kind: map_pin, src: ui/handouts/stairwell.png, label: {en: "Stairwell B", zh: B栋楼梯间}, x: 0.25, y: {$var: 真相进度}, note: {en: "last seen here", zh: 最后出现处}}
      - {kind: title_card, title: {en: "The Fifth Floor", zh: 第五层}, act: {en: "Act II", zh: 第二幕}}
      - {kind: text, style: warning, visible_when: "真相进度 >= 3", text: {en: "The elevator no longer stops at four.", zh: 电梯不再停在四层。}}
      - repeat: {prefix: "线索.", block: {kind: badge, label: {$leaf: label}, visible_when: "真相进度 >= 1"}}
  - id: case-board
    title: {en: Case Board, zh: 案情板}
    slot: modal
    audience: keeper
    entry: ui/case-board/index.html
    assets:
      - ui/case-board/index.html
      - ui/case-board/app.js
    fallback:
      - {kind: letter, body: {en: "The board needs a rich client.", zh: "案情板需要富客户端。"}, from: {en: "Studio", zh: 工作室}}
`

const CASE_BOARD_HTML = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>案情板</title>
  </head>
  <body>
    <main id="board">案情板加载中…</main>
    <script src="app.js"></script>
  </body>
</html>
`

const CASE_BOARD_JS = `document.getElementById("board").textContent = "案情板（富客户端）"
`

const draft: WorldPackDraft = {
  id: "corridor-apartment",
  version: "1.0.0",
  nameEn: "Corridor Apartment",
  nameZh: "回廊公寓",
  descriptionEn: "An apartment that grows a fifth floor on rainy nights.",
  descriptionZh: "一栋只在雨夜出现第五层的公寓。",
  authors: ["Loreweaver Studio"],
  license: "CC-BY-4.0",
  cards: [
    {
      fileName: "corridor-apartment.lorecard.json",
      jsonText: worldCardText,
      notesEn: "Import as world; exposes 理智 / 真相进度.",
      notesZh: "以世界卡导入；暴露「理智 / 真相进度」。",
    },
    {
      fileName: "lin-wan.st.json",
      jsonText: characterCardText,
      notesEn: "",
      notesZh: "",
    },
    {
      fileName: "administrator.st.json",
      jsonText: stWorldCardText,
      notesEn: "Import as world; the ST-flavored half of the module.",
      notesZh: "以世界卡导入；模组的 ST 形态那一半。",
    },
    {
      // The same character, embedded in a PNG — the shape a community editor
      // hands around, and the one path the gate never covered.
      fileName: "lin-wan.png",
      base64: linWanPngBase64,
      notesEn: "",
      notesZh: "",
    },
  ],
  lorebooks: [{ fileName: "corridor-notices.json", jsonText: lorebookText }],
  skills: [
    {
      slug: "corridor-procedures",
      nameEn: "Corridor Procedures",
      descriptionEn: "Keeper procedures for the fifth floor.",
      descriptionZh: "五层的守秘人流程。",
      hooks: [SKILL_HOOKS],
      skillMd: SKILL_MD,
    },
  ],
  rulepacks: [
    { id: "corridor-rules", yamlText: RULEPACK_YAML },
    ...(RULES_SCRIPT_LANE
      ? [
          {
            id: "corridor-fate",
            yamlText: SCRIPT_RULEPACK_YAML,
            scripts: [{ fileName: "corridor-resolver.js", source: RULES_SCRIPT_JS }],
          },
        ]
      : []),
  ],
  assets: [{ fileName: "cover.png", base64: PNG_1X1 }],
  // M20 F prep-phase script (`contents.prep`): the engine's build checks it
  // statically (extension, the 20 000-char cap, UTF-8) and counts it on the
  // trust card. It never runs — not at build, not at install.
  prep: [{ fileName: "setup.js", source: PREP_SCRIPT }],
  // A one-shot pack: no installments, so the source tree is byte-identical to
  // what it was before serialized modules existed.
  episodes: [],
  panels: {
    yamlText: PANELS_YAML,
    files: [
      { path: "ui/handouts/page.png", base64: PNG_1X1 },
      { path: "ui/handouts/stairwell.png", base64: PNG_1X1 },
      { path: "ui/case-board/index.html", contents: CASE_BOARD_HTML },
      { path: "ui/case-board/app.js", contents: CASE_BOARD_JS },
    ],
  },
  presentation: {
    generation: "allow",
    // Kit v2 (`core/presentation.py::KIT_VERSION`): the templates allowlist
    // and style.palette. Both are exercised here so the gate would catch the
    // studio emitting a shape the engine's strict parser rejects.
    templates: ["image", "title_card"],
    keywordsEn: "rainy night, indigo hallway, film grain",
    keywordsZh: "雨夜, 靛青走廊, 胶片颗粒",
    bannedText: "text overlays\nmodern clothing",
    paletteText: "#16232e\nrain-slick indigo\nstairwell amber",
    subjects: [
      {
        uid: "subj-administrator",
        id: "the-administrator",
        kind: "npc",
        nameEn: "The Administrator",
        nameZh: "管理员",
        refFileName: "the-administrator.png",
        refBase64: PNG_1X1,
        prompt: "a gaunt figure behind the front desk, never quite facing the camera",
      },
    ],
    audio: [
      {
        uid: "cue-rain",
        id: "rain-on-stairwell",
        layer: "ambience",
        assetFileName: "rain-on-stairwell.mp3",
        assetBase64: tinyMp3Base64(),
        title: "雨落楼梯间",
      },
    ],
  },
}

// --- emit -------------------------------------------------------------------

const issues = validatePackDraft(draft)
if (issues.length > 0) {
  console.error("roundtrip pack draft does not validate:", JSON.stringify(issues, null, 2))
  process.exit(1)
}

const plan = buildPackSourcePlan(draft)
const root = join(outDir, plan.dirName)
rmSync(root, { recursive: true, force: true })
for (const file of plan.files) {
  const target = join(root, file.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, file.contents, "utf8")
}
for (const binary of plan.binaries) {
  const target = join(root, binary.path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, Buffer.from(binary.base64, "base64"))
}
console.log(`wrote ${root} (${plan.files.length} text files, ${plan.binaries.length} binary files)`)
