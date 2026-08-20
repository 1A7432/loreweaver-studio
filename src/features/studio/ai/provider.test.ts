import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A hung invoke is exactly what we're guarding against: llmChat never settles.
type DeltaSink = ((text: string) => void) | undefined

const llmChatMock = vi.fn<(...args: [unknown, unknown, unknown, DeltaSink]) => Promise<string>>(
  () => new Promise<string>(() => {}),
)

vi.mock("../../../lib/native", () => ({
  aiAvailable: () => false,
  llmChat: (...args: [unknown, unknown, unknown, DeltaSink]) => llmChatMock(...args),
}))

import { CHAT_CALL_TIMEOUT_MS, chatOnce, aiReady, useAiStore } from "./provider"

describe("chatOnce", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    llmChatMock.mockReset()
    llmChatMock.mockImplementation(() => new Promise<string>(() => {}))
  })
  afterEach(() => vi.useRealTimers())

  it("rejects instead of leaving the UI busy forever", async () => {
    // Found live: a hung call left the pack wizard's AI-draft button
    // "working…" for 18+ minutes. Whatever the cause, the invoke must settle.
    const call = chatOnce("sys", [{ role: "user", content: "hi" }])
    const assertion = expect(call).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(CHAT_CALL_TIMEOUT_MS + 1)
    await assertion
  })

  it("treats a ticking stream as alive: each delta re-arms the belt", async () => {
    // A long generation legitimately outlives any fixed whole-call ceiling —
    // that fixed ceiling is exactly how a card draft used to die. The belt is
    // idle-shaped now: five deltas spaced just inside the window add up to far
    // more than one window, and the call still resolves.
    llmChatMock.mockImplementation(
      (_config, _system, _messages, onDelta) =>
        new Promise<string>((resolve) => {
          let ticks = 0
          const interval = setInterval(() => {
            onDelta?.("token ")
            if (++ticks === 5) {
              clearInterval(interval)
              resolve("token token token token token")
            }
          }, CHAT_CALL_TIMEOUT_MS - 1000)
        }),
    )
    const seen: string[] = []
    const call = chatOnce("sys", [{ role: "user", content: "hi" }], undefined, (text) => seen.push(text))
    await vi.advanceTimersByTimeAsync((CHAT_CALL_TIMEOUT_MS - 1000) * 5 + 1)
    await expect(call).resolves.toMatch(/^token /)
    expect(seen).toHaveLength(5)
  })

  it("a stream that goes silent after a few deltas still settles", async () => {
    llmChatMock.mockImplementation(
      (_config, _system, _messages, onDelta) =>
        new Promise<string>(() => {
          onDelta?.("only ")
          onDelta?.("this")
        }),
    )
    const call = chatOnce("sys", [{ role: "user", content: "hi" }])
    const assertion = expect(call).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(CHAT_CALL_TIMEOUT_MS + 1)
    await assertion
  })

  it("ignores the deltas of a call that already gave up", async () => {
    // The timeout settles the promise; it cannot cancel the invoke behind it,
    // and the native bridge keeps its stream listener until Rust returns. So a
    // call abandoned at the belt can still be emitting text while the author is
    // watching the NEXT draft — the preview would interleave two generations.
    let strayDelta: ((text: string) => void) | undefined
    llmChatMock.mockImplementationOnce(
      (_config, _system, _messages, onDelta) =>
        new Promise<string>(() => {
          strayDelta = onDelta
        }),
    )
    const abandoned: string[] = []
    const first = chatOnce("sys", [{ role: "user", content: "hi" }], undefined, (text) =>
      abandoned.push(text),
    )
    const assertion = expect(first).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(CHAT_CALL_TIMEOUT_MS + 1)
    await assertion

    const fresh: string[] = []
    llmChatMock.mockImplementationOnce(
      (_config, _system, _messages, onDelta) =>
        new Promise<string>((resolve) => {
          onDelta?.("the new draft")
          resolve("the new draft")
        }),
    )
    const second = chatOnce("sys", [{ role: "user", content: "again" }], undefined, (text) =>
      fresh.push(text),
    )
    await expect(second).resolves.toBe("the new draft")

    strayDelta?.("late text from the dead call")
    expect(abandoned).toEqual([])
    expect(fresh).toEqual(["the new draft"])
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
