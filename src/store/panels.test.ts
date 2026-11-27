import { beforeEach, describe, expect, it } from "vitest"
import { usePanelsStore } from "./panels"

describe("panels store (UI state only)", () => {
  beforeEach(() => {
    usePanelsStore.setState({ collapsed: {}, closed: {}, modalOpen: null, noticeRooms: [] })
    globalThis.localStorage?.clear()
  })

  it("keeps what the player did to each panel: collapsed, closed, the open overlay", () => {
    const store = usePanelsStore.getState()
    store.toggleCollapsed("harbor/tide")
    store.setClosed("harbor/roll-call", true)
    store.openModal("harbor/map")
    const next = usePanelsStore.getState()
    expect(next.collapsed).toEqual({ "harbor/tide": true })
    expect(next.closed).toEqual({ "harbor/roll-call": true })
    expect(next.modalOpen).toBe("harbor/map")
    next.closeModal()
    expect(usePanelsStore.getState().modalOpen).toBeNull()
  })

  it("persists the per-room notice dismissal, once per room", () => {
    usePanelsStore.getState().markNoticeSeen("r1")
    usePanelsStore.getState().markNoticeSeen("r1")
    expect(usePanelsStore.getState().noticeRooms).toEqual(["r1"])
    expect(JSON.parse(globalThis.localStorage.getItem("lw-panels-notice-rooms") ?? "[]")).toEqual(["r1"])
  })

  it("forgets the per-panel state for another table, and keeps the dismissals", () => {
    const store = usePanelsStore.getState()
    store.toggleCollapsed("harbor/tide")
    store.openModal("harbor/map")
    store.markNoticeSeen("r1")
    usePanelsStore.getState().resetSession()
    const next = usePanelsStore.getState()
    expect(next.collapsed).toEqual({})
    expect(next.modalOpen).toBeNull()
    expect(next.noticeRooms).toEqual(["r1"])
  })
})
