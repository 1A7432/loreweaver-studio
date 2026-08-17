import { describe, expect, it } from "vitest"
import { detectLanguage } from "./index"
import en from "./locales/en.json"
import zh from "./locales/zh.json"

/** Every studio source file, as text. Vite resolves this at transform time, so
 * the test needs no filesystem access of its own. */
const STUDIO_SOURCES: Record<string, string> = import.meta.glob("../features/studio/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
})

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key))
}

describe("detectLanguage", () => {
  it("prefers a stored locale over the navigator", () => {
    expect(detectLanguage("zh", "en-US")).toBe("zh")
    expect(detectLanguage("en", "zh-CN")).toBe("en")
  })

  it("treats a missing or non-string navigator.language as English", () => {
    expect(detectLanguage(null, undefined)).toBe("en")
    expect(detectLanguage(null, null)).toBe("en")
  })

  it("maps a zh* navigator language to zh", () => {
    expect(detectLanguage(null, "zh-CN")).toBe("zh")
    expect(detectLanguage(null, "zh")).toBe("zh")
  })
})

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

  it("every Issue key a reader can emit has a message under studio.pack.err", () => {
    // Issue keys are looked up dynamically (`t(\`studio.pack.err.${issue.key}\`)`),
    // so the i18n lint — which reads literals at their call sites — cannot see
    // them, and a missing one renders as its own raw key in the panel. That is
    // how `rulepackInitiativeString` shipped with no message at all. This walks
    // the readers instead: every `{ key: "…" }` an Issue is built from must
    // resolve.
    // Both Issue namespaces: the forge renders `studio.err.*`, the pack bench
    // `studio.pack.err.*`, and a reader shared by the two may land in either.
    const messages = new Set([...Object.keys(en.studio.err), ...Object.keys(en.studio.pack.err)])
    const emitted = new Set<string>()
    for (const [path, text] of Object.entries(STUDIO_SOURCES)) {
      if (/\.test\.tsx?$/.test(path)) continue
      // An Issue literal is `{ key }` or `{ key, params }` and nothing else —
      // that shape is what separates it from the many `{ key, label, … }`
      // descriptors elsewhere in the tree.
      for (const match of text.matchAll(/\{\s*key:\s*"([A-Za-z0-9_]+)"\s*(?:\}|,\s*params:)/g)) {
        emitted.add(match[1])
      }
    }
    expect(emitted.size).toBeGreaterThan(20)
    expect([...emitted].filter((key) => !messages.has(key)).sort()).toEqual([])
  })
})
