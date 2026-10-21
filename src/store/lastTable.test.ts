import { beforeEach, describe, expect, it } from "vitest"
import { useLastTableStore } from "./lastTable"

const KEY = "loreweaver-studio-last-table"
const TABLE = { ticket: "endpointabc123", key: "k-1", name: "Nyx" }

function stored(): { state: Record<string, unknown> } | null {
  const raw = localStorage.getItem(KEY)
  return raw === null ? null : JSON.parse(raw)
}

describe("last table store", () => {
  beforeEach(() => {
    localStorage.clear()
    useLastTableStore.getState().forget()
    localStorage.clear()
  })

  it("starts empty", () => {
    expect(useLastTableStore.getState()).toMatchObject({ ticket: "", key: "", name: "" })
  })

  it("writes what it remembers to localStorage, and only the three fields", () => {
    useLastTableStore.getState().remember(TABLE)
    expect(stored()?.state).toEqual(TABLE)
  })

  it("comes back after a reload: a fresh read of storage restores the table", async () => {
    localStorage.setItem(KEY, JSON.stringify({ state: TABLE, version: 0 }))
    await useLastTableStore.persist.rehydrate()
    expect(useLastTableStore.getState()).toMatchObject(TABLE)
  })

  it("forget empties memory and storage", () => {
    useLastTableStore.getState().remember(TABLE)
    useLastTableStore.getState().forget()
    expect(useLastTableStore.getState()).toMatchObject({ ticket: "", key: "", name: "" })
    expect(stored()?.state).toEqual({ ticket: "", key: "", name: "" })
  })

  it("forgetMatching drops the table only when ticket AND key are the saved ones", () => {
    useLastTableStore.getState().remember(TABLE)
    // A wrong key typed for the same server must not erase the good one.
    useLastTableStore.getState().forgetMatching({ ...TABLE, key: "typo" })
    expect(useLastTableStore.getState().key).toBe("k-1")
    useLastTableStore.getState().forgetMatching({ ...TABLE, ticket: "endpointother" })
    expect(useLastTableStore.getState().ticket).toBe("endpointabc123")
    useLastTableStore.getState().forgetMatching(TABLE)
    expect(useLastTableStore.getState().ticket).toBe("")
  })
})
