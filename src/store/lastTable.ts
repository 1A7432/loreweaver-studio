// The last table a player joined BY HAND: a pasted server ticket + access key
// (+ the display name typed with them) on the "join a table" screen.
//
// Nothing used to remember them, so any WebView reload — a dev HMR full reload,
// a crash, quitting and reopening the app — landed on an empty form and the
// player had to dig the ticket and key out of wherever the keeper sent them
// (2026-10-21 play-test). The one-click local-host path never had that problem
// because `store/hostLocal.ts` persists its own credentials; this is the same
// mechanism for the other path.
//
// The caveats are the ones hostLocal documents, and they hold here too:
//  - The credentials sit in the WebView's localStorage, in the clear, beside the
//    API key this app already keeps. A key is an invitation to one room, not an
//    account — but it is still a secret on this machine, so the player can drop
//    it on purpose (`forget`), and a key the server rejects is dropped for them.
//  - Persistence is best-effort (`guardedLocalStorage`): a full or blocked
//    storage costs the NEXT launch its memory, never the connection in hand.
//  - Only a connection that actually completed the handshake is remembered, and
//    only one the player dialed by hand. The local-host path keeps its own
//    credentials for its own server; mixing them in here would prefill this form
//    with a server that is no longer running.
//
// A leaf store on purpose (it imports no other store): the connection store
// writes to it when a welcome is accepted, and the connect screen reads it.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { guardedLocalStorage } from "../lib/persistStorage"

export interface RememberedTable {
  ticket: string
  key: string
  /** The display name typed with them; "" when none was. */
  name: string
}

interface LastTableState extends RememberedTable {
  remember: (table: RememberedTable) => void
  /** Drop the saved table unconditionally — the player asked. */
  forget: () => void
  /** Drop the saved table only when it IS this one: a server rejecting a key the
   * player just typed must not erase the good table saved beside it. */
  forgetMatching: (table: RememberedTable) => void
}

const EMPTY: RememberedTable = { ticket: "", key: "", name: "" }

export const useLastTableStore = create<LastTableState>()(
  persist(
    (set, get) => ({
      ...EMPTY,
      remember: (table) => set({ ticket: table.ticket, key: table.key, name: table.name }),
      forget: () => set({ ...EMPTY }),
      forgetMatching: (table) => {
        const saved = get()
        if (saved.ticket === table.ticket && saved.key === table.key) set({ ...EMPTY })
      },
    }),
    {
      name: "loreweaver-studio-last-table",
      storage: guardedLocalStorage,
      partialize: (s) => ({ ticket: s.ticket, key: s.key, name: s.name }),
    },
  ),
)
