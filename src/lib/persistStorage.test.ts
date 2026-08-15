import { afterEach, describe, expect, it, vi } from "vitest"
import { guardedLocalStorage, persistenceDegraded, resetPersistenceState } from "./persistStorage"

/** `createJSONStorage` hands back a storage whose values are already parsed;
 * these tests only care that nothing thrown by the browser escapes. */
const storage = guardedLocalStorage!

afterEach(() => {
  vi.restoreAllMocks()
  resetPersistenceState()
  localStorage.clear()
})

describe("guardedLocalStorage", () => {
  it("round-trips normally when the browser is willing", async () => {
    await storage.setItem("k", { state: { a: 1 }, version: 1 })
    expect(await storage.getItem("k")).toEqual({ state: { a: 1 }, version: 1 })
    expect(persistenceDegraded()).toBe(false)
  })

  it("swallows a quota error rather than aborting the edit that caused it", () => {
    // The failure this exists for: zustand's persist calls setItem
    // synchronously inside `set(...)`, so a throw here takes down the state
    // update — the author's typing stops working because a cache is full.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("exceeded the quota", "QuotaExceededError")
    })
    expect(() => storage.setItem("k", { state: {}, version: 1 })).not.toThrow()
    expect(persistenceDegraded()).toBe(true)
  })

  it("reads a hostile storage as an empty one", async () => {
    // A private window can throw on read too; that is indistinguishable from a
    // first launch, and a first launch is a state this app already handles.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("access denied", "SecurityError")
    })
    expect(await storage.getItem("k")).toBeNull()
  })

  it("swallows a failing removeItem", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("nope")
    })
    expect(() => storage.removeItem("k")).not.toThrow()
    expect(persistenceDegraded()).toBe(true)
  })
})
