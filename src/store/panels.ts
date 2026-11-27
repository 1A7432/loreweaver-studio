// The panels' UI state, and nothing of the server's: which panel the player collapsed or
// closed, which overlay is open, and which rooms' "this room draws its own interface"
// notice was dismissed. The panel LIST is the `panels` view, read from the session's
// snapshot (protocol 3.0 §10.6) — never copied here.
//
// A panel that left the list keeps its entry in `collapsed`/`closed` until the next table
// (`resetSession`): an id nobody lists is never read, and a panel that comes back (a pack
// re-enabled) comes back as the player left it.

import { create } from "zustand"

const NOTICE_ROOMS_KEY = "lw-panels-notice-rooms"
const MAX_NOTICE_ROOMS = 100

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

interface PanelsState {
  collapsed: Record<string, boolean>
  closed: Record<string, boolean>
  /** The id of the open overlay (`modal` slot) panel, if any: one at a time. */
  modalOpen: string | null
  /** Rooms whose notice was dismissed. */
  noticeRooms: string[]
  toggleCollapsed: (panelId: string) => void
  setClosed: (panelId: string, closed: boolean) => void
  openModal: (panelId: string) => void
  closeModal: () => void
  markNoticeSeen: (room: string) => void
  /** Another table: the per-panel state goes, the notice dismissals stay. */
  resetSession: () => void
}

export const usePanelsStore = create<PanelsState>((set) => ({
  collapsed: {},
  closed: {},
  modalOpen: null,
  noticeRooms: readNoticeRooms(),

  toggleCollapsed: (panelId) =>
    set((s) => ({ collapsed: { ...s.collapsed, [panelId]: !s.collapsed[panelId] } })),

  setClosed: (panelId, closed) => set((s) => ({ closed: { ...s.closed, [panelId]: closed } })),

  openModal: (panelId) => set({ modalOpen: panelId }),
  closeModal: () => set({ modalOpen: null }),

  markNoticeSeen: (room) => {
    set((s) => {
      if (s.noticeRooms.includes(room)) return s
      const noticeRooms = [...s.noticeRooms, room].slice(-MAX_NOTICE_ROOMS)
      persist(NOTICE_ROOMS_KEY, JSON.stringify(noticeRooms))
      return { noticeRooms }
    })
  },

  resetSession: () => set({ collapsed: {}, closed: {}, modalOpen: null }),
}))
