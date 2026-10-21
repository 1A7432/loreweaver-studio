import { create } from "zustand"
import { isServerFrame, protocolMismatch, type WelcomeFrame } from "@loreweaver/protocol"
import i18n from "../i18n"
import {
  createConnection,
  isTauri,
  transportConnect,
  transportDisconnect,
  type DialParams,
  type TransportEvent,
  type TransportStatus,
} from "../lib/transport"
import { useAdminStore } from "./admin"
import { useAudioStore } from "./audio"
import { useLastTableStore, type RememberedTable } from "./lastTable"
import { useMediaStore } from "./media"
import { useReportStore } from "./report"
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

/** Does this frame claim to be the handshake, whatever else is wrong with it?
 * Only the `type` is trusted here — that is the whole point: everything else
 * failed validation. */
function looksLikeWelcome(frame: unknown): boolean {
  return typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "welcome"
}

/** The hand-dialed connection waiting to be judged: remembered once its welcome
 * is accepted, dropped again if the server rejects its key. Keyed by the dial's
 * generation, so a later dial (the local-host button, say) can never inherit it.
 * Module state rather than store state — nothing renders from it. */
let pendingRemember: { connectionId: string; table: RememberedTable } | null = null

export interface ConnectOptions {
  /** This dial is a table the player entered by hand: remember it once the
   * handshake succeeds (see `store/lastTable.ts`). */
  remember?: boolean
}

interface ConnectionState {
  status: TransportStatus
  attempt: number
  lastError: string | null
  welcome: WelcomeFrame | null
  /**
   * The live Tauri-bridge generation. Events stamped with any other id are
   * dropped at `handleEvent` — including ones already sitting in the JS
   * queue when this is overwritten. `null` after disconnect, so a queued
   * Offline/Frame from the dying actor cannot write back.
   */
  connectionId: string | null
  /** A handshake this store refused. While set, transport statuses are ignored
   * — see `handleEvent`. Cleared only by an explicit new connect. */
  refused: boolean
  connect: (params: DialParams, options?: ConnectOptions) => Promise<void>
  disconnect: () => Promise<void>
  /** Single entry point for everything the Rust bridge emits. */
  handleEvent: (event: TransportEvent) => void
}

type Setter = (partial: Partial<ConnectionState>) => void
type Getter = () => ConnectionState

/** Refuse the handshake: go offline with a reason, latch it so the statuses
 * already in flight cannot undo it, and drop the connection rather than letting
 * the bridge redial into the same wall. */
function refuse(set: Setter, get: Getter, reason: string): void {
  set({ status: "offline", attempt: 0, welcome: null, lastError: reason, refused: true })
  void get().disconnect()
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: "offline",
  attempt: 0,
  lastError: null,
  welcome: null,
  connectionId: null,
  refused: false,

  connect: async (params, options) => {
    pendingRemember = null
    // An explicit dial is the one thing that lifts a refusal — do it before any
    // early return, so a refused handshake cannot leave the store deaf to every
    // status that follows for the rest of the process's life.
    set({ refused: false })
    if (!isTauri()) {
      set({
        status: "offline",
        lastError: "transport is only available inside the app shell",
        connectionId: null,
      })
      return
    }
    // Mint the new generation BEFORE clear() and BEFORE the invoke returns.
    // Events already queued from the previous actor carry the old id and
    // must not refill the session we are about to wipe; events from the new
    // actor may arrive before `transportConnect` resolves. The generation also
    // travels to Rust, which seats an actor only for a dial the WebView has
    // not already outrun — the id alone says who, the session + seq say when.
    const generation = createConnection()
    if (options?.remember) {
      pendingRemember = {
        connectionId: generation.connectionId,
        table: {
          ticket: sanitizeTicket(params.ticket),
          key: params.key.trim(),
          name: params.name?.trim() ?? "",
        },
      }
    }
    set({
      status: "connecting",
      attempt: 0,
      lastError: null,
      welcome: null,
      connectionId: generation.connectionId,
    })
    useSessionStore.getState().clear()
    useMediaStore.getState().reset()
    useAudioStore.getState().reset()
    useReportStore.getState().reset()
    let failure: string | null = null
    try {
      await transportConnect({
        ...params,
        ticket: sanitizeTicket(params.ticket),
        key: params.key.trim(),
        generation,
      })
    } catch (err) {
      failure = String(err)
    }
    // One guard over BOTH continuations: a later explicit connect may already
    // own the store, and this invoke — seated or refused — speaks for a
    // generation that is gone. Writing offline/null here would kill B.
    if (get().connectionId !== generation.connectionId || failure === null) return
    set({ status: "offline", lastError: failure, connectionId: null })
  },

  disconnect: async () => {
    // Invalidate FIRST. The dying actor still emits Offline (and maybe a
    // last Frame); those events may already be in the JS queue. Clearing
    // the generation here is what stops them writing the previous room
    // back after the caller has moved on. Status is set locally because
    // the Offline event itself will now be dropped.
    //
    // The invoke below writes nothing when it settles, so a concurrent
    // newer connect is safe from this function's tail — do not add a
    // post-await set.
    const lastError = get().refused ? get().lastError : null
    const connectionId = get().connectionId
    set({ connectionId: null, status: "offline", attempt: 0, welcome: null, lastError })
    if (!isTauri()) return
    try {
      // Name the generation being dropped. The slot closes only its own
      // occupant, so a disconnect a newer dial has already replaced cannot
      // take that newer actor down with it.
      await transportDisconnect(connectionId)
    } catch {
      // A failed disconnect only means there was nothing to disconnect.
    }
  },

  handleEvent: (event) => {
    // The single chokepoint for a stale generation. A Rust-side check
    // before emit cannot see an event that has already crossed the bridge.
    if (event.connectionId !== get().connectionId) return
    if (event.kind === "status") {
      // A refusal outranks every status that follows it. The bridge emits the
      // welcome frame and `online` back-to-back (`client.rs`: `settled = true`
      // then `status(Online)`), so a refusal decided on the frame would be
      // undone one event later by a status already in flight — the app would
      // flicker into a room-less play screen and then bounce back to the form
      // with no reason showing. The latch holds until the operator dials again.
      if (get().refused) return
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
    // downstream consumer can crash on a missing field. A malformed WELCOME is
    // not droppable, though: the bridge has already marked the session settled
    // (which disarms its join deadline) and announced `online`, so staying
    // quiet would leave the app online with no room and nothing to show for it.
    if (!isServerFrame(frame)) {
      if (looksLikeWelcome(frame)) refuse(set, get, i18n.t("connect.welcomeUnreadable"))
      return
    }
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
        refuse(set, get, i18n.t("connect.protocolMismatch", { ...mismatch }))
        return
      }
      set({ welcome: frame })
      if (pendingRemember?.connectionId === event.connectionId) {
        useLastTableStore.getState().remember(pendingRemember.table)
        pendingRemember = null
      }
      // Every welcome opens a join replay, and an automatic redial is a join
      // like any other: the log must hear about it to rebuild from the replay
      // instead of appending the whole history a second time.
      useSessionStore.getState().ingest(frame)
      return
    }
    // The server turned the key down: a table saved with it can never connect
    // again, and prefilling it on every launch would just repeat the failure.
    if (
      frame.type === "error" &&
      frame.code === "bad_key" &&
      pendingRemember?.connectionId === event.connectionId
    ) {
      useLastTableStore.getState().forgetMatching(pendingRemember.table)
      pendingRemember = null
    }
    // Keeper-admin replies feed the admin store; they never reach the chronicle.
    if (useAdminStore.getState().ingest(frame)) return
    // The media and audio families are room furniture, not chronicle lines:
    // pictures and library entries land in their own index beside the log, and
    // playback intent drives the mixer.
    if (useMediaStore.getState().ingest(frame)) return
    if (useAudioStore.getState().ingest(frame)) return
    // A session report is an offer to THIS connection, not a chronicle line.
    if (useReportStore.getState().ingest(frame)) return
    useSessionStore.getState().ingest(frame)
  },
}))
