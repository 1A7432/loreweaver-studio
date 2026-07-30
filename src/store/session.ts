import { create } from "zustand"
import type {
  DiceFrame,
  NarrativeFrame,
  PresenceFrame,
  ServerFrame,
  StateFrame,
  SystemFrame,
  UiFrame,
} from "@loreweaver/protocol"
import { usePanelsStore } from "./panels"

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
  | { seq: number; kind: "ui"; frame: UiFrame }

/** One named sidebar region fed by `ui` frames (later same-key frames replace it). */
export interface UiPanelRegion {
  key: string
  frame: UiFrame
}

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
  uiPanels: UiPanelRegion[]
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

/**
 * Inline `ui` frames land in the chronicle. With `replace:true` and a matching
 * `id`, the latest frame updates the prior inline entry in place (the protocol
 * lets clients without in-place updates simply append).
 */
function ingestInlineUi(entries: LogEntry[], frame: UiFrame): LogEntry[] {
  if (frame.replace && frame.id) {
    const index = entries.findIndex((e) => e.kind === "ui" && e.frame.id === frame.id)
    if (index !== -1) {
      const next = [...entries]
      next[index] = { seq: next[index].seq, kind: "ui", frame }
      return next
    }
  }
  return pushEntry(entries, { kind: "ui", frame })
}

/** A later sidebar frame with the same id replaces that region; no id = one anonymous region. */
function upsertUiPanel(panels: UiPanelRegion[], frame: UiFrame): UiPanelRegion[] {
  const key = frame.id ?? ""
  const index = panels.findIndex((p) => p.key === key)
  if (index === -1) return [...panels, { key, frame }]
  const next = [...panels]
  next[index] = { key, frame }
  return next
}

export const useSessionStore = create<SessionState>((set) => ({
  entries: [],
  game: null,
  presence: null,
  turn: IDLE_TURN,
  uiPanels: [],

  ingest: (frame, now = Date.now()) => {
    switch (frame.type) {
      case "ui":
        if (frame.panel === "sidebar") {
          set((s) => ({ uiPanels: upsertUiPanel(s.uiPanels, frame) }))
        } else {
          set((s) => ({ entries: ingestInlineUi(s.entries, frame) }))
        }
        return
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
      // v1.8 module panels live in their own store; the session store stays
      // the single ingest chokepoint.
      case "ui_manifest":
        usePanelsStore.getState().applyManifest(frame.panels)
        return
      case "panel_event":
        usePanelsStore.getState().deliverEvent(frame.panel, frame.payload)
        return
      case "turn_status":
        set(
          frame.status === "busy"
            ? { turn: { busy: true, actor: frame.actor, since: now } }
            : { turn: IDLE_TURN },
        )
        return
      default:
        // Media, audio, admin, pong… are no-ops here; unknown frame types
        // are ignored by design (additive protocol).
        return
    }
  },

  expireTurnSafety: (now) => {
    set((s) => (s.turn.busy && now - s.turn.since >= TURN_BUSY_TIMEOUT_MS ? { turn: IDLE_TURN } : s))
  },

  clear: () => {
    usePanelsStore.getState().resetSession()
    set({ entries: [], game: null, presence: null, turn: IDLE_TURN, uiPanels: [] })
  },
}))
