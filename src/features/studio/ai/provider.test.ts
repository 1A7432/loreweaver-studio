import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A hung invoke is exactly what we're guarding against: llmChat never settles.
vi.mock("../../../lib/native", () => ({
  aiAvailable: () => false,
  llmChat: vi.fn(() => new Promise(() => {})),
  secretDelete: vi.fn(),
  secretExists: vi.fn(),
  secretSet: vi.fn(),
}))

import { CHAT_CALL_TIMEOUT_MS, chatOnce } from "./provider"

describe("chatOnce", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("rejects with a pointer to the keychain dialog instead of hanging forever", async () => {
    // Found live: an unanswered macOS keychain prompt (dev rebuilds re-prompt)
    // left the pack wizard's AI-draft button "working…" for 18+ minutes.
    const call = chatOnce("sys", [{ role: "user", content: "hi" }])
    const assertion = expect(call).rejects.toThrow(/timed out.*keychain/i)
    await vi.advanceTimersByTimeAsync(CHAT_CALL_TIMEOUT_MS + 1)
    await assertion
  })
})
