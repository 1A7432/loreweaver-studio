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

  it("ships no output cap of its own", () => {
    // 0 = omit `max_tokens` and let the provider apply its own maximum. Any
    // number invented here is wrong in one of two directions: too low truncates
    // a drafted card mid-JSON (which surfaces as unparseable output, not as
    // "too long", and burns a retry), too high is a 400 from a model whose
    // OUTPUT ceiling is below its context window.
    expect(useAiStore.getInitialState().maxTokens).toBe(0)
  })
})
