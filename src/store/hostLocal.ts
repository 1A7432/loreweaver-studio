// One-click local hosting state. `start` brings the server up through the
// Rust bridge, the event stream lands here, and the moment the ticket +
// auto-minted keeper key arrive we dial the connection — the TUI's "Host
// locally & play" in one press. Quitting the table stops the server we
// started (and only then; reconnects never kill it).

import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import {
  hostLocalStart,
  hostLocalStatus,
  hostLocalStop,
  onHostLocalEvent,
  type HostLocalEvent,
} from "../lib/hostLocal"
import { isTauri } from "../lib/transport"
import { useAiStore } from "../features/studio/ai/provider"
import { useConnectionStore } from "./connection"

const MAX_LOG_LINES = 400

export type HostLocalPhase = "idle" | "starting" | "ready" | "error"

interface HostLocalState {
  phase: HostLocalPhase
  log: string[]
  error: string | null
  /** Whether the CURRENT connection came from our own local server. */
  hostedSession: boolean
  /** User-picked server folder ("" = the TUI-shared default chain). Persisted. */
  homeOverride: string
  /** The resolved effective home, for display (refreshed by refreshHome). */
  effectiveHome: string
  /** The dev-room source root the RUNNING server was started with ("" = none).
   * `TRPG_DEV__SOURCE_ROOT` is read at startup, so a caller that needs a
   * different one has to restart rather than reconfigure. */
  devSourceRoot: string

  setHomeOverride: (path: string) => void
  refreshHome: () => Promise<void>
  start: (devSourceRoot?: string) => Promise<void>
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
      hostedSession: false,
      homeOverride: "",
      effectiveHome: "",
      devSourceRoot: "",

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
        set({ phase: "starting", log: [], error: null, hostedSession: false, devSourceRoot })
        try {
          await subscribeOnce(get().ingest)
          await hostLocalStart(
            useAiStore.getState().engineRepoDir.trim() || undefined,
            get().homeOverride.trim() || undefined,
            devSourceRoot || undefined,
          )
        } catch (cause) {
          set({ phase: "error", error: cause instanceof Error ? cause.message : String(cause) })
        }
      },

      stop: async () => {
        try {
          await hostLocalStop()
        } catch {
          // Nothing to stop is fine.
        }
        set({ phase: "idle", hostedSession: false, devSourceRoot: "" })
      },

      ingest: (event) => {
        switch (event.kind) {
          case "log":
            set((s) => ({ log: [...s.log.slice(-(MAX_LOG_LINES - 1)), event.text] }))
            return
          case "ready":
            set({ phase: "ready", hostedSession: true })
            void useConnectionStore.getState().connect({ ticket: event.ticket, key: event.key })
            return
          case "exit":
            set((s) =>
              s.phase === "starting"
                ? { phase: "error", error: "the local server exited before it was ready" }
                : { phase: "idle", hostedSession: false },
            )
            return
          case "error":
            set({ phase: "error", error: event.message })
            return
        }
      },
    }),
    {
      name: "loreweaver-studio-host-local",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ homeOverride: s.homeOverride }),
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
