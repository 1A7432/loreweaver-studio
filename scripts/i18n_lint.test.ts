import { describe, expect, it } from "vitest"
import { scanSource } from "./i18n_lint"

/** The rules, stated as the regressions they exist to catch. */
describe("i18n lint rules", () => {
  it("flags a hardcoded CJK placeholder — the exact 2026-08-08 regression", () => {
    const findings = scanSource("src/x.tsx", `export const F = () => <input placeholder="顾晚棠" />\n`)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ line: 1, rule: "cjk", snippet: "顾晚棠" })
  })

  it("flags English prose in a text-bearing attribute", () => {
    const findings = scanSource(
      "src/x.tsx",
      `export const F = () => <input placeholder="the keeper's own name" />\n`,
    )
    expect(findings.map((f) => f.rule)).toEqual(["english"])
  })

  it("flags CJK and English prose in JSX text", () => {
    const findings = scanSource("src/x.tsx", `export const F = () => <p>模组说明</p>\n`)
    expect(findings.map((f) => f.rule)).toEqual(["cjk"])
    const english = scanSource("src/x.tsx", `export const F = () => <p>pick a module</p>\n`)
    expect(english.map((f) => f.rule)).toEqual(["english"])
  })

  it("accepts text that went through t()", () => {
    const source = `export const F = () => <input placeholder={t("studio.pack.name")} />\n`
    expect(scanSource("src/x.tsx", source)).toEqual([])
  })

  it("accepts ids, slugs, paths and mimes — English source is full of them", () => {
    const source = [
      `const id = "gu-wantang"`,
      `const path = "assets/cover.png"`,
      `const mime = "image/png"`,
      `export const F = () => <input placeholder="chao-yong" className="field field-narrow" />`,
      ``,
    ].join("\n")
    expect(scanSource("src/x.ts", source)).toEqual([])
  })

  it("accepts attributes that are not rendered as text", () => {
    const source = `export const F = () => <input aria-describedby="a note about the field" />\n`
    expect(scanSource("src/x.tsx", source)).toEqual([])
  })

  it("accepts authored bilingual CONTENT — the *En / *Zh field pair", () => {
    const source = [
      `const entry = {`,
      `  descriptionEn: "Room hooks extracted from the card.",`,
      `  descriptionZh: "从卡里抽取的房间 hooks。",`,
      `}`,
      ``,
    ].join("\n")
    expect(scanSource("src/x.ts", source)).toEqual([])
  })

  it("honours the marker on the literal's line and in the comment block above", () => {
    const sameLine = `export const F = () => <p>模组说明</p> // i18n-exempt: sample\n`
    expect(scanSource("src/x.tsx", sameLine)).toEqual([])
    const blockAbove = [
      `export const F = () => (`,
      `  <input`,
      `    // i18n-exempt: a YAML sample — code, and the reason needs`,
      `    // two lines to say, which is the case this branch covers.`,
      `    placeholder={"title: {en: HUD, zh: 状态板}"}`,
      `  />`,
      `)`,
      ``,
    ].join("\n")
    expect(scanSource("src/x.tsx", blockAbove)).toEqual([])
  })

  it("does not let a marker leak past the comment block to unrelated code", () => {
    const source = [
      `// i18n-exempt: applies to the line right below only`,
      `const sample = "title: {en: HUD, zh: 状态板}"`,
      `export const F = () => <input placeholder="顾晚棠" />`,
      ``,
    ].join("\n")
    expect(scanSource("src/x.tsx", source).map((f) => f.line)).toEqual([3])
  })

  it("ignores comments and regex literals — CJK prose and detection patterns", () => {
    const source = [
      `// 拆卡: world machinery never rides a player import.`,
      `const re = /似乎|仿佛/g`,
      ``,
    ].join("\n")
    expect(scanSource("src/x.ts", source)).toEqual([])
  })
})
