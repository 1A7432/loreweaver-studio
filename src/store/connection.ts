// The app's one table slot (protocol 3.0): which `Connection` is current, and
// the three things the connect form does to it. The connection itself — its
// `Session`, its link, its redials — lives in `lib/connection.ts`, outside
// React; this store holds only the REFERENCE to the current one. React reads
// the session with `useSessionSnapshot()` (`useSyncExternalStore` on the
// session itself) and the owner's own state with `useConnectionState()`: no
// copy of either is kept here.

import { useSyncExternalStore } from "react"
import type { BuiltInViewName, SessionSnapshot } from "loreweaver-protocol/v3"
import { create } from "zustand"
import i18n from "../i18n"
import {
  Connection,
  IDLE_STATE,
  LinkDriverError,
  type ConnectionState,
  type LinkDriver,
} from "../lib/connection"
import {
  isTauri,
  linkConnect,
  linkDisconnect,
  linkSend,
  type LinkEvent,
  type NetworkProfile,
} from "../lib/transport"
import { clearDataUrlCache } from "../lib/dataUrlCache"
import { STUDIO_VERSION } from "../version"
import { startAudio } from "./audio"
import { useLastTableStore, type RememberedTable } from "./lastTable"
import { usePanelsStore } from "./panels"

/** The name this client gives in `hello`. */
export const CLIENT_NAME = "loreweaver-studio"

/**
 * The built-in views the room screen shows, wanted for the whole life of a connection: the
 * session subscribes them on every welcome, a resume's included. Views only one screen
 * reads (a panel's own views) are subscribed by that screen while it is open.
 */
export const ROOM_VIEWS: readonly BuiltInViewName[] = [
  "me",
  "party",
  "scene",
  "variables",
  "characters",
  "commands",
  "room",
  "usage",
  "packs",
  "panels",
]

/** Tolerate the ticket shapes people actually paste: a `ticket=endpoint…`
 * sidecar line, a console announce line, a ticket a terminal wrapped across
 * lines. The real ticket is the bare `endpoint…` string — slice from that
 * marker when present and strip all whitespace; anything else passes through
 * for the link's own error. */
export function sanitizeTicket(raw: string): string {
  const flat = raw.replace(/\s+/g, "")
  const at = flat.toLowerCase().indexOf("endpoint")
  return at > 0 ? flat.slice(at) : flat
}

export interface DialParams {
  ticket: string
  key: string
  name?: string
  /** `local` for a server started with `serve --local` (tests only); `n0` by default. */
  network?: NetworkProfile
}

export interface ConnectOptions {
  /** This dial is a table the player entered by hand: remember it once the
   * server welcomes it (see `store/lastTable.ts`). */
  remember?: boolean
}

/** The Rust bridge, or — outside the app shell — a driver that refuses with `no_shell`. */
function linkDriver(): LinkDriver {
  if (!isTauri()) {
    return {
      connect: () => Promise.reject(new LinkDriverError("no_shell")),
      send: () => Promise.reject(new LinkDriverError("no_shell")),
      disconnect: () => Promise.resolve(),
    }
  }
  return { connect: linkConnect, send: linkSend, disconnect: linkDisconnect }
}

/** The hand-dialed table waiting to be judged: remembered on its welcome,
 * forgotten again if the server turns its key down. Keyed by the connection, so
 * a later dial (the local-host button, say) can never inherit it. */
let pendingRemember: { connection: Connection; table: RememberedTable } | null = null

interface ConnectionSlot {
  /** The current connection (live, or ended with its reason), or none yet. */
  connection: Connection | null
  /** Dial a table: the current connection, if any, is stopped first. */
  connect: (params: DialParams, options?: ConnectOptions) => Promise<void>
  /** Stop the current connection; it stays in the slot, ended, with any failure it had. */
  disconnect: () => Promise<void>
  /** The player's Forget: drop the saved table, and the remember a dial still in
   * flight would write on its welcome. */
  forgetLastTable: () => void
  /** Single entry point for everything the Rust bridge emits. */
  handleEvent: (event: LinkEvent) => void
}

export const useConnectionStore = create<ConnectionSlot>((set, get) => ({
  connection: null,

  connect: async (params, options) => {
    pendingRemember = null
    get().connection?.stop()
    // Another table: the panels' UI state (collapsed, closed, the open overlay) and the
    // decoded pictures belong to the one just left.
    usePanelsStore.getState().resetSession()
    clearDataUrlCache()
    const table: RememberedTable = {
      ticket: sanitizeTicket(params.ticket),
      key: params.key.trim(),
      name: params.name?.trim() ?? "",
    }
    const connection: Connection = new Connection({
      ticket: table.ticket,
      key: table.key,
      ...(table.name ? { name: table.name } : {}),
      locale: i18n.resolvedLanguage ?? i18n.language ?? "en",
      client: { name: CLIENT_NAME, version: STUDIO_VERSION },
      network: params.network ?? "n0",
      driver: linkDriver(),
      views: ROOM_VIEWS,
      onWelcome: () => {
        if (pendingRemember?.connection !== connection) return
        useLastTableStore.getState().remember(pendingRemember.table)
        pendingRemember = null
      },
      onRefused: (failure) => {
        // The server turned the key down: a table saved with it can never connect
        // again, and prefilling it on every launch would just repeat the failure.
        if (pendingRemember?.connection !== connection) return
        if (failure.code === "bad_key") useLastTableStore.getState().forgetMatching(pendingRemember.table)
        pendingRemember = null
      },
    })
    if (options?.remember) pendingRemember = { connection, table }
    set({ connection })
    // The room's sound plays through this connection for its whole life (the menu included),
    // and stops when it ends. Outside the app shell there is no byte channel to fetch it over.
    if (isTauri()) startAudio(connection)
    connection.start()
  },

  disconnect: async () => {
    get().connection?.stop()
  },

  forgetLastTable: () => {
    // Forget is the later, explicit word: a dial in flight must not write the
    // table straight back when its welcome lands.
    pendingRemember = null
    useLastTableStore.getState().forget()
  },

  handleEvent: (event) => {
    get().connection?.handleEvent(event)
  },
}))

const noSubscription = () => () => undefined
const noSnapshot = (): SessionSnapshot | null => null
const idleState = (): ConnectionState => IDLE_STATE

/** The current connection, or null. */
export function useConnection(): Connection | null {
  return useConnectionStore((slot) => slot.connection)
}

/** The current connection's own state (phase, attempt, failure); idle when there is none. */
export function useConnectionState(): ConnectionState {
  const connection = useConnection()
  return useSyncExternalStore(
    connection ? connection.subscribe : noSubscription,
    connection ? connection.getState : idleState,
  )
}

/** The current session's snapshot, read straight from the protocol `Session`; null when there is none. */
export function useSessionSnapshot(): SessionSnapshot | null {
  const connection = useConnection()
  return useSyncExternalStore(
    connection ? connection.session.subscribe : noSubscription,
    connection ? connection.session.getSnapshot : noSnapshot,
  )
}
