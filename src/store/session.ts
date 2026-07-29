import { create } from "zustand"
import type {
  DiceFrame,
  NarrativeFrame,
  PresenceFrame,
  ServerFrame,
  StateFrame,
  SystemFrame,
} from "@loreweaver/protocol"

/** Scrollback cap, mirroring the reference TUI client. */
export const MAX_LOG_ENTRIES = 200
/** Cap one streaming message so a runaway stream cannot grow without bound. */
export const MAX_STREAM_TEXT = 20_000
/** Safety timeout for a lost `turn_status idle` frame (the protocol asks clients to apply one). */
export const TURN_BUSY_TIMEOUT_MS = 120_000

export type LogEntry =
  | { seq: number; kind: "narrative"; frame: NarrativeFrame }
  | { seq: number; kind: "dice"; frame: DiceFrame }
  | { seq: number; kind: "system"; frame: SystemFrame }

export interface TurnState {
  busy: boolean
  actor: string | null
  /** Epoch ms of the busy frame, for the safety timeout. */
  since: number
}

interface SessionState {
  entries: LogEntry[]
  game: StateFrame | null
  presence: PresenceFrame | null
  turn: TurnState
  /** Feed one validated server frame into the session. */
  ingest: (frame: ServerFrame, now?: number) => void
  /** Clear a stale busy indicator once the safety timeout has elapsed. */
  expireTurnSafety: (now: number) => void
  clear: () => void
}

let nextSeq = 1

const IDLE_TURN: TurnState = { busy: false, actor: null, since: 0 }

function pushEntry(entries: LogEntry[], entry: Omit<LogEntry, "seq">): LogEntry[] {
  return [...entries, { ...entry, seq: nextSeq++ } as LogEntry].slice(-MAX_LOG_ENTRIES)
}

/**
 * Narrative merge rules (matching the reference TUI, plus replay dedup):
 * - a `stream:true` chunk appends its text delta to the entry with the same id
 *   (creating it if new) and carries the `done` flag forward;
 * - a plain frame whose id is already present is a history replay duplicate
 *   (the server replays recent narrative on every join) and is dropped;
 * - anything else is a fresh line.
 */
function ingestNarrative(entries: LogEntry[], frame: NarrativeFrame): LogEntry[] {
  const index = entries.findIndex((e) => e.kind === "narrative" && e.frame.id === frame.id)
  if (frame.stream) {
    if (index === -1) return pushEntry(entries, { kind: "narrative", frame })
    const existing = entries[index] as Extract<LogEntry, { kind: "narrative" }>
    const merged: NarrativeFrame = {
      ...existing.frame,
      text: (existing.frame.text + frame.text).slice(0, MAX_STREAM_TEXT),
      done: frame.done,
    }
    const next = [...entries]
    next[index] = { ...existing, frame: merged }
    return next
  }
  if (index !== -1) return entries
  return pushEntry(entries, { kind: "narrative", frame })
}

export const useSessionStore = create<SessionState>((set) => ({
  entries: [],
  game: null,
  presence: null,
  turn: IDLE_TURN,

  ingest: (frame, now = Date.now()) => {
    switch (frame.type) {
      case "narrative":
        set((s) => ({ entries: ingestNarrative(s.entries, frame) }))
        return
      case "dice":
        set((s) => ({ entries: pushEntry(s.entries, { kind: "dice", frame }) }))
        return
      case "system":
        set((s) => ({ entries: pushEntry(s.entries, { kind: "system", frame }) }))
        return
      case "state":
        // `reset:true` marks the snapshot right after a campaign wipe: the
        // panel data is already fresh and the scrollback must go too.
        set((s) => ({ game: frame, entries: frame.reset ? [] : s.entries }))
        return
      case "presence":
        set({ presence: frame })
        return
      case "turn_status":
        set(
          frame.status === "busy"
            ? { turn: { busy: true, actor: frame.actor, since: now } }
            : { turn: IDLE_TURN },
        )
        return
      default:
        // Media, audio, admin, ui (rendered from the next milestone on), pong…
        // are no-ops here; unknown frame types are ignored by design.
        return
    }
  },

  expireTurnSafety: (now) => {
    set((s) => (s.turn.busy && now - s.turn.since >= TURN_BUSY_TIMEOUT_MS ? { turn: IDLE_TURN } : s))
  },

  clear: () => set({ entries: [], game: null, presence: null, turn: IDLE_TURN }),
}))
