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
      await transportConnect(params)
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
