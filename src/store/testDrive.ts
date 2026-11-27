// "Verify this pack": the engine's own installer, run on the pack the builder just wrote,
// into a scratch data directory (`lib/packInstall.ts`). It proves what a server would do with
// the file — validate every part again and install it — without touching anybody's server.
//
// Playing the pack is the next step and needs a running 3.0 server: Studio shows the trust
// card and the exact commands (`features/studio/pack/testDrive.ts`), and does not host one.

import { create } from "zustand"
import { isTauri } from "../lib/transport"
import { verifyPackInstall, type PackVerification } from "../lib/packInstall"
import type { EngineCandidate } from "../lib/native"

export type VerifyPhase = "idle" | "verifying" | "verified" | "refused" | "error"

export interface VerifyRequest {
  candidate: EngineCandidate
  /** The `.lwpack` the engine just built. */
  packPath: string
}

interface VerifyState {
  phase: VerifyPhase
  verification: PackVerification | null
  /** An i18n key (`testDrive.err.*`) or a verbatim OS/engine message. */
  error: string | null
  run: (request: VerifyRequest) => Promise<void>
  reset: () => void
}

const IDLE = { phase: "idle" as const, verification: null, error: null }

export const useTestDriveStore = create<VerifyState>()((set) => ({
  ...IDLE,
  reset: () => set({ ...IDLE }),
  run: async (request) => {
    if (!isTauri()) {
      set({ ...IDLE, phase: "error", error: "testDrive.err.desktopOnly" })
      return
    }
    set({ ...IDLE, phase: "verifying" })
    try {
      const verification = await verifyPackInstall(request.candidate, request.packPath)
      const install = verification.install
      if (install === null) {
        const run = verification.installRun
        set({
          phase: "error",
          verification,
          error: run.stderr.trim() || run.stdout.trim() || "testDrive.err.noAnswer",
        })
        return
      }
      set({ phase: install.ok ? "verified" : "refused", verification })
    } catch (cause) {
      set({ phase: "error", error: cause instanceof Error ? cause.message : String(cause) })
    }
  },
}))

/** Whether a failure message is one of our i18n keys (vs. a message shown verbatim). */
export function isTestDriveErrorKey(error: string): boolean {
  return error.startsWith("testDrive.err.")
}
