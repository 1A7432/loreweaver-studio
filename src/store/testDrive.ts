// "Test this pack now" — the orchestration behind one button.
//
// Build+install used to be the end of the road: to play what you just built you
// switched to Play, started a server, and retyped import commands with
// server-side paths. This store runs that whole sequence, and its phases are
// the progress the author watches.
//
// Installing goes through `lib/packInstall.ts`, which every install path in the
// studio shares: the pack lands in the LOCAL SERVER's data dir, because that is
// the one the app itself will serve from. See that file for why.

import { create } from "zustand"
import { planTestDrive, readInstalledManifest, type TestDriveMode } from "../features/studio/pack/testDrive"
import { readFileByPath, type EngineCandidate } from "../lib/native"
import { installPack } from "../lib/packInstall"
import { isTauri, transportSend } from "../lib/transport"
import { useAppStore } from "./app"
import { useConnectionStore } from "./connection"
import { useHostLocalStore } from "./hostLocal"

/** The author-visible progress: installing → host starting → connected →
 * importing → ready. */
export type TestDrivePhase =
  "idle" | "installing" | "starting" | "connecting" | "importing" | "ready" | "error"

/** How long to wait for the local server + join handshake. `host_local.rs`
 * gives the server itself 90s to print a ticket; the dial adds a little. */
const CONNECT_TIMEOUT_MS = 120_000
/** Between two keeper commands. The engine answers each one on the same
 * control stream, and a world import does real work (hooks, variable tree);
 * pacing them keeps the log readable and the replies in order. */
const COMMAND_GAP_MS = 400
const POLL_MS = 250

export interface TestDriveRequest {
  candidate: EngineCandidate
  /** The `.lwpack` the engine just built. */
  packPath: string
  packId: string
  packVersion: string
  /** The pack SOURCE tree on disk. Only `mount-source` needs it. */
  sourceDir?: string
  /** Skills and rulepacks are loaded when the server STARTS, so a pack that
   * ships them needs the server restarted after the install — an already
   * running one would play the module without its skills. */
  carriesSkillsOrRulepacks: boolean
  mode?: TestDriveMode
}

interface TestDriveState {
  phase: TestDrivePhase
  /** The commands the plan issued, for display. */
  commands: string[]
  /** How many of them have gone out. */
  sent: number
  /** An i18n key (`testDrive.*`) or a verbatim engine/OS message. */
  error: string | null
  /** The data dir the pack was installed into, for display. */
  dataDir: string | null
  run: (request: TestDriveRequest) => Promise<void>
  reset: () => void
}

const IDLE = {
  phase: "idle" as const,
  commands: [] as string[],
  sent: 0,
  error: null,
  dataDir: null,
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Wait until `predicate` holds or the deadline passes. Polling (rather than a
 * store subscription) keeps this readable and cancels cleanly on timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(POLL_MS)
  }
  return predicate()
}

export const useTestDriveStore = create<TestDriveState>()((set) => ({
  ...IDLE,

  reset: () => set({ ...IDLE }),

  run: async (request) => {
    if (!isTauri()) {
      set({ ...IDLE, phase: "error", error: "testDrive.err.desktopOnly" })
      return
    }
    if (request.mode === "mount-source") {
      await mountSource(set, request)
      return
    }
    set({ ...IDLE, phase: "installing" })

    try {
      // 1. Install into the data dir the LOCAL SERVER reads. The same helper
      //    every other install path in the studio uses, so the bench button and
      //    this button can never land a pack in two different places.
      const homeOverride = useHostLocalStore.getState().homeOverride
      const install = await installPack(request.candidate, request.packPath, homeOverride)
      set({ dataDir: install.dataDir })
      if (install.result.code !== 0) {
        set({
          phase: "error",
          error:
            install.result.stderr.trim() || install.result.stdout.trim() || "testDrive.err.installFailed",
        })
        return
      }

      // 2. Plan from the manifest the install just wrote: it carries the
      //    ENGINE's detected card kinds, and it is the only thing that exists
      //    when the author adopted a source tree rather than dropping files.
      const manifestPath = `${install.dataDir}/packs/${request.packId}@${request.packVersion}/pack.yaml`
      let source
      try {
        const manifest = await readFileByPath(manifestPath)
        source = readInstalledManifest(new TextDecoder("utf-8").decode(manifest.bytes))
      } catch {
        source = null
      }
      if (source === null) {
        set({ phase: "error", error: "testDrive.err.noManifest" })
        return
      }
      const plan = planTestDrive(source, request.mode)
      set({ commands: plan.commands })
      if (plan.emptyReason !== null) {
        set({ phase: "error", error: `testDrive.err.${plan.emptyReason}` })
        return
      }

      // 3. Bring the local server up. A running one already holds its skill and
      //    rulepack registries, so a pack that ships either needs a restart.
      set({ phase: "starting" })
      const host = useHostLocalStore.getState()
      const serving = host.phase === "ready" && useConnectionStore.getState().status === "online"
      if (serving && request.carriesSkillsOrRulepacks) {
        await useHostLocalStore.getState().stop()
        await useConnectionStore.getState().disconnect()
      }
      if (!serving || request.carriesSkillsOrRulepacks) {
        await useHostLocalStore.getState().start()
      }

      // 4. `hostLocal` dials the moment the server announces its ticket + key.
      set({ phase: "connecting" })
      const online = await waitFor(() => {
        const state = useConnectionStore.getState()
        return state.status === "online" && state.welcome !== null
      }, CONNECT_TIMEOUT_MS)
      if (!online) {
        const reason = useHostLocalStore.getState().error ?? useConnectionStore.getState().lastError
        set({ phase: "error", error: reason ?? "testDrive.err.connectTimeout" })
        return
      }
      // World import is keeper-only (`cmd_import` refuses it outright for a
      // player), so say so here rather than letting the engine reject each
      // command one by one.
      if (useConnectionStore.getState().welcome?.you.role !== "keeper") {
        set({ phase: "error", error: "testDrive.err.notKeeper" })
        return
      }

      // 5. Issue the imports, then hand the author the live table.
      set({ phase: "importing", sent: 0 })
      for (const command of plan.commands) {
        await transportSend({ type: "input", text: command })
        set((state) => ({ sent: state.sent + 1 }))
        await sleep(COMMAND_GAP_MS)
      }
      set({ phase: "ready" })
      useAppStore.getState().setMode("play")
    } catch (cause) {
      set({ phase: "error", error: cause instanceof Error ? cause.message : String(cause) })
    }
  },
}))

/** The dev-room path: no build, no install. The server is (re)started with
 * `TRPG_DEV__SOURCE_ROOT` pointing at the source tree's PARENT — the engine
 * confines every mount under that root and the whole surface is off while it is
 * unset — and one `.dev mount` hands the tree to the room, which then follows
 * every save. The root is read at STARTUP, so a server already running without
 * it (or with a different one) has to be restarted, not reconfigured. */
async function mountSource(
  set: (partial: Partial<TestDriveState> | ((state: TestDriveState) => Partial<TestDriveState>)) => void,
  request: TestDriveRequest,
): Promise<void> {
  const sourceDir = (request.sourceDir ?? "").trim()
  const plan = planTestDrive({ packId: request.packId, cards: [], lorebooks: [] }, "mount-source", sourceDir)
  set({ ...IDLE, phase: "starting", commands: plan.commands })
  if (plan.emptyReason !== null) {
    set({ phase: "error", error: `testDrive.err.${plan.emptyReason}` })
    return
  }
  // The parent, not the tree itself: the author will mount siblings next.
  const root = sourceDir.replace(/\/[^/]+\/?$/, "") || sourceDir

  try {
    const host = useHostLocalStore.getState()
    const ready = host.phase === "ready" && useConnectionStore.getState().status === "online"
    if (!ready || host.devSourceRoot !== root) {
      if (ready) {
        await useHostLocalStore.getState().stop()
        await useConnectionStore.getState().disconnect()
      }
      await useHostLocalStore.getState().start(root)
    }

    set({ phase: "connecting" })
    const online = await waitFor(() => {
      const state = useConnectionStore.getState()
      return state.status === "online" && state.welcome !== null
    }, CONNECT_TIMEOUT_MS)
    if (!online) {
      const reason = useHostLocalStore.getState().error ?? useConnectionStore.getState().lastError
      set({ phase: "error", error: reason ?? "testDrive.err.connectTimeout" })
      return
    }
    if (useConnectionStore.getState().welcome?.you.role !== "keeper") {
      set({ phase: "error", error: "testDrive.err.notKeeper" })
      return
    }

    set({ phase: "importing", sent: 0 })
    for (const command of plan.commands) {
      await transportSend({ type: "input", text: command })
      set((state) => ({ sent: state.sent + 1 }))
      await sleep(COMMAND_GAP_MS)
    }
    set({ phase: "ready" })
    useAppStore.getState().setMode("play")
  } catch (cause) {
    set({ phase: "error", error: cause instanceof Error ? cause.message : String(cause) })
  }
}

/** Whether a failure message is one of our i18n keys (vs. an engine/OS string
 * that must be shown verbatim). */
export function isTestDriveErrorKey(error: string): boolean {
  return error.startsWith("testDrive.err.")
}
