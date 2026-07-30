import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ServerFrame, UiManifestPanel } from "@loreweaver/protocol"
import { subscribePanelEvents, usePanelsStore } from "./panels"
import { useSessionStore } from "./session"

const SIDEBAR: UiManifestPanel = {
  id: "blackmoor/case-board",
  title: { en: "Case Board", zh: "案情板" },
  slot: "sidebar",
  tier: 1,
  blocks: [{ kind: "text", text: { en: "hi" } }],
}

const MODAL: UiManifestPanel = {
  id: "blackmoor/manor-map",
  title: { en: "Manor Map", zh: "庄园地图" },
  slot: "modal",
  tier: 2,
  entry: { hash: "c".repeat(64), size: 1234 },
  assets: [{ path: "app.js", hash: "a".repeat(64), size: 99, mime: "text/javascript" }],
  fallback: [{ kind: "text", text: { en: "Map in the rich client." } }],
}

function resetAll() {
  useSessionStore.getState().clear()
  usePanelsStore.setState({ blocksOnly: false, noticeRooms: [] })
  globalThis.localStorage?.clear()
}

describe("panels store", () => {
  beforeEach(resetAll)

  it("applies the manifest as a full replace and prunes stale panel state", () => {
    const store = usePanelsStore.getState()
    store.applyManifest([SIDEBAR, MODAL])
    usePanelsStore.getState().toggleCollapsed(SIDEBAR.id)
    usePanelsStore.getState().setClosed(SIDEBAR.id, true)
    usePanelsStore.getState().openModal(MODAL.id)

    usePanelsStore.getState().applyManifest([MODAL])
    const next = usePanelsStore.getState()
    expect(next.manifest.map((p) => p.id)).toEqual([MODAL.id])
    expect(next.collapsed[SIDEBAR.id]).toBeUndefined()
    expect(next.closed[SIDEBAR.id]).toBeUndefined()
    expect(next.modalOpen).toBe(MODAL.id)

    usePanelsStore.getState().applyManifest([])
    expect(usePanelsStore.getState().modalOpen).toBeNull()
    expect(usePanelsStore.getState().manifest).toEqual([])
  })

  it("routes panel events only to that panel's subscribers", () => {
    const forMap = vi.fn()
    const forBoard = vi.fn()
    const offMap = subscribePanelEvents(MODAL.id, forMap)
    const offBoard = subscribePanelEvents(SIDEBAR.id, forBoard)

    usePanelsStore.getState().deliverEvent(MODAL.id, { turn: 3 })
    expect(forMap).toHaveBeenCalledWith({ turn: 3 })
    expect(forBoard).not.toHaveBeenCalled()

    offMap()
    usePanelsStore.getState().deliverEvent(MODAL.id, { turn: 4 })
    expect(forMap).toHaveBeenCalledTimes(1)
    offBoard()
  })

  it("persists blocks-only mode and per-room notice dismissal", () => {
    usePanelsStore.getState().setBlocksOnly(true)
    expect(globalThis.localStorage.getItem("lw-panels-blocks-only")).toBe("1")

    usePanelsStore.getState().markNoticeSeen("r1")
    usePanelsStore.getState().markNoticeSeen("r1")
    expect(usePanelsStore.getState().noticeRooms).toEqual(["r1"])
    expect(JSON.parse(globalThis.localStorage.getItem("lw-panels-notice-rooms") ?? "[]")).toEqual(["r1"])
  })

  it("ingests ui_manifest and panel_event through the session store", () => {
    const manifestFrame = { type: "ui_manifest", panels: [SIDEBAR] } as ServerFrame
    useSessionStore.getState().ingest(manifestFrame)
    expect(usePanelsStore.getState().manifest.map((p) => p.id)).toEqual([SIDEBAR.id])

    const seen = vi.fn()
    const off = subscribePanelEvents(SIDEBAR.id, seen)
    useSessionStore
      .getState()
      .ingest({ type: "panel_event", panel: SIDEBAR.id, payload: { ping: 1 } } as ServerFrame)
    expect(seen).toHaveBeenCalledWith({ ping: 1 })
    off()
  })

  it("clears session panel state but keeps settings on session clear", () => {
    usePanelsStore.getState().applyManifest([SIDEBAR])
    usePanelsStore.getState().setBlocksOnly(true)
    usePanelsStore.getState().markNoticeSeen("r1")
    useSessionStore.getState().clear()
    const state = usePanelsStore.getState()
    expect(state.manifest).toEqual([])
    expect(state.blocksOnly).toBe(true)
    expect(state.noticeRooms).toEqual(["r1"])
  })
})
