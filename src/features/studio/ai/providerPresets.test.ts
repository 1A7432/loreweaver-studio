import { describe, expect, it } from "vitest"
import { matchProviderPreset, PROVIDER_PRESETS } from "./providerPresets"

describe("provider presets", () => {
  it("ships the documented endpoints", () => {
    const deepseek = PROVIDER_PRESETS.find((p) => p.id === "deepseek")!
    expect(deepseek.kind).toBe("openai")
    expect(deepseek.baseUrl).toBe("https://api.deepseek.com/v1")
    expect(deepseek.models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"])
    const anthropic = PROVIDER_PRESETS.find((p) => p.id === "anthropic")!
    expect(anthropic.kind).toBe("anthropic")
  })

  it("recognizes the current settings, tolerating trailing slashes", () => {
    expect(matchProviderPreset("https://api.deepseek.com/v1", "openai")).toBe("deepseek")
    expect(matchProviderPreset("https://api.deepseek.com/v1/", "openai")).toBe("deepseek")
    expect(matchProviderPreset("https://api.openai.com/v1", "openai")).toBe("openai")
    expect(matchProviderPreset("https://api.anthropic.com", "anthropic")).toBe("anthropic")
    // kind mismatch or an unknown endpoint is "custom"
    expect(matchProviderPreset("https://api.deepseek.com/v1", "anthropic")).toBe("custom")
    expect(matchProviderPreset("https://my-proxy.local/v1", "openai")).toBe("custom")
    expect(matchProviderPreset("", "openai")).toBe("custom")
  })
})
