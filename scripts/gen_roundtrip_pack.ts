// Builds the cross-repo round-trip PACK source tree: a pack that exercises every kind Studio
// can write, laid out by the REAL `buildPackSourcePlan` from the REAL studio exporters
// (`exportNativeBundle`, `exportSillyTavernCard`, `embedCardIntoPng`). Nothing here is a
// hand-written pack.yaml — the point is to pin Studio's emission against the 3.0 engine's
// real builder and installer (`scripts/check_roundtrip.sh`), so a drift on either side
// breaks the gate.
//
//   bun scripts/gen_roundtrip_pack.ts <out-dir>
//
// Writes `<out-dir>/corridor-apartment/` (the source tree) and `<out-dir>/expect.json`: what
// Studio believes about the pack — each card's kind as Studio's own detection decided it, the
// counts the engine's trust card must show — for the gate to assert against.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { exportNativeBundle, exportSillyTavernCard } from "../src/features/studio/exporters"
import { embedCardIntoPng } from "../src/features/studio/pngCard"
import { newLoreEntry, newProject, newVariable, validateProject } from "../src/features/studio/model"
import { parseCardBytes } from "../src/features/studio/split/charcard"
import { payloadsAny, splitCard } from "../src/features/studio/split/cardSplit"
import { countVariableSpecs, looksLikeLorecard, lorecardToCard } from "../src/features/studio/split/lorecard"
import {
  buildPackSourcePlan,
  validatePackDraft,
  type WorldPackDraft,
} from "../src/features/studio/split/packSource"

const outDir = process.argv[2]
if (!outDir) {
  console.error("usage: bun scripts/gen_roundtrip_pack.ts <out-dir>")
  process.exit(2)
}

// 1×1 transparent PNG: the engine checks a picture's bytes start the way a PNG starts.
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

// One silent MP3 frame behind an ID3v2.3 header: the engine's `audio/mpeg` signature check
// accepts an ID3 tag.
function tinyMp3Base64(): string {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)])
  return Buffer.concat([id3, frame]).toString("base64")
}

/** A card's kind as the pack bench decides it (`store/pack.ts` → `splitIntoItem`). */
async function studioKind(bytes: Uint8Array, fileName: string): Promise<"world" | "character"> {
  if (fileName.endsWith(".json")) {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (looksLikeLorecard(parsed)) {
      const raw = parsed as Record<string, unknown>
      const split = splitCard(lorecardToCard(raw).card)
      return payloadsAny(split.payloads) || countVariableSpecs(raw) > 0 ? "world" : "character"
    }
  }
  return payloadsAny(splitCard(await parseCardBytes(bytes, fileName)).payloads) ? "world" : "character"
}

// --- the world card (native lorecard, Studio's own export) ------------------
// World machinery: typed variable specs and a keeper-only (secret) entry.

const world = newProject("回廊公寓")
world.description = "一栋只在雨夜出现第五层的公寓。"
world.scenario = "调查员受托寻找失踪的房客。"
world.firstMes = "雨声里，公寓的门牌忽明忽暗。"
world.alternateGreetings = ["你在五层的楼梯间醒来。"]
world.creatorNotes = "roundtrip pack fixture"
world.tags = "调查, 都市怪谈"

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
const roster = newLoreEntry()
roster.title = "住户名册"
roster.content = "名册末页有一行湿掉的字。"
roster.keys = "名册"
roster.secondaryKeys = "末页"
roster.condition = "世界.日 >= 2"
world.lorebook = [rules, adminSecret, roster]

const worldValidation = validateProject(world)
if (worldValidation.issueCount > 0) {
  console.error("world card project does not validate:", JSON.stringify(worldValidation.project))
  process.exit(1)
}
const worldCardText = JSON.stringify(exportNativeBundle(world, worldValidation.specs), null, 2) + "\n"

// --- the character card (SillyTavern release flavor) -------------------------
// No variables, no secret or template: nothing the engine counts as world machinery.

const character = newProject("林晚")
character.description = "回廊公寓三层的房客，总在暗房里待到深夜的摄影师。"
character.personality = "安静，观察入微，不轻易相信肉眼所见。"
character.scenario = "林晚似乎在冲洗的照片里看到了不存在的第五层。"
character.firstMes = "暗房的红灯下，林晚把一张新照片夹上晾绳：「你也能看见这层吗？」"
character.creatorNotes = "roundtrip pack fixture"
character.tags = "调查, 都市怪谈"
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

// --- a world-flavored SillyTavern card, as an author drops it ----------------
// The OTHER world shape: an `[InitVar]` declaration entry, an EJS span in the prose and a
// 2.x hooks extension. The engine must count all three (and run none) and agree with
// Studio's detection that this is a world card.

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

// --- the PNG-embedded character card -----------------------------------------

const linWanPng = embedCardIntoPng(Buffer.from(PNG_1X1, "base64"), characterCard as Record<string, unknown>)
const linWanPngBase64 = Buffer.from(linWanPng).toString("base64")

// --- skill / rule-pack patch / module / panels / presentation -----------------

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
`

// A house-rules patch over the engine's built-in CoC 7e rule system.
const RULEPACK_YAML = `# 回廊公寓 house rules — a patch over the built-in CoC7 rule system.
extends: coc7
defaults:
  理智: 45
`

// The module: a stairwell tide the panels read (`corridor/tide`) and a bell they ring
// (`corridor/ring`). Studio writes this source and declares it; the builder bundles it.
const MODULE_SOURCE = `import { defineModule } from "loreweaver/module";

let level = 0;

export default defineModule({
  id: "corridor",
  create() { level = 0; },
  load(snapshot) { level = (snapshot as { level: number }).level; },
  save() { return { level }; },

  commands: {
    ring: {
      title: "Ring the bell",
      params: { type: "object", properties: { times: { type: "integer" } } },
      run(args) {
        level += Number(args.times ?? 1);
        return { text: "The bell rings in the stairwell." };
      },
    },
  },

  views: {
    tide: {
      title: "Stairwell tide",
      schema: { type: "object", properties: { level: { type: "integer" }, max: { type: "integer" } } },
      for: () => ({ level, max: 10 }),
    },
  },
});
`

// Panels 3.0: a template panel with a `repeat`, a `visible_when`, a picture, a module view
// and a choice that runs the module's command; and a page with a fallback.
const PANELS_YAML = `panels:
  - id: handouts
    title: {en: Handouts, zh: 手边物}
    slot: tray
    views: {me: me, tide: corridor/tide, vars: variables}
    blocks:
      - {kind: image, src: ui/handouts/page.png, caption: {en: "A torn directory page", zh: 撕下的名册页}}
      - {kind: meter, label: {en: Tide, zh: 潮位}, value: {$view: tide.level}, min: 0, max: {$view: tide.max}}
      - {kind: stat, label: {en: Name, zh: 姓名}, value: {$view: me.character.name}}
      - repeat:
          each: me.character.resources
          as: r
          block: {kind: meter, label: {$view: r.label}, value: {$view: r.value}, min: 0, max: {$view: r.max}}
      - kind: text
        style: warning
        visible_when: "vars.module.理智.value < 30"
        text: {en: "The elevator no longer stops at four.", zh: 电梯不再停在四层。}
      - kind: choices
        prompt: {en: Ring the bell?, zh: 敲钟吗？}
        options:
          - {id: ring, label: {en: Ring it, zh: 敲}, command: corridor/ring, args: {times: 2}}
      - {kind: title_card, title: {en: "The Fifth Floor", zh: 第五层}, act: {en: "Act II", zh: 第二幕}}
  - id: case-board
    title: {en: Case Board, zh: 案情板}
    slot: modal
    audience: admin
    views: {tide: corridor/tide}
    entry: ui/case-board/index.html
    fallback:
      - {kind: letter, body: {$view: tide.level}, from: {en: "Case board", zh: 案情板}}
`

const CASE_BOARD_HTML = `<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>案情板</title>
  </head>
  <body>
    <main id="board">案情板</main>
    <script>document.getElementById("board").textContent = "案情板（富客户端）"</script>
  </body>
</html>
`

const cards = [
  {
    fileName: "corridor-apartment.lorecard.json",
    jsonText: worldCardText,
    notesEn: "Import as the world.",
    notesZh: "以世界卡导入。",
  },
  { fileName: "lin-wan.st.json", jsonText: characterCardText, notesEn: "", notesZh: "" },
  {
    fileName: "administrator.st.json",
    jsonText: stWorldCardText,
    notesEn: "The ST-flavored half.",
    notesZh: "ST 形态的一半。",
  },
  { fileName: "lin-wan.png", base64: linWanPngBase64, notesEn: "", notesZh: "" },
]
const kinds: Record<string, "world" | "character"> = {}
for (const card of cards) {
  const bytes =
    card.jsonText !== undefined
      ? new TextEncoder().encode(card.jsonText)
      : new Uint8Array(Buffer.from(card.base64 as string, "base64"))
  kinds[`cards/${card.fileName}`] = await studioKind(bytes, card.fileName)
}

const draft: WorldPackDraft = {
  id: "corridor-apartment",
  version: "1.0.0",
  nameEn: "Corridor Apartment",
  nameZh: "回廊公寓",
  descriptionEn: "An apartment that grows a fifth floor on rainy nights.",
  descriptionZh: "一栋只在雨夜出现第五层的公寓。",
  authors: ["Loreweaver Studio"],
  license: "CC-BY-4.0",
  cards: cards.map((card) => ({ ...card, kind: kinds[`cards/${card.fileName}`] })),
  skills: [
    {
      slug: "corridor-procedures",
      nameEn: "Corridor Procedures",
      descriptionEn: "Keeper procedures for the fifth floor.",
      descriptionZh: "五层的守秘人流程。",
      skillMd: SKILL_MD,
    },
  ],
  rulepacks: [{ id: "corridor-rules", yamlText: RULEPACK_YAML }],
  modules: [{ uid: "module-corridor", id: "corridor", fileName: "corridor.ts", source: MODULE_SOURCE }],
  assets: [{ fileName: "cover.png", base64: PNG_1X1 }],
  episodes: [],
  panels: {
    yamlText: PANELS_YAML,
    files: [
      { path: "ui/handouts/page.png", base64: PNG_1X1 },
      { path: "ui/case-board/index.html", contents: CASE_BOARD_HTML },
    ],
  },
  presentation: {
    generation: "allow",
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

/** What the engine's trust card must say about this pack. */
const expect = {
  id: draft.id,
  version: draft.version,
  runsCode: true,
  modules: draft.modules.map((module) => module.id),
  ruleSystems: draft.rulepacks.map((rulepack) => rulepack.id),
  skills: draft.skills.map((skill) => skill.slug),
  cards: kinds,
  panels: { handouts: "template", "case-board": "page" },
  presentation: { subjects: 1, cues: 1 },
}
writeFileSync(join(outDir, "expect.json"), JSON.stringify(expect, null, 2) + "\n")
console.log(`wrote ${root} (${plan.files.length} text files, ${plan.binaries.length} binary files)`)
