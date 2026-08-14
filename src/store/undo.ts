// Snapshot undo for deletes.
//
// The studio had no undo at all — only two "this cannot be undone" strings,
// which is a warning, not a safety net. This is the smallest thing that is
// genuinely one: every delete pushes a closure that puts the thing back, and a
// toast offers it for a few seconds.
//
// Deliberately NOT an editor undo stack. It covers deletions only, it does not
// coalesce or replay keystrokes, and it is in-memory: a closure cannot be
// serialized, and an undo that survives a reload would promise more than a
// snapshot can honestly deliver (the thing it restores may have been rebuilt in
// the meantime). Losing the offer on reload is the safe failure.

import { create } from "zustand"

/** What was deleted, for the toast's wording. */
export type UndoKind =
  | "project"
  | "variable"
  | "loreEntry"
  | "pregen"
  | "packItem"
  | "panelFile"
  | "skill"
  | "subject"
  | "cue"
  | "episode"

export interface UndoEntry {
  id: number
  kind: UndoKind
  /** The deleted thing's own name, for the toast. May be empty. */
  name: string
  /** Puts it back. Called at most once. */
  restore: () => void
  /** Epoch ms, so the toast can expire without a timer per entry. */
  at: number
}

/** How long an offer stands. Long enough to notice a mistake and reach for it,
 * short enough that the toast is not furniture. */
export const UNDO_WINDOW_MS = 12_000

/** Depth of the stack. Deep enough for a run of deletions, shallow enough that
 * it never becomes a place data hides. */
const MAX_DEPTH = 20

interface UndoState {
  entries: UndoEntry[]
  /** Record a delete. Returns the entry id. */
  push: (kind: UndoKind, name: string, restore: () => void) => number
  /** Undo the newest offer, if any. */
  undo: () => void
  /** Drop one offer without performing it (the toast was dismissed). */
  dismiss: (id: number) => void
  clear: () => void
}

let nextId = 1

export const useUndoStore = create<UndoState>()((set, get) => ({
  entries: [],

  push: (kind, name, restore) => {
    const id = nextId++
    set((state) => ({
      entries: [...state.entries, { id, kind, name, restore, at: Date.now() }].slice(-MAX_DEPTH),
    }))
    return id
  },

  undo: () => {
    const entries = get().entries
    const entry = entries.at(-1)
    if (entry === undefined) return
    set({ entries: entries.slice(0, -1) })
    entry.restore()
  },

  dismiss: (id) => set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),

  clear: () => set({ entries: [] }),
}))

/** The offer to show, or null when the newest one has aged out. Reading the
 * clock here (rather than expiring on a timer) keeps the store free of
 * scheduling: the component re-renders on its own tick and the entry simply
 * stops being current. */
export function currentUndo(entries: UndoEntry[], now: number): UndoEntry | null {
  const entry = entries.at(-1)
  if (entry === undefined) return null
  return now - entry.at <= UNDO_WINDOW_MS ? entry : null
}
