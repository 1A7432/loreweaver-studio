import { create } from "zustand"
import { isServerFrame, type WelcomeFrame } from "@loreweaver/protocol"
import {
  isTauri,
  transportConnect,
  transportDisconnect,
  type TransportConnectParams,
  type TransportEvent,
  type TransportStatus,
} from "../lib/transport"
import { useSessionStore } from "./session"

/** Tolerate the ticket shapes people actually paste: the engine writes
 * `ticket=endpoint…` into iroh-ticket.txt, its console announce line reads
 * `Ticket：endpoint…`, and terminals wrap long tickets across lines. The real
 * ticket is the bare `endpoint…` string — slice from that marker when present
 * and strip all whitespace; anything else passes through for the transport's
 * own error message. */
export function sanitizeTicket(raw: string): string {
  const flat = raw.replace(/\s+/g, "")
  const at = flat.toLowerCase().indexOf("endpoint")
  return at > 0 ? flat.slice(at) : flat
}

interface ConnectionState {
  status: TransportStatus
  attempt: number
  lastError: string | null
  welcome: WelcomeFrame | null
  connect: (params: TransportConnectParams) => Promise<void>
  disconnect: () => Promise<void>
  /** Single entry point for everything the Rust bridge emits. */
  handleEvent: (event: TransportEvent) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: "offline",
  attempt: 0,
  lastError: null,
  welcome: null,

  connect: async (params) => {
    if (!isTauri()) {
      set({ status: "offline", lastError: "transport is only available inside the app shell" })
      return
    }
    set({ status: "connecting", attempt: 0, lastError: null, welcome: null })
    useSessionStore.getState().clear()
    try {
      await transportConnect({ ...params, ticket: sanitizeTicket(params.ticket), key: params.key.trim() })
    } catch (err) {
      set({ status: "offline", lastError: String(err) })
    }
  },

  disconnect: async () => {
    if (!isTauri()) return
    try {
      await transportDisconnect()
    } catch {
      // A failed disconnect only means there was nothing to disconnect.
    }
  },

  handleEvent: (event) => {
    if (event.kind === "status") {
      set((state) => ({
        status: event.status,
        attempt: event.attempt,
        lastError: event.error ?? null,
        welcome: event.status === "offline" ? null : state.welcome,
      }))
      return
    }
    const frame = event.frame
    // Belt and braces: the shared validator drops malformed frames so no
    // downstream consumer can crash on a missing field.
    if (!isServerFrame(frame)) return
    if (frame.type === "welcome") {
      set({ welcome: frame })
      return
    }
    useSessionStore.getState().ingest(frame)
  },
}))
