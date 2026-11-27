// "Host locally & play": the state of the one local server this app may run, and
// the press that brings it up and sits the person down at it as the room admin.
//
// `start` asks Rust to start the server (it finds the engine, starts `serve`, reachable
// over the public relays so the ticket is the one to hand to friends, waits for the ready
// line and hands back the ticket and the admin key) and dials it through the normal
// connection owner, the way any pasted ticket is dialled: with the profile Rust reports
// (`n0`). The key goes from Rust's answer straight into the connection and is kept
// nowhere here: pressing the button again while that server runs (after a reload, say)
// gets the same answer back from Rust (`reused`). Leaving the hosted table stops the
// server; a server that dies on its own ends the table and says so, with its last lines.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import i18n from "../i18n"
import type { Connection } from "../lib/connection"
import {
  asHostFailure,
  hostLocalForgetKey,
  hostLocalStart,
  hostLocalStatus,
  hostLocalStop,
  onHostLocalExit,
  type HostExited,
  type HostFailure,
  type KeySource,
} from "../lib/hostLocal"
import { guardedLocalStorage } from "../lib/persistStorage"
import { isTauri } from "../lib/transport"
import { useAiStore } from "../features/studio/ai/provider"
import { useConnectionStore } from "./connection"

export type HostPhase = "idle" | "starting" | "hosting" | "failed"

/** Why hosting is not going: what Rust answered, or what happened after. */
export type HostProblem =
  | HostFailure
  /** The hosted server stopped on its own. */
  | { code: "died"; exitCode: number | null; stderr: string[] }
  /** The server turned down the admin key this app kept; it has been forgotten. */
  | { code: "key_refused" }
  | { code: "desktop_only" }

/** What is shown about the hosted server (never its key). */
export interface Hosted {
  hostId: string
  dataDir: string
  room: string
  keySource: KeySource
  notes: string[]
}

interface HostLocalState {
  phase: HostPhase
  problem: HostProblem | null
  hosted: Hosted | null
  /** The connection to the hosted server, while it is the current one. */
  connection: Connection | null
  /** The start-up notes were read and put away. */
  notesDismissed: boolean
  /** The folder the person picked ("" = the default in this app's data folder). Persisted. */
  homeOverride: string
  /** The folder a start would use now, for display. */
  effectiveHome: string
  /** A server this app started is running (seen when the screen opened). */
  running: boolean

  setHomeOverride: (path: string) => void
  refresh: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
  dismissNotes: () => void
  onExited: (event: HostExited) => void
}

let subscribed: Promise<unknown> | null = null
/** Every start and stop takes the next number: an answer for an older one is stale. */
let attempts = 0

function homeOverride(): string | undefined {
  return useHostLocalStore.getState().homeOverride.trim() || undefined
}

export const useHostLocalStore = create<HostLocalState>()(
  persist(
    (set, get) => ({
      phase: "idle",
      problem: null,
      hosted: null,
      connection: null,
      notesDismissed: false,
      homeOverride: "",
      effectiveHome: "",
      running: false,

      setHomeOverride: (path) => {
        set({ homeOverride: path })
        void get().refresh()
      },

      refresh: async () => {
        if (!isTauri()) return
        try {
          const status = await hostLocalStatus(homeOverride())
          set({ effectiveHome: status.home, running: status.running })
        } catch {
          // Display only; a start says what is wrong.
        }
      },

      start: async () => {
        if (!isTauri()) {
          set({ phase: "failed", problem: { code: "desktop_only" } })
          return
        }
        if (get().phase === "starting") return
        const attempt = ++attempts
        set({ phase: "starting", problem: null, hosted: null, notesDismissed: false })
        subscribed ??= onHostLocalExit((event) => useHostLocalStore.getState().onExited(event))
        let ready
        try {
          await subscribed
          ready = await hostLocalStart({
            engineRepoDir: useAiStore.getState().engineRepoDir.trim() || undefined,
            homeOverride: homeOverride(),
            locale: i18n.resolvedLanguage ?? i18n.language,
          })
        } catch (cause) {
          if (attempt !== attempts) return
          set({ phase: "failed", problem: asHostFailure(cause), running: false })
          return
        }
        if (attempt !== attempts) {
          // Stopped while starting, and the stop may have reached Rust before the start
          // did: a server is up that nobody wants. Stop it again.
          void hostLocalStop().catch(() => undefined)
          return
        }
        const hosted: Hosted = {
          hostId: ready.hostId,
          dataDir: ready.dataDir,
          room: ready.room,
          keySource: ready.keySource,
          notes: ready.notes,
        }
        set({ phase: "hosting", hosted, running: true })
        await useConnectionStore
          .getState()
          .connect({ ticket: ready.ticket, key: ready.key, network: ready.network })
        const connection = useConnectionStore.getState().connection
        if (attempt !== attempts || connection === null) return
        set({ connection })
        // The server turned the kept key down (an admin revoked it): forget it, so the
        // next start makes a new one, and stop the server it is no use for.
        const unsubscribe = connection.subscribe(() => {
          const state = connection.getState()
          if (state.phase !== "ended") return
          unsubscribe()
          if (state.failure?.kind !== "refused" || state.failure.code !== "bad_key") return
          if (get().connection !== connection) return
          attempts += 1
          set({ phase: "failed", problem: { code: "key_refused" }, hosted: null, connection: null })
          void hostLocalForgetKey(homeOverride())
            .catch(() => undefined)
            .then(() => hostLocalStop())
            .catch(() => undefined)
            .then(() => get().refresh())
        })
      },

      stop: async () => {
        attempts += 1
        const connection = get().connection
        set({ phase: "idle", problem: null, hosted: null, connection: null })
        if (connection !== null && useConnectionStore.getState().connection === connection) connection.stop()
        try {
          await hostLocalStop()
        } catch {
          // Nothing to stop.
        }
        set({ running: false })
      },

      dismissNotes: () => set({ notesDismissed: true }),

      onExited: (event) => {
        if (get().hosted?.hostId !== event.hostId) return
        attempts += 1
        const connection = get().connection
        set({
          phase: "failed",
          problem: { code: "died", exitCode: event.code, stderr: event.stderr },
          hosted: null,
          connection: null,
          running: false,
        })
        // The ticket is gone for good: the table ends instead of redialling it.
        if (connection !== null && useConnectionStore.getState().connection === connection) connection.stop()
      },
    }),
    {
      name: "loreweaver-studio-host-local",
      version: 1,
      storage: guardedLocalStorage,
      partialize: (state) => ({ homeOverride: state.homeOverride }),
      // Version 0 (2.x) also kept a server ticket and key here; only the folder survives.
      migrate: (persisted) => {
        const old = (persisted ?? {}) as { homeOverride?: unknown }
        return { homeOverride: typeof old.homeOverride === "string" ? old.homeOverride : "" }
      },
    },
  ),
)

/** Whether the current connection is the one to the server this app hosts. */
export function useIsHostedTable(): boolean {
  const hosted = useHostLocalStore((state) => state.connection)
  const current = useConnectionStore((slot) => slot.connection)
  return hosted !== null && hosted === current
}

/** Leave the table; when it is the one this app hosts, stop its server too. */
export async function quitTable(): Promise<void> {
  const host = useHostLocalStore.getState()
  const hosted = host.connection !== null && host.connection === useConnectionStore.getState().connection
  await useConnectionStore.getState().disconnect()
  if (hosted) await host.stop()
}
