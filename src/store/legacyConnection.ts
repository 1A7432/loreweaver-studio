// The connection as the protocol 2.x screens saw it: kept, UNFED, so those
// screens and their tests compile until each one moves to protocol 3.0 (later
// steps of the move; see `store/connection.ts` for the live connection).
//
// Nothing in the app writes this store any more — the 2.x frame router that
// fed it is gone — so in the running app it always reads offline. The play
// screen does not render these screens meanwhile (it shows the 3.0 room line
// instead), and `lib/transport.ts`'s `transportSend` sends nothing. Delete this
// file when the last reader has moved.

import type { WelcomeFrame } from "@loreweaver/protocol"
import { create } from "zustand"

/** The 2.x transport statuses. */
export type TransportStatus = "connecting" | "online" | "reconnecting" | "offline"

interface LegacyConnectionState {
  status: TransportStatus
  attempt: number
  lastError: string | null
  welcome: WelcomeFrame | null
}

export const useLegacyConnectionStore = create<LegacyConnectionState>(() => ({
  status: "offline",
  attempt: 0,
  lastError: null,
  welcome: null,
}))
