import { describe, expect, it } from "vitest"
import { newLoreEntry, newProject, newVariable } from "../model"
import { auditContract, emptyContract, type CardContract } from "./contract"

describe("auditContract", () => {
  it("reports contract targets deleted from the project as missing", () => {
    const project = newProject("卡")
    const contract: CardContract = {
      slots: [{ stage: "worldview", slot: "wv:0", kind: "lore", target: "gone-uid", label: "worldview" }],
      confirmedAt: { worldview: 1 },
    }
    const audit = auditContract(project, contract, false)
    expect(audit.missing).toHaveLength(1)
    expect(audit.missing[0].slot).toBe("wv:0")
  })

  it("reports hand-added pieces as untracked (informational)", () => {
    const project = newProject("卡")
    const manualLore = newLoreEntry()
    const manualVar = newVariable()
    project.lorebook = [manualLore]
    project.variables = [manualVar]
    const audit = auditContract(project, emptyContract(), false)
    expect(audit.untrackedLore).toEqual([manualLore.uid])
    expect(audit.untrackedVariables).toEqual([manualVar.uid])
  })

  it("marks a stage stale when ANY upstream stage re-confirmed after it", () => {
    const contract: CardContract = {
      slots: [],
      confirmedAt: { worldview: 500, basics: 200, npcs: 300 },
    }
    const audit = auditContract(newProject("卡"), contract, false)
    // worldview(500) is upstream of basics(200) and npcs(300) → both stale.
    expect(audit.staleStages).toEqual(["basics", "npcs"])
  })

  it("ignores nsfw ordering when the toggle is off, honors it when on", () => {
    const contract: CardContract = {
      slots: [],
      confirmedAt: { nsfw: 100, npcs: 50 },
    }
    expect(auditContract(newProject("卡"), contract, false).staleStages).toEqual([])
    expect(auditContract(newProject("卡"), contract, true).staleStages).toEqual(["npcs"])
  })
})
