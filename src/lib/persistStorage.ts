// The storage the studio's persisted stores write through.
//
// zustand's `persist` calls `setItem` synchronously inside `set(...)`, on every
// keystroke. A browser throws there for reasons that have nothing to do with
// the edit in progress — a full quota, a private window, a disabled storage
// origin — and an exception raised inside `set` aborts the state update itself:
// the author's typing stops working, in an app whose whole point is authoring.
//
// So persistence is best-effort here, exactly as `store/panels.ts` has always
// treated its two settings keys. What is on screen is the truth; what is in
// localStorage is a convenience for the next launch. Losing the second must
// never cost the first.
//
// EVERY persisted store in the app goes through this — the forge's projects,
// the wizard's sessions, the pack bench, the split workbench, the preset
// library, the AI provider settings, the host-local home and the theme. The
// quota is shared across all of them, so the store that throws is rarely the
// store that filled it: guarding only the big ones would mean the theme toggle
// takes down whatever the author was typing.

import { createJSONStorage } from "zustand/middleware"

/** Set when a write has failed. Nothing renders it today — it exists so a
 * "your work is not being saved" notice has something to read, and so the
 * failure is not purely invisible in a console-less desktop build. */
let degraded = false

/** Has a persisted write failed this session? */
export function persistenceDegraded(): boolean {
  return degraded
}

/** For tests. */
export function resetPersistenceState(): void {
  degraded = false
}

/** localStorage with every operation wrapped. A read that throws is "nothing
 * stored", which is also what a first launch looks like — the store falls back
 * to its initial state and carries on. */
export const guardedLocalStorage = createJSONStorage(() => ({
  getItem: (name: string): string | null => {
    try {
      return globalThis.localStorage?.getItem(name) ?? null
    } catch {
      return null
    }
  },
  setItem: (name: string, value: string): void => {
    try {
      globalThis.localStorage?.setItem(name, value)
    } catch {
      // Quota, private mode, a blocked origin. The edit that triggered this
      // write has already landed in memory and must stay there.
      degraded = true
    }
  },
  removeItem: (name: string): void => {
    try {
      globalThis.localStorage?.removeItem(name)
    } catch {
      degraded = true
    }
  },
}))
