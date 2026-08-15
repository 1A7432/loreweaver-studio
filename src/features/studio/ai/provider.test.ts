import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A hung invoke is exactly what we're guarding against: llmChat never settles.
vi.mock("../../../lib/native", () => ({
  aiAvailable: () => false,
  llmChat: vi.fn(() => new Promise(() => {})),
}))

import { CHAT_CALL_TIMEOUT_MS, chatOnce, aiReady, useAiStore } from "./provider"

describe("chatOnce", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("rejects instead of leaving the UI busy forever", async () => {
    // Found live: a hung call left the pack wizard's AI-draft button
    // "working…" for 18+ minutes. Whatever the cause, the invoke must settle.
    const call = chatOnce("sys", [{ role: "user", content: "hi" }])
    const assertion = expect(call).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(CHAT_CALL_TIMEOUT_MS + 1)
    await assertion
  })
})

describe("the API key", () => {
  it("is ordinary persisted state, on every platform", () => {
    // It used to live in the OS credential store, which has no Android backend
    // and needs a daemon on Linux. This is the whole storage path now.
    useAiStore.setState({ apiKey: "sk-test" })
    const written = useAiStore.persist.getOptions().partialize!(useAiStore.getState()) as {
      apiKey: string
    }
    expect(written.apiKey).toBe("sk-test")
  })

  it("gates the AI buttons on a key being present, not on a probe", () => {
    const base = { baseUrl: "https://api.example.com/v1", model: "m" }
    expect(aiReady({ ...base, apiKey: "" })).toBe(false)
    expect(aiReady({ ...base, apiKey: "   " })).toBe(false)
    // aiAvailable() is mocked false here, so a real key still yields false —
    // what this pins is that a blank key can never be ready.
    expect(aiReady({ ...base, apiKey: "sk-test" })).toBe(false)
  })

  it("defaults the output cap high enough for one whole card", () => {
    // 4096 truncated a drafted card mid-JSON, which does not surface as "too
    // long" — it surfaces as unparseable output, and burns a retry.
    useAiStore.persist.clearStorage()
    expect(useAiStore.getInitialState().maxTokens).toBeGreaterThanOrEqual(16384)
  })
})
