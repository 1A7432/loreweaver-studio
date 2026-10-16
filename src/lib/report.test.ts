import { describe, expect, it } from "vitest"
import { safeReportName } from "./report"

const HASH = "ab".repeat(32)

describe("safeReportName", () => {
  it("keeps the engine's own names as they are", () => {
    expect(safeReportName("loreweaver-report-tide-20261016-120000.html", HASH)).toBe(
      "loreweaver-report-tide-20261016-120000.html",
    )
    expect(safeReportName("loreweaver-report-tide-20261016-120000-reveal.html", HASH)).toBe(
      "loreweaver-report-tide-20261016-120000-reveal.html",
    )
    expect(safeReportName("汐浦送灯 团报.html", HASH)).toBe("汐浦送灯 团报.html")
  })

  it("keeps only the base name, so a path can never climb out", () => {
    expect(safeReportName("../../etc/passwd", HASH)).toBe("passwd.html")
    expect(safeReportName("..\\..\\Windows\\win.ini", HASH)).toBe("win.ini.html")
    expect(safeReportName("/abs/dir/report.html", HASH)).toBe("report.html")
    expect(safeReportName("..", HASH)).toBe(`loreweaver-report-${HASH.slice(0, 12)}.html`)
  })

  it("drops controls and invisible bidi tricks, and defuses reserved characters", () => {
    expect(safeReportName("bell\u0007\nname.html", HASH)).toBe("bellname.html")
    expect(safeReportName("report\u202Elmth.exe", HASH)).toBe("reportlmth.exe.html")
    expect(safeReportName('a<b>:c"d|e?f*.html', HASH)).toBe("a-b--c-d-e-f-.html")
    expect(safeReportName("   .hidden.html  ", HASH)).toBe("hidden.html")
    expect(safeReportName("trailing. . .html", HASH)).toBe("trailing.html")
  })

  it("defuses Windows device names whatever their extension", () => {
    expect(safeReportName("CON.html", HASH)).toBe("_CON.html")
    expect(safeReportName("lpt1.report.html", HASH)).toBe("_lpt1.report.html")
    expect(safeReportName("console.html", HASH)).toBe("console.html")
  })

  it("always ends in .html, and falls back to the hash when nothing usable is left", () => {
    expect(safeReportName("notes.htm", HASH)).toBe("notes.html")
    expect(safeReportName("notes.HTML", HASH)).toBe("notes.html")
    expect(safeReportName("", HASH)).toBe(`loreweaver-report-${HASH.slice(0, 12)}.html`)
    expect(safeReportName("\u0000\u0001", "../NOT-HEX")).toBe("loreweaver-report-e.html")
    expect(safeReportName("", "zz")).toBe("loreweaver-report-untitled.html")
  })

  it("caps the name in bytes without cutting a character in half", () => {
    const long = safeReportName(`${"团".repeat(200)}.html`, HASH)
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(205)
    expect(long).toBe(`${"团".repeat(66)}.html`)
    // An emoji is a surrogate pair: never split, and a lone half is dropped.
    expect(safeReportName(`${"x".repeat(199)}😀.html`, HASH)).toBe(`${"x".repeat(199)}.html`)
    expect(safeReportName("half\ud800.html", HASH)).toBe("half.html")
  })
})
