import { describe, expect, it } from "vitest"
import { applyTheme, DEFAULT_THEME, themeOrder, themes, tokenVar } from "./themes"

describe("themes", () => {
  it("carries all five TUI palettes with lamplight leading as the default", () => {
    expect(themeOrder).toHaveLength(5)
    expect(themeOrder[0]).toBe("lamplight")
    expect(DEFAULT_THEME).toBe("lamplight")
    // The identity tokens from the TUI design brief.
    expect(themes.lamplight.bg).toBe("#17130E")
    expect(themes.lamplight.fg).toBe("#E7D8B5")
    expect(themes.lamplight.accent).toBe("#D19A3E")
    for (const name of themeOrder) {
      expect(Object.keys(themes[name])).toHaveLength(19)
    }
  })

  it("maps palette keys to kebab-case custom properties", () => {
    expect(tokenVar("bg")).toBe("--lw-bg")
    expect(tokenVar("hpFull")).toBe("--lw-hp-full")
    expect(tokenVar("sanLow")).toBe("--lw-san-low")
  })

  it("applyTheme stamps tokens and the light/dark hint on <html>", () => {
    applyTheme("paperwhite")
    const root = document.documentElement
    expect(root.style.getPropertyValue("--lw-bg")).toBe("#f5f0e6")
    expect(root.dataset.lwTheme).toBe("paperwhite")
    expect(root.style.colorScheme).toBe("light")

    applyTheme("lamplight")
    expect(root.style.getPropertyValue("--lw-accent")).toBe("#D19A3E")
    expect(root.style.colorScheme).toBe("dark")
  })
})
