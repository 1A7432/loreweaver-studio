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

  it("is the only storage any persisted store uses", () => {
    // The quota is shared across every key, so the store that THROWS is rarely
    // the store that filled it — one unguarded `persist` is enough to take an
    // unrelated edit down with it. This is the rule that keeps the next store
    // from being added without the guard; there is no per-store exception.
    const sources: Record<string, string> = import.meta.glob("../{store,features}/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    })
    const scanned = Object.entries(sources).filter(([path]) => !/\.test\.ts$/.test(path))
    // A glob that matched nothing would make this pass by seeing nothing —
    // the same vacuous green a zero-match test filter gives. Assert it looked.
    expect(scanned.filter(([, text]) => text.includes("persist(")).length).toBeGreaterThan(5)
    expect(scanned.filter(([, text]) => text.includes("createJSONStorage(")).map(([p]) => p)).toEqual([])
  })
})
