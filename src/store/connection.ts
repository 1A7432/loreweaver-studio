import { create } from "zustand"
import { isServerFrame, protocolMismatch, type WelcomeFrame } from "@loreweaver/protocol"
import i18n from "../i18n"
import {
  isTauri,
  transportConnect,
  transportDisconnect,
  type TransportConnectParams,
  type TransportEvent,
  type TransportStatus,
} from "../lib/transport"
import { useAdminStore } from "./admin"
import { useAudioStore } from "./audio"
import { useMediaStore } from "./media"
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

export const useConnectionStore = create<ConnectionState>((set, get) => ({
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
    useMediaStore.getState().reset()
    useAudioStore.getState().reset()
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
      // The MAJOR version is the compatibility contract, and the shared package ships
      // the predicate so no client has to write it. A client that keeps talking to a
      // different-major server misreads frames rather than failing, which is much
      // harder to diagnose than a refusal — and with no backward compatibility promised
      // before adoption, a stale client WILL meet a server that moved. So: refuse, name
      // both versions, and drop the connection instead of letting the Rust bridge
      // reconnect into the same wall. (The library only warns; refusing is the app's
      // call, and this is the app.)
      const mismatch = protocolMismatch(frame.protocol)
      if (mismatch) {
        set({
          status: "offline",
          welcome: null,
          lastError: i18n.t("connect.protocolMismatch", { ...mismatch }),
        })
        void get().disconnect()
        return
      }
      set({ welcome: frame })
      return
    }
    // Keeper-admin replies feed the admin store; they never reach the chronicle.
    if (useAdminStore.getState().ingest(frame)) return
    // The media and audio families are room furniture, not chronicle lines:
    // pictures and library entries land in their own index beside the log, and
    // playback intent drives the mixer.
    if (useMediaStore.getState().ingest(frame)) return
    if (useAudioStore.getState().ingest(frame)) return
    useSessionStore.getState().ingest(frame)
  },
}))
