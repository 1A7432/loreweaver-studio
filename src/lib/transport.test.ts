import { describe, expect, it } from "vitest"
import { createGeneration } from "./transport"

describe("createGeneration", () => {
  it("mints a unique id per link", () => {
    const a = createGeneration()
    const b = createGeneration()
    expect(a.connectionId).not.toBe(b.connectionId)
    expect(a.connectionId.length).toBeGreaterThan(0)
  })

  it("orders the generations of one page load, under that page's own session", () => {
    // The Rust slot refuses a dial the WebView has already outrun, and this is
    // the ordering it refuses by. The session travels with it because the
    // counter alone cannot be trusted across a reload: a fresh page starts at 1
    // again while the slot still holds an epoch from the page before it, and
    // fencing the live page out behind a dead one's numbers would leave the app
    // unable to connect to anything at all.
    const first = createGeneration()
    const second = createGeneration()
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(second.session).toBe(first.session)
    expect(first.session.length).toBeGreaterThan(0)
  })
})
