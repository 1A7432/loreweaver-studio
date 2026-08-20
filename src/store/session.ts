import { create } from "zustand"
import { FrameType } from "@loreweaver/protocol"
import type {
  DiceFrame,
  ErrorFrame,
  NarrativeDeltaFrame,
  NarrativeFrame,
  PackCardEntry,
  PresenceFrame,
  ServerFrame,
  StateFrame,
  SystemFrame,
  TurnActivity,
  UiFrame,
} from "@loreweaver/protocol"
import { transportSend } from "../lib/transport"
import { usePanelsStore } from "./panels"

/** Scrollback cap, mirroring the reference TUI client. */
export const MAX_LOG_ENTRIES = 200
/** Cap one streaming message so a runaway stream cannot grow without bound. */
export const MAX_STREAM_TEXT = 20_000
/** Safety timeout for a lost `turn_status idle` frame (the protocol asks clients to apply one). */
export const TURN_BUSY_TIMEOUT_MS = 120_000
/** How long an un-echoed local line waits before it is shown as undelivered. */
export const PENDING_ECHO_TIMEOUT_MS = 120_000

/**
 * A line this client sent and has not seen come back yet.
 *
 * A whole player turn occupies its room (the server takes a per-room turn lock
 * at the transport chokepoint), so input typed while someone else's turn runs
 * queues silently — with no local echo the app simply looks dead. The echo is
 * strictly a VIEW of what we sent: it never enters the chronicle the server
 * owns, and it is removed the moment the real line arrives, so the player is
 * never shown the same words twice.
 *
 * A dot/slash command is no different. The server echoes one back too — for a
 * matched command to the sender alone (`gateway/turn.py`: `origin.deliver` of
 * the same `player_action`), for anything else to the whole room — so ONE rule
 * retires every held line: the server's own `narrative{speaker:"player"}`.
 */
export interface PendingEcho {
  /** The seat that typed it, for the speaker header. */
  speaker: string
  /** Exactly the text that went on the wire — the key the broadcast matches. */
  text: string
  /** Epoch ms, for the delivery timeout. */
  at: number
  /** The send itself failed, or nothing came back in time. */
  failed?: boolean
}

export type LogEntry =
  | { seq: number; kind: "narrative"; frame: NarrativeFrame; draft?: boolean }
  | { seq: number; kind: "dice"; frame: DiceFrame }
  | { seq: number; kind: "system"; frame: SystemFrame }
  | { seq: number; kind: "ui"; frame: UiFrame }
  | { seq: number; kind: "error"; frame: ErrorFrame }
  | { seq: number; kind: "pending"; pending: PendingEcho }

/** One named sidebar region fed by `ui` frames (later same-key frames replace it). */
export interface UiPanelRegion {
  key: string
  frame: UiFrame
}

/**
 * The activity words this client has a label for — the protocol's own closed
 * set, typed against it, so a word a later protocol adds fails the BUILD here
 * rather than showing a raw translation key at the table. The set stays a
 * runtime check as well: the frame validator does not police these two hints,
 * and a newer server is exactly who would send an unfamiliar one.
 */
const TURN_ACTIVITIES: readonly TurnActivity[] = ["reading", "dice", "cast", "bookkeeping"]

export interface TurnState {
  busy: boolean
  actor: string | null
  /** Epoch ms of the busy frame, for the safety timeout. */
  since: number
  /** The 2.3.1 activity hint, or null when the server did not send one. */
  activity: TurnActivity | null
  /** The 2.3.1 tool round (1-based), or null when the server did not send one. */
  round: number | null
}

/** The 2.3.1 activity hint, ignoring anything outside the set we can label. */
function readActivity(activity: TurnActivity | undefined): TurnActivity | null {
  return activity !== undefined && TURN_ACTIVITIES.includes(activity) ? activity : null
}

/** The 2.3.1 round hint; a non-integer or sub-1 value is no hint at all. */
function readRound(round: number | undefined): number | null {
  return round !== undefined && Number.isInteger(round) && round >= 1 ? round : null
}

interface SessionState {
  entries: LogEntry[]
  game: StateFrame | null
  presence: PresenceFrame | null
  turn: TurnState
  uiPanels: UiPanelRegion[]
  /** v2.2 installed-pack card list; `null` until the first `pack_cards` reply,
   * then the (possibly empty) card list. */
  packCards: PackCardEntry[] | null
  /** Feed one validated server frame into the session. */
  ingest: (frame: ServerFrame, now?: number) => void
  /** Show a line this client just sent, until the table reflects it back.
   * Returns the entry's seq, so the caller can fail it if the send throws. */
  echoLocalInput: (text: string, speaker: string, now?: number) => number
  /** Mark one pending echo undelivered (the send itself failed). */
  failEcho: (seq: number) => void
  /** Mark every echo older than the delivery timeout undelivered. */
  expirePendingEchoes: (now: number) => void
  /** Ask the server for the card files installed packs ship (v2.2). */
  requestPackCards: () => void
  /** Clear a stale busy indicator once the safety timeout has elapsed. */
  expireTurnSafety: (now: number) => void
  clear: () => void
}

let nextSeq = 1

const IDLE_TURN: TurnState = { busy: false, actor: null, since: 0, activity: null, round: null }

/** `Omit` that distributes over a union, so variant-only keys (like `draft`) survive. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

function pushEntry(entries: LogEntry[], entry: DistributiveOmit<LogEntry, "seq">): LogEntry[] {
  return [...entries, { ...entry, seq: nextSeq++ } as LogEntry].slice(-MAX_LOG_ENTRIES)
}

/**
 * Narrative merge rules (protocol 2.0, matching the reference TUI):
 * - `narrative_delta` chunks concatenate into one draft bubble keyed by `id`
 *   (created on the first delta, rendered as markdown while open);
 * - the closing `narrative` with the SAME `id` carries the full final text
 *   and REPLACES the draft (post-generation corrections are already folded
 *   in); an empty final text drops an abandoned draft outright;
 * - a `narrative` whose id matches a completed line is a history replay
 *   (the server replays recent narrative on every join) and replaces it
 *   in place — same id, same text, same slot;
 * - anything else is a fresh line.
 */
function ingestNarrative(entries: LogEntry[], frame: NarrativeFrame): LogEntry[] {
  const index = entries.findIndex((e) => e.kind === "narrative" && e.frame.id === frame.id)
  if (index !== -1) {
    if (!frame.text) return entries.filter((_, i) => i !== index)
    const next = [...entries]
    next[index] = { seq: entries[index].seq, kind: "narrative", frame, draft: false }
    return next
  }
  if (!frame.text) return entries
  return pushEntry(entries, { kind: "narrative", frame, draft: false })
}

/** One streaming text delta, accumulated into the draft bubble for its id. */
function ingestDelta(entries: LogEntry[], frame: NarrativeDeltaFrame): LogEntry[] {
  const index = entries.findIndex((e) => e.kind === "narrative" && e.frame.id === frame.id)
  if (index === -1) {
    const draft: NarrativeFrame = {
      type: "narrative",
      id: frame.id,
      speaker: frame.speaker,
      ...(frame.name ? { name: frame.name } : {}),
      text: frame.text.slice(0, MAX_STREAM_TEXT),
      format: "markdown",
    }
    return pushEntry(entries, { kind: "narrative", frame: draft, draft: true })
  }
  const existing = entries[index] as Extract<LogEntry, { kind: "narrative" }>
  const merged: NarrativeFrame = {
    ...existing.frame,
    text: (existing.frame.text + frame.text).slice(0, MAX_STREAM_TEXT),
  }
  const next = [...entries]
  next[index] = { ...existing, frame: merged, draft: true }
  return next
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

/**
 * The server's echo of a player line retires the local one — commands too.
 *
 * Every line the server accepts comes back as a `narrative{speaker:"player"}`
 * carrying the exact text that went out: broadcast for ordinary talk, unicast
 * to the sender for a matched dot/slash command (the arguments of a command
 * are never shown to the rest of the room). Nothing else retires a held line.
 * A dice roll, a system line or a `ui` block is NOT a receipt for it: those
 * arrive from other members' turns and from the server's own notices — the
 * mid-turn "your input is queued" line is a `system` frame — and each of them
 * used to cut a still-waiting line loose.
 *
 * Matching is on the WORDS, preferring this seat's own pending line and
 * falling back to any pending line with the same text. A server that labels
 * the seat differently than `welcome.you.name` would otherwise strand an echo
 * next to the very line it duplicates — and showing the player their sentence
 * twice is the failure this whole lane exists to avoid. The cost of the loose
 * match is that two players typing the identical sentence retire each other's
 * echo a beat early, which costs nobody anything: the real lines still arrive.
 */
function retireEcho(entries: LogEntry[], frame: NarrativeFrame): LogEntry[] {
  if (frame.speaker !== "player") return entries
  const text = frame.text.trim()
  const name = frame.name ?? ""
  const matches = (entry: LogEntry, seat: boolean): boolean =>
    entry.kind === "pending" && entry.pending.text === text && (!seat || entry.pending.speaker === name)
  let index = entries.findIndex((entry) => matches(entry, true))
  if (index === -1) index = entries.findIndex((entry) => matches(entry, false))
  return index === -1 ? entries : entries.filter((_, i) => i !== index)
}

/**
 * An `error` frame is the server refusing something. When that something is a
 * line this client typed — a rate limit, a lost privilege, a turn that threw —
 * no echo is ever coming, so the oldest line still waiting is failed NOW
 * instead of sitting there looking sent for the full two minutes.
 *
 * The media/avatar codes are the exception: they answer an upload exchange,
 * which the media deck tracks on its own and which no chronicle line is
 * waiting on.
 */
function answersTypedInput(code: string): boolean {
  return !code.startsWith("media_") && code !== "avatar_no_character"
}

function failOldestPending(entries: LogEntry[]): LogEntry[] {
  const index = entries.findIndex((entry) => entry.kind === "pending" && !entry.pending.failed)
  if (index === -1) return entries
  const entry = entries[index]
  if (entry.kind !== "pending") return entries
  const next = [...entries]
  next[index] = { ...entry, pending: { ...entry.pending, failed: true } }
  return next
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
  packCards: null,

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
        set((s) => ({ entries: ingestNarrative(retireEcho(s.entries, frame), frame) }))
        return
      case "narrative_delta":
        set((s) => ({ entries: ingestDelta(s.entries, frame) }))
        return
      case "dice":
        set((s) => ({ entries: pushEntry(s.entries, { kind: "dice", frame }) }))
        return
      case "system":
        set((s) => ({ entries: pushEntry(s.entries, { kind: "system", frame }) }))
        return
      case "error":
        // The refusal belongs in the chronicle beside every other thing the
        // player is told, and it settles the line it refused straight away.
        set((s) => ({
          entries: pushEntry(answersTypedInput(frame.code) ? failOldestPending(s.entries) : s.entries, {
            kind: "error",
            frame,
          }),
        }))
        return
      case "state":
        // `reset:true` marks the snapshot right after a campaign wipe: the
        // panel data is already fresh and the scrollback must go too.
        set((s) => ({ game: frame, entries: frame.reset ? [] : s.entries }))
        return
      case "presence":
        set({ presence: frame })
        return
      case "pack_cards":
        set({ packCards: frame.cards })
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
            ? {
                turn: {
                  busy: true,
                  actor: frame.actor,
                  since: now,
                  activity: readActivity(frame.activity),
                  round: readRound(frame.round),
                },
              }
            : { turn: IDLE_TURN },
        )
        return
      default:
        // Media, audio, admin, pong… are no-ops here; unknown frame types
        // are ignored by design (additive protocol).
        return
    }
  },

  echoLocalInput: (text, speaker, now = Date.now()) => {
    const seq = nextSeq
    set((s) => ({
      entries: pushEntry(s.entries, {
        kind: "pending",
        pending: { speaker, text, at: now },
      }),
    }))
    return seq
  },

  failEcho: (seq) => {
    set((s) => ({
      entries: s.entries.map((entry) =>
        entry.kind === "pending" && entry.seq === seq
          ? { ...entry, pending: { ...entry.pending, failed: true } }
          : entry,
      ),
    }))
  },

  expirePendingEchoes: (now) => {
    set((s) => {
      const stale = (entry: LogEntry): boolean =>
        entry.kind === "pending" && !entry.pending.failed && now - entry.pending.at >= PENDING_ECHO_TIMEOUT_MS
      if (!s.entries.some(stale)) return s
      return {
        entries: s.entries.map((entry) =>
          stale(entry) && entry.kind === "pending"
            ? { ...entry, pending: { ...entry.pending, failed: true } }
            : entry,
        ),
      }
    })
  },

  requestPackCards: () => {
    void transportSend({ type: FrameType.ListPackCards }).catch(() => {
      // The transport surfaces failures through status events.
    })
  },

  expireTurnSafety: (now) => {
    set((s) => (s.turn.busy && now - s.turn.since >= TURN_BUSY_TIMEOUT_MS ? { turn: IDLE_TURN } : s))
  },

  clear: () => {
    usePanelsStore.getState().resetSession()
    set({ entries: [], game: null, presence: null, turn: IDLE_TURN, uiPanels: [], packCards: null })
  },
}))
