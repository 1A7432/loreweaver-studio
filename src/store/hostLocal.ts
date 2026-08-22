// One-click local hosting state. `start` brings the server up through the
// Rust bridge, the event stream lands here, and the moment the ticket +
// auto-minted keeper key arrive we dial the connection — the TUI's "Host
// locally & play" in one press. Quitting the table stops the server we
// started (and only then; reconnects never kill it).

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { guardedLocalStorage } from "../lib/persistStorage"
import {
  hostEventApplies,
  hostLocalStart,
  hostLocalStatus,
  hostLocalStop,
  mintHostId,
  onHostLocalEvent,
  type HostLocalEvent,
} from "../lib/hostLocal"
import { isTauri } from "../lib/transport"
import { useAiStore } from "../features/studio/ai/provider"
import { useConnectionStore } from "./connection"

const MAX_LOG_LINES = 400

export type HostLocalPhase = "idle" | "starting" | "ready" | "error"
export type HostLocalExitKind = "before-ready" | "unexpected"

interface HostLocalState {
  phase: HostLocalPhase
  log: string[]
  error: string | null
  /** Structured death of THIS host session. The connect screen translates it. */
  exitKind: HostLocalExitKind | null
  exitCode: number | null
  /** Host session the WebView currently accepts events for. Minted on start,
   * adopted from `host_local_status` after a reload. */
  hostId: string | null
  /** After an explicit stop, only the confirming Exit for this id is accepted. */
  stoppingHostId: string | null
  /** Whether the CURRENT connection came from our own local server. */
  hostedSession: boolean
  /** User-picked server folder ("" = the TUI-shared default chain). Persisted. */
  homeOverride: string
  /** The resolved effective home, for display (refreshed by refreshHome). */
  effectiveHome: string
  /** The credentials the LAST server we started handed us, kept for the home they
   * belong to. Persisted, because the case they exist for is the front end coming
   * back without them: the WebView reloads, the Rust side is still serving, and
   * `start` can then only answer "a local server is already running" — a dead end
   * that made a keeper dig a ticket out of a text file to sit back down at their own
   * table (2026-08-20 play-test). Local credentials for a local server, stored beside
   * the API key this app already keeps. */
  lastTicket: string
  lastKey: string
  lastTicketHome: string
  /** The dev-room source root the RUNNING server was started with ("" = none).
   * `TRPG_DEV__SOURCE_ROOT` is read at startup, so a caller that needs a
   * different one has to restart rather than reconfigure. */
  devSourceRoot: string

  setHomeOverride: (path: string) => void
  refreshHome: () => Promise<void>
  start: (devSourceRoot?: string) => Promise<void>
  /** Sit back down at a server this app already started; false when there is none
   * to sit at (or its credentials belong to another home). */
  reconnectIfServing: () => Promise<boolean>
  stop: () => Promise<void>
  ingest: (event: HostLocalEvent) => void
}

let subscribed = false

async function subscribeOnce(ingest: (event: HostLocalEvent) => void): Promise<void> {
  if (subscribed) return
  subscribed = true
  await onHostLocalEvent(ingest)
}

export const useHostLocalStore = create<HostLocalState>()(
  persist(
    (set, get) => ({
      phase: "idle",
      log: [],
      error: null,
      exitKind: null,
      exitCode: null,
      hostId: null,
      stoppingHostId: null,
      hostedSession: false,
      homeOverride: "",
      effectiveHome: "",
      devSourceRoot: "",
      lastTicket: "",
      lastKey: "",
      lastTicketHome: "",

      setHomeOverride: (path) => {
        set({ homeOverride: path })
        void get().refreshHome()
      },

      refreshHome: async () => {
        if (!isTauri()) return
        try {
          const status = await hostLocalStatus(get().homeOverride.trim() || undefined)
          set({ effectiveHome: status.home })
        } catch {
          // Display-only; the start path surfaces real errors.
        }
      },

      start: async (devSourceRoot = "") => {
        if (!isTauri()) {
          set({ phase: "error", error: "local hosting needs the desktop app" })
          return
        }
        if (get().phase === "starting") return
        const hostId = mintHostId()
        set({
          phase: "starting",
          log: [],
          error: null,
          exitKind: null,
          exitCode: null,
          hostedSession: false,
          devSourceRoot,
          hostId,
          stoppingHostId: null,
        })
        try {
          await subscribeOnce(get().ingest)
          // Already serving? Then this press means "sit me back down", not "start one":
          // the Rust side would refuse, and refusing is the whole dead end.
          if (await get().reconnectIfServing()) return
          await hostLocalStart(
            useAiStore.getState().engineRepoDir.trim() || undefined,
            get().homeOverride.trim() || undefined,
            devSourceRoot || undefined,
            get().hostId ?? hostId,
          )
        } catch (cause) {
          set({ phase: "error", error: cause instanceof Error ? cause.message : String(cause) })
        }
      },

      reconnectIfServing: async () => {
        if (!isTauri()) return false
        let status
        try {
          status = await hostLocalStatus(get().homeOverride.trim() || undefined)
        } catch {
          return false
        }
        const { lastTicket, lastKey, lastTicketHome } = get()
        // Credentials belong to the home that minted them: a different folder is a
        // different server with different keys, and dialing it with these would fail
        // in a way that reads like a bug rather than a mismatch.
        if (!status.running || !lastTicket || !lastKey || lastTicketHome !== status.home) return false
        // Adopt the live child's id so a later Exit (and only that child's
        // Exit) still reaches ingest after a WebView reload.
        set({
          phase: "ready",
          hostedSession: true,
          error: null,
          exitKind: null,
          exitCode: null,
          hostId: status.hostId ?? get().hostId,
          stoppingHostId: null,
        })
        await useConnectionStore.getState().connect({ ticket: lastTicket, key: lastKey })
        return true
      },

      stop: async () => {
        // Invalidate the current id first so a late Ready cannot revive us.
        // Keep it as stoppingHostId so the confirming Exit is still applied
        // (and only as a confirmation — we are already idle).
        const current = get().hostId
        set({
          phase: "idle",
          hostedSession: false,
          devSourceRoot: "",
          error: null,
          exitKind: null,
          exitCode: null,
          hostId: null,
          stoppingHostId: current,
        })
        try {
          await hostLocalStop()
        } catch {
          // Nothing to stop is fine.
        }
      },

      ingest: (event) => {
        if (!hostEventApplies(event, get().hostId, get().stoppingHostId)) return
        switch (event.kind) {
          case "log":
            set((s) => ({ log: [...s.log.slice(-(MAX_LOG_LINES - 1)), event.text] }))
            return
          case "ready":
            set({
              phase: "ready",
              hostedSession: true,
              lastTicket: event.ticket,
              lastKey: event.key,
              error: null,
              exitKind: null,
              exitCode: null,
            })
            // Which home these credentials belong to is a question only the Rust side
            // can answer, and `ingest` is synchronous — so ask, and record what comes
            // back. `effectiveHome` may never have been refreshed in this session.
            void hostLocalStatus(get().homeOverride.trim() || undefined)
              .then((status) => set({ lastTicketHome: status.home, effectiveHome: status.home }))
              .catch(() => {})
            void useConnectionStore.getState().connect({ ticket: event.ticket, key: event.key })
            return
          case "exit":
            set((s) => {
              if (s.stoppingHostId !== null && event.hostId === s.stoppingHostId) {
                return { stoppingHostId: null }
              }
              if (s.phase === "starting") {
                return {
                  phase: "error" as const,
                  hostedSession: false,
                  exitKind: "before-ready" as const,
                  exitCode: event.code,
                  hostId: null,
                }
              }
              if (s.phase === "ready" || s.hostedSession) {
                return {
                  phase: "error" as const,
                  hostedSession: false,
                  exitKind: "unexpected" as const,
                  exitCode: event.code,
                  hostId: null,
                }
              }
              // A readiness Error already named the failure. Clear the id so
              // a late Ready for this dead child cannot revive the session.
              return { hostId: null }
            })
            return
          case "error":
            set({ phase: "error", error: event.message })
            return
        }
      },
    }),
    {
      name: "loreweaver-studio-host-local",
      storage: guardedLocalStorage,
      partialize: (s) => ({
        homeOverride: s.homeOverride,
        lastTicket: s.lastTicket,
        lastKey: s.lastKey,
        lastTicketHome: s.lastTicketHome,
      }),
    },
  ),
)

/** Disconnect from the table; when we hosted the server ourselves, stop it
 * too (the TUI's quit semantics). Reconnect logic never routes through here. */
export async function quitTable(): Promise<void> {
  const host = useHostLocalStore.getState()
  await useConnectionStore.getState().disconnect()
  if (host.hostedSession) await host.stop()
}
