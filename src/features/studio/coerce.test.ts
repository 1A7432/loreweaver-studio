import { describe, expect, it } from "vitest"
import { asText, isRecord, listOfStrings } from "./coerce"

describe("asText", () => {
  it("passes strings, stringifies scalars, blanks null-ish", () => {
    expect(asText("x")).toBe("x")
    expect(asText(3)).toBe("3")
    expect(asText(true)).toBe("true")
    expect(asText(null)).toBe("")
    expect(asText(undefined)).toBe("")
  })

  it("picks a readable locale from multilingual maps (engine-mirror behavior)", () => {
    expect(asText({ zh: "中文", de: "Deutsch" })).toBe("中文")
    expect(asText({ en: "English", zh: "中文" })).toBe("English")
    expect(asText({ fr: "seulement" })).toBe("seulement")
    expect(asText({ n: 1 })).toBe("")
  })
})

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord("x")).toBe(false)
  })
})

describe("listOfStrings", () => {
  it("accepts arrays, splitting nothing", () => {
    expect(listOfStrings(["a", "", "b", 3])).toEqual(["a", "b", "3"])
  })

  it("splits one string on newline, ASCII and CJK delimiters", () => {
    expect(listOfStrings("恐怖，悬疑、coc, horror\nmystery")).toEqual([
      "恐怖",
      "悬疑",
      "coc",
      "horror",
      "mystery",
    ])
    expect(listOfStrings("")).toEqual([])
    expect(listOfStrings(undefined)).toEqual([])
  })
})
