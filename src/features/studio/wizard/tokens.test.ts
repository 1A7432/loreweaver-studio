import { describe, expect, it } from "vitest"
import { newLoreEntry, type ForgeLoreEntry } from "../model"
import { demoteAdvice, estimateTokens, layerReport } from "./tokens"

function entry(patch: Partial<ForgeLoreEntry>): ForgeLoreEntry {
  return { ...newLoreEntry(), ...patch }
}

describe("estimateTokens", () => {
  it("counts CJK chars as one token each and ASCII at ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("四个汉字")).toBe(4)
    expect(estimateTokens("abcdefgh")).toBe(2)
    // 3 CJK + 8 ASCII → 3 + 2
    expect(estimateTokens("汉字混ascii802")).toBe(3 + 2)
    expect(estimateTokens("句号。")).toBe(3)
  })
})

describe("layerReport", () => {
  it("splits enabled entries into constant vs triggered layers", () => {
    const report = layerReport([
      entry({ title: "常驻", content: "十个字十个字十个字十", constant: true }),
      entry({ title: "触发", content: "五个字五个", constant: false }),
      entry({ title: "禁用", content: "不计入的内容", constant: true, enabled: false }),
    ])
    expect(report.constantTokens).toBe(10)
    expect(report.triggeredTokens).toBe(5)
    expect(report.rows).toHaveLength(2)
  })
})

describe("demoteAdvice", () => {
  it("is empty under budget", () => {
    const report = layerReport([entry({ title: "小", content: "短", constant: true })])
    expect(demoteAdvice(report, 100)).toEqual([])
  })

  it("suggests the largest constant entries until the budget fits", () => {
    const report = layerReport([
      entry({ title: "大", content: "字".repeat(90), constant: true }),
      entry({ title: "中", content: "字".repeat(40), constant: true }),
      entry({ title: "小", content: "字".repeat(10), constant: true }),
      entry({ title: "触发不参与", content: "字".repeat(500), constant: false }),
    ])
    // 140 constant tokens, budget 60 → demote 大(90) → 50 fits.
    const advice = demoteAdvice(report, 60)
    expect(advice.map((a) => a.title)).toEqual(["大"])
    expect(advice[0].afterTokens).toBe(50)
  })
})
