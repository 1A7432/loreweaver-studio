// Module UI panels session state (protocol v1.8 `ui_manifest` / `panel_event`).
//
// The manifest is FULL-REPLACE per viewer: whatever frame arrived last IS the
// panel list, and per-panel UI state (collapsed/closed/modal) is pruned to it.
// Two client settings persist across sessions: blocks-only mode (every Tier-2
// panel renders its fallback) and the per-room "this room draws its own
// interface" notice dismissal.

import { create } from "zustand"
import type { UiManifestPanel } from "@loreweaver/protocol"

const BLOCKS_ONLY_KEY = "lw-panels-blocks-only"
const NOTICE_ROOMS_KEY = "lw-panels-notice-rooms"
const MAX_NOTICE_ROOMS = 100

function readBlocksOnly(): boolean {
  try {
    return globalThis.localStorage?.getItem(BLOCKS_ONLY_KEY) === "1"
  } catch {
    return false
  }
}

function readNoticeRooms(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(NOTICE_ROOMS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((room): room is string => typeof room === "string") : []
  } catch {
    return []
  }
}

function persist(key: string, value: string) {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // Settings persistence is best-effort (private mode, quota…).
  }
}

// panel_event fan-out to mounted Tier-2 bridges. Deliberately not reactive
// store state: a listener lives exactly as long as its mounted iframe, and an
// event for a panel nobody is viewing is dropped (panel_event is transient
// signaling, not replayed state — state lives in `state` frames).
type PanelEventListener = (payload: unknown) => void
const eventListeners = new Map<string, Set<PanelEventListener>>()

export function subscribePanelEvents(panelId: string, listener: PanelEventListener): () => void {
  let set = eventListeners.get(panelId)
  if (!set) {
    set = new Set()
    eventListeners.set(panelId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) eventListeners.delete(panelId)
  }
}

interface PanelsState {
  /** This viewer's complete panel list; empty = no panels. */
  manifest: UiManifestPanel[]
  collapsed: Record<string, boolean>
  closed: Record<string, boolean>
  /** Wire id of the open modal panel, if any (one at a time). */
  modalOpen: string | null
  /** Render every Tier-2 panel's fallback instead of its sandboxed code. */
  blocksOnly: boolean
  /** Rooms whose consent notice was dismissed. */
  noticeRooms: string[]
  applyManifest: (panels: UiManifestPanel[]) => void
  deliverEvent: (panelId: string, payload: unknown) => void
  toggleCollapsed: (panelId: string) => void
  setClosed: (panelId: string, closed: boolean) => void
  openModal: (panelId: string) => void
  closeModal: () => void
  setBlocksOnly: (blocksOnly: boolean) => void
  markNoticeSeen: (room: string) => void
  /** Leaving/joining a room: manifest and per-panel UI state go, settings stay. */
  resetSession: () => void
}

function pruneTo(ids: Set<string>, record: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)))
}

export const usePanelsStore = create<PanelsState>((set) => ({
  manifest: [],
  collapsed: {},
  closed: {},
  modalOpen: null,
  blocksOnly: readBlocksOnly(),
  noticeRooms: readNoticeRooms(),

  applyManifest: (panels) => {
    const list = Array.isArray(panels) ? panels : []
    const ids = new Set(list.map((panel) => panel.id))
    set((s) => ({
      manifest: list,
      collapsed: pruneTo(ids, s.collapsed),
      closed: pruneTo(ids, s.closed),
      modalOpen: s.modalOpen && ids.has(s.modalOpen) ? s.modalOpen : null,
    }))
  },

  deliverEvent: (panelId, payload) => {
    const listeners = eventListeners.get(panelId)
    if (!listeners) return
    for (const listener of [...listeners]) listener(payload)
  },

  toggleCollapsed: (panelId) =>
    set((s) => ({ collapsed: { ...s.collapsed, [panelId]: !s.collapsed[panelId] } })),

  setClosed: (panelId, closed) => set((s) => ({ closed: { ...s.closed, [panelId]: closed } })),

  openModal: (panelId) => set({ modalOpen: panelId }),
  closeModal: () => set({ modalOpen: null }),

  setBlocksOnly: (blocksOnly) => {
    persist(BLOCKS_ONLY_KEY, blocksOnly ? "1" : "0")
    set({ blocksOnly })
  },

  markNoticeSeen: (room) => {
    set((s) => {
      if (s.noticeRooms.includes(room)) return s
      const noticeRooms = [...s.noticeRooms, room].slice(-MAX_NOTICE_ROOMS)
      persist(NOTICE_ROOMS_KEY, JSON.stringify(noticeRooms))
      return { noticeRooms }
    })
  },

  resetSession: () => set({ manifest: [], collapsed: {}, closed: {}, modalOpen: null }),
}))
