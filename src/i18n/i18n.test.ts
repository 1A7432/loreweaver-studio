import { describe, expect, it } from "vitest"
import en from "./locales/en.json"
import zh from "./locales/zh.json"

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key))
}

describe("locale resources", () => {
  it("en and zh declare exactly the same key set", () => {
    expect(keyPaths(zh).sort()).toEqual(keyPaths(en).sort())
  })

  it("no locale value is empty", () => {
    for (const locale of [en, zh]) {
      const leaves = keyPaths(locale)
      expect(leaves.length).toBeGreaterThan(0)
      const flat = JSON.stringify(locale)
      expect(flat).not.toContain('""')
    }
  })
})
