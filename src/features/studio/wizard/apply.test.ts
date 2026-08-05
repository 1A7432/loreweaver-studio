import { describe, expect, it } from "vitest"
import { newProject, validateProject } from "../model"
import { applyStage } from "./apply"
import { auditContract, emptyContract } from "./contract"
import { blankDraft, confirmBlocks, STAGE_ORDER, type StageDraft, type WizardLoreDraft } from "./stages"

function loreDraft(slot: string, patch: Partial<WizardLoreDraft> = {}): WizardLoreDraft {
  return {
    slot,
    title: `条目${slot}`,
    content: "内容。",
    keys: [],
    layer: "constant",
    secret: false,
    sourceLabel: "worldview",
    ...patch,
  }
}

describe("applyStage: lore upsert + incremental regeneration", () => {
  it("lands worldview entries and stamps the contract", () => {
    const { project, contract } = applyStage(
      newProject("卡"),
      emptyContract(),
      {
        stage: "worldview",
        path: "large",
        entries: [loreDraft("wv:0"), loreDraft("wv:1", { layer: "triggered", keys: ["港"] })],
      },
      1000,
    )
    expect(project.lorebook).toHaveLength(2)
    expect(project.lorebook[0].constant).toBe(true)
    expect(project.lorebook[1].keys).toBe("港")
    expect(contract.slots.filter((s) => s.stage === "worldview")).toHaveLength(2)
    expect(contract.confirmedAt.worldview).toBe(1000)
  })

  it("keeps the SAME uid for the same slot across regeneration, drops vanished slots", () => {
    const first = applyStage(
      newProject("卡"),
      emptyContract(),
      { stage: "worldview", path: "small", entries: [loreDraft("wv:0"), loreDraft("wv:1")] },
      1000,
    )
    const keptUid = first.contract.slots.find((s) => s.slot === "wv:0")?.target
    expect(keptUid).toBeDefined()

    const second = applyStage(
      first.project,
      first.contract,
      {
        stage: "worldview",
        path: "small",
        entries: [loreDraft("wv:0", { title: "改写后的标题", content: "重生成的内容。" })],
      },
      2000,
    )
    expect(second.project.lorebook).toHaveLength(1)
    expect(second.project.lorebook[0].uid).toBe(keptUid)
    expect(second.project.lorebook[0].title).toBe("改写后的标题")
    expect(second.contract.slots.filter((s) => s.stage === "worldview")).toHaveLength(1)
  })

  it("never touches another stage's entries when one stage regenerates", () => {
    let state = applyStage(
      newProject("卡"),
      emptyContract(),
      { stage: "worldview", path: "small", entries: [loreDraft("wv:0")] },
      1000,
    )
    state = applyStage(
      state.project,
      state.contract,
      { stage: "npcs", npcs: [{ name: "老陈", role: "船工", content: "欠钱。", keys: ["老陈"] }] },
      2000,
    )
    const npcUid = state.contract.slots.find((s) => s.slot === "npc:老陈")?.target
    state = applyStage(
      state.project,
      state.contract,
      { stage: "worldview", path: "small", entries: [loreDraft("wv:9", { title: "全新" })] },
      3000,
    )
    expect(state.project.lorebook.some((e) => e.uid === npcUid)).toBe(true)
    expect(state.project.lorebook.some((e) => e.title === "全新")).toBe(true)
    expect(state.project.lorebook).toHaveLength(2)
  })
})

describe("applyStage: fields, palette assembly, variables", () => {
  it("basics writes name/description/tags as contract-tracked fields", () => {
    const { project, contract } = applyStage(
      newProject(""),
      emptyContract(),
      { stage: "basics", name: "阿理", tags: ["渔村", "悬疑"], description: "疤从左眉切到颧骨。" },
      1000,
    )
    expect(project.name).toBe("阿理")
    expect(project.tags).toBe("渔村, 悬疑")
    expect(contract.slots.find((s) => s.slot === "field:name")?.label).toBe("阿理")
  })

  it("palette assembles personality with the handwritten derivations inline", () => {
    const { project } = applyStage(
      newProject("阿理"),
      emptyContract(),
      {
        stage: "palette",
        base: { name: "自卑", detail: "从不先开口。", derivation: "" },
        mains: [
          {
            name: "好胜",
            detail: "输了加练。",
            derivation: "码头比赛输了,当晚加练到手抽筋,嘴上说“正好活动”。",
          },
        ],
        accent: { name: "嘴硬", detail: "道谢说成“算你识相”。", derivation: "" },
      },
      1000,
    )
    expect(project.personality).toContain("core: 自卑")
    expect(project.personality).toContain("main: 好胜")
    expect(project.personality).toContain("手抽筋")
    expect(project.personality).toContain("accent: 嘴硬")
  })

  it("variables promotes InitVar YAML into typed variables and drafts hooks from rules", () => {
    const draft: StageDraft = {
      stage: "variables",
      initvarYaml: "理:\n  好感度: [0, '好感 [0,100]']\n  见过雾: [false, '旗标']\n",
      updateRules: "好感度:玩家帮忙 +5\n见过雾:进入雾区置 true",
    }
    const { project, contract } = applyStage(newProject("阿理"), emptyContract(), draft, 1000)
    expect(project.variables).toHaveLength(2)
    const meter = project.variables.find((v) => v.id.includes("好感") || v.labelZh.includes("好感"))
    expect(meter?.kind).toBe("number")
    expect(meter?.minimum).toBe("0")
    expect(meter?.maximum).toBe("100")
    expect(project.hooks).toContain("// 好感度:玩家帮忙 +5")
    expect(project.hooks).toContain("on('reply_ready'")
    expect(contract.slots.some((s) => s.slot.startsWith("var:"))).toBe(true)

    // Regeneration with one leaf gone: same-path uid survives, removed path is dropped.
    const again = applyStage(
      project,
      contract,
      { ...draft, initvarYaml: "理:\n  好感度: [10, '好感 [0,100]']\n" },
      2000,
    )
    expect(again.project.variables).toHaveLength(1)
    expect(again.project.variables[0].uid).toBe(
      contract.slots.find((s) => s.slot === `var:理.好感度`)?.target,
    )
    expect(again.project.variables[0].defaultValue).toBe("10")
  })
})

describe("blankDraft: the hand-first path exists for EVERY stage", () => {
  it("returns a matching editable draft per stage (no AI required anywhere)", () => {
    for (const stage of STAGE_ORDER) {
      const draft = blankDraft(stage, "large")
      expect(draft.stage).toBe(stage)
    }
  })

  it("keeps the worldview path and stays behind each stage's confirm gate", () => {
    const wv = blankDraft("worldview", "real")
    expect(wv.stage === "worldview" && wv.path).toBe("real")
    // Content-bearing stages block until filled; empty-is-valid stages don't.
    expect(confirmBlocks(blankDraft("basics", "small")).length).toBeGreaterThan(0)
    expect(confirmBlocks(blankDraft("variables", "small"))).toContain("yamlUnparseable")
    expect(confirmBlocks(blankDraft("npcs", "small"))).toEqual([])
    expect(confirmBlocks(blankDraft("wardrobe", "small"))).toEqual([])
  })
})

describe("confirmBlocks: the mandatory-manual gate", () => {
  it("blocks palette until every main color has a handwritten derivation", () => {
    const draft: StageDraft = {
      stage: "palette",
      base: { name: "自卑", detail: "", derivation: "" },
      mains: [{ name: "好胜", detail: "", derivation: "" }],
      accent: null,
    }
    expect(confirmBlocks(draft)).toContain("derivationRequired")
    draft.mains[0].derivation = "写了衍生闭环。"
    expect(confirmBlocks(draft)).toEqual([])
  })

  it("blocks exegesis/nsfw/variables on their own requirements", () => {
    expect(confirmBlocks({ stage: "exegesis", text: " " })).toContain("exegesisRequired")
    expect(confirmBlocks({ stage: "nsfw", motivation: "", entries: [] })).toContain("motivationRequired")
    expect(confirmBlocks({ stage: "variables", initvarYaml: "[broken", updateRules: "" })).toContain(
      "yamlUnparseable",
    )
    expect(confirmBlocks(null)).toContain("noDraft")
  })
})

describe("full wizard walk-through → packable card", () => {
  it("walks all eleven stages and lands a project that validates clean", () => {
    let state = { project: newProject(""), contract: emptyContract() }
    const walk = (draft: StageDraft, at: number) => {
      expect(confirmBlocks(draft)).toEqual([])
      state = applyStage(state.project, state.contract, draft, at)
    }

    walk(
      {
        stage: "worldview",
        path: "large",
        entries: [
          loreDraft("wv:0", { title: "雾港", content: "港雾三十年不散,渔汛靠敲钟传讯。" }),
          loreDraft("wv:1", {
            title: "灯塔",
            layer: "triggered",
            keys: ["灯塔"],
            content: "只亮半边,亮全的那晚死过人。",
          }),
        ],
      },
      1,
    )
    walk({ stage: "basics", name: "阿理", tags: ["渔村"], description: "疤从左眉切到颧骨,笑起来会歪。" }, 2)
    walk(
      {
        stage: "palette",
        base: { name: "自卑", detail: "从不先开口。", derivation: "" },
        mains: [
          { name: "好胜", detail: "输了加练。", derivation: "码头输了,当晚加练到手抽筋,嘴上说“正好活动”。" },
        ],
        accent: null,
      },
      3,
    )
    walk(
      {
        stage: "facets",
        facets: [
          {
            name: "白日的船工",
            trigger: "有外人在场",
            energy: "把日子过下去",
            voice: "短句,带咸味",
            body: "手不停",
            role: "谋生",
            bleed: "夜面的警觉从不放下",
          },
        ],
      },
      4,
    )
    walk({ stage: "exegesis", text: "她不是傲娇模板:她的嘴硬只对强者,对弱者从来直接。别写脸红。" }, 5)
    walk(
      {
        stage: "wardrobe",
        entries: [
          loreDraft("wd:0", {
            title: "工装",
            layer: "triggered",
            keys: ["工装"],
            content: "袖口磨破,左袋缝了刀鞘。",
            sourceLabel: "阿理",
          }),
        ],
      },
      6,
    )
    walk({ stage: "nsfw", motivation: "亲密对她是卸下值更的唯一方式——为什么,不是做什么。", entries: [] }, 7)
    walk(
      {
        stage: "npcs",
        npcs: [{ name: "老陈", role: "船工头", content: "欠她一条命,总想还。", keys: ["老陈"] }],
      },
      8,
    )
    walk({ stage: "overview", content: "阿理/船工/疤从左眉到颧骨/自卑底色+好胜主色/正在追查灯塔那晚。" }, 9)
    walk(
      {
        stage: "opening",
        firstMes: "钟敲了四下。阿理把缆绳绕上桩,头也不抬:“你站的地方,昨晚死过人。”",
        mesExample: "<START>\nuser: 你是谁?\nchar: “先把脚从血渍上挪开。”",
        alternateGreetings: ["涨潮那晚的另一个开场。", "  "],
      },
      10,
    )
    walk(
      {
        stage: "variables",
        initvarYaml: "阿理:\n  信任: [0, '信任 [0,10]']\n  灯塔线索: [0, '线索数 [0,5]']\n",
        updateRules: "信任:实质帮助 +1;撒谎被识破 -2",
      },
      11,
    )

    const validation = validateProject(state.project)
    expect(validation.issueCount).toBe(0)
    expect(state.project.lorebook.length).toBeGreaterThanOrEqual(7)
    expect(state.project.variables).toHaveLength(2)
    expect(state.project.firstMes).toContain("钟敲了四下")
    expect(state.project.mesExample).toContain("<START>")
    // Blank alternates are dropped at apply time.
    expect(state.project.alternateGreetings).toEqual(["涨潮那晚的另一个开场。"])

    const audit = auditContract(state.project, state.contract, true)
    expect(audit.missing).toEqual([])
    expect(audit.staleStages).toEqual([])
    expect(audit.untrackedLore).toEqual([])
  })
})
