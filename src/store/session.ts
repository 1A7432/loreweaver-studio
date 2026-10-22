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
import { clearDataUrlCache } from "../lib/dataUrlCache"
import { transportSend } from "../lib/transport"
import { useAdminStore } from "./admin"
import { usePanelsStore } from "./panels"

/** Scrollback cap, mirroring the reference TUI client. */
export const MAX_LOG_ENTRIES = 200
/** Cap one streaming message so a runaway stream cannot grow without bound. */
export const MAX_STREAM_TEXT = 20_000
/** Safety timeout for a lost `turn_status idle` frame (the protocol asks clients to apply one). */
export const TURN_BUSY_TIMEOUT_MS = 120_000
/** How long an un-echoed local line waits before it is shown as undelivered. */
export const PENDING_ECHO_TIMEOUT_MS = 120_000
/** How long a join replay may hold the input box before the client stops waiting
 * for the `state` frame that should have ended it (see `expireReplay`). */
export const JOIN_REPLAY_TIMEOUT_MS = 10_000

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

/**
 * What a join is waiting on while the server's join replay runs.
 *
 * Every successful join — the first dial and every automatic redial after a
 * restart or a dropped link — is answered with a `welcome` and then a replay of
 * the room's recent history, in fresh frames whose ids match nothing the client
 * already holds. So on a reconnect the scrollback is REBUILT from the replay,
 * not appended to. The one thing the replay cannot contain is a line this
 * client typed on the connection that has just died: those are set aside here,
 * out of the log the replay is rebuilding, and put back once it has ended.
 *
 * The window is open for EVERY join, carried lines or not, because it is also
 * what holds the input box: a line typed while the history is still arriving
 * would land in the middle of it (see `InputBox`).
 */
interface ReplayWindow {
  /** Pending lines from the dead connection, oldest first, all marked undelivered. */
  carried: Extract<LogEntry, { kind: "pending" }>[]
  /** The transcript the client had already seen, newest first. */
  seen: ReplayedLine[]
  /** The narrative the replay (and anything flushed behind it) has delivered so far. */
  lines: ReplayedLine[]
  /** Epoch ms of the welcome that opened the window, for the fallback. */
  since: number
}

interface ReplayedLine {
  speaker: string
  text: string
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
  /** Open from every `welcome` until the `state` frame that closes the server's
   * join replay (or until `expireReplay` gives up on it); `null` the rest of the
   * time. While it is open the input box holds the player's draft. */
  replay: ReplayWindow | null
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
   * Returns the entry's seq, so the caller can fail it if the send throws.
   * Callers hold input while `replay` is open — see `InputBox`. */
  echoLocalInput: (text: string, speaker: string, now?: number) => number
  /** Mark one pending echo undelivered (the send itself failed). */
  failEcho: (seq: number) => void
  /** Send an undelivered line again. The same entry goes back to waiting (it
   * keeps its place), and only an undelivered one can be resent — so a second
   * call before the first settles does nothing. Whether a connection is up is
   * the caller's to check; a send that fails simply fails the line again. */
  resendEcho: (seq: number, now?: number) => void
  /** Mark every echo older than the delivery timeout undelivered. */
  expirePendingEchoes: (now: number) => void
  /** Ask the server for the card files installed packs ship (v2.2). */
  requestPackCards: () => void
  /** Clear a stale busy indicator once the safety timeout has elapsed. */
  expireTurnSafety: (now: number) => void
  /** End a join replay whose closing `state` frame has not come within
   * `JOIN_REPLAY_TIMEOUT_MS`, so the input box can never stay held. */
  expireReplay: (now: number) => void
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
 * - a `narrative` whose id matches a completed line replaces it in place —
 *   same id, same text, same slot. (A join replay does NOT arrive this way: the
 *   engine gives every replayed line a fresh id, which is why a `welcome`
 *   rebuilds the log — see `beginReplay`.)
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

/**
 * The transcript lines a reader has definitely been shown, newest first.
 *
 * Only what the server owns and will replay counts: no drafts (their text is
 * still partial), no `system` narrative (command replies are backstage and are
 * never replayed), and no local echoes.
 */
function seenLines(entries: LogEntry[]): ReplayedLine[] {
  const lines: ReplayedLine[] = []
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry.kind !== "narrative" || entry.draft || entry.frame.speaker === "system") continue
    const text = entry.frame.text.trim()
    if (text) lines.push({ speaker: entry.frame.speaker, text })
  }
  return lines
}

/**
 * Every `welcome` opens a join replay. On a session that already has a log it
 * is a reconnect: the server is about to replay its recent history from
 * scratch, so everything the replay will say again goes now (narrative, the
 * dice and NPC lines, an open stream draft) and the replay rebuilds it, exactly
 * as a first join would. Whatever it does NOT replay — the backstage lines,
 * command replies, `ui` blocks, errors — belongs to a transcript that no longer
 * exists; kept, it would sit above the replay out of order.
 *
 * What survives is the player's own un-echoed lines. They rode the connection
 * that died, so nothing here can say they arrived: they are marked undelivered
 * and set aside until the replay has finished (see `settleReplay`).
 */
function beginReplay(state: SessionState, now: number): Partial<SessionState> {
  const carried = [
    // What a partial replay already proved delivered stays retired: the next
    // replay anchors on the newer lines it showed, so the proof would be lost.
    ...(state.replay ? unproven(state.replay) : []),
    ...state.entries.flatMap((entry) =>
      entry.kind === "pending" ? [{ ...entry, pending: { ...entry.pending, failed: true } }] : [],
    ),
  ]
  // A second welcome inside an open window means the link died mid-replay: what
  // the first replay managed to deliver was seen too, and sits in `entries`.
  const seen = [...seenLines(state.entries), ...(state.replay?.seen ?? [])]
  return { entries: [], replay: { carried, seen, lines: [], since: now } }
}

/**
 * The replay has ended: put the carried lines back at the bottom, except those
 * the replay proves the table did receive.
 *
 * "Proves" is deliberately narrow, because the cost of the two mistakes is not
 * the same. Showing a delivered line once more as undelivered costs a glance;
 * retiring an undelivered one silently costs the player their words. The replay
 * holds the last stretch of history, so an OLD line with identical words ("I
 * continue.") is common and proves nothing. Only a line AFTER the newest
 * transcript line this client had already seen is new to it — that is where a
 * line delivered just before the link died would sit. With no such anchor in
 * the replay nothing is proved and every carried line stays. A command (`.st …`,
 * `/roll …`) is never replayed, so it always stays: its fate is unknowable.
 */
function settleReplay(entries: LogEntry[], window: ReplayWindow): LogEntry[] {
  return [...entries, ...unproven(window)].slice(-MAX_LOG_ENTRIES)
}

/** The carried lines this window's replay has NOT proved delivered (see `settleReplay`). */
function unproven(window: ReplayWindow): ReplayWindow["carried"] {
  const key = (line: ReplayedLine): string => JSON.stringify([line.speaker, line.text])
  const replayed = window.lines.map(key)
  const anchor = window.seen.map(key).find((candidate) => replayed.includes(candidate))
  const unseen =
    anchor === undefined
      ? []
      : window.lines
          .slice(replayed.lastIndexOf(anchor) + 1)
          .filter((line) => line.speaker === "player")
          .map((line) => line.text)
  return window.carried.filter((entry) => {
    const index = unseen.indexOf(entry.pending.text)
    if (index === -1) return true
    unseen.splice(index, 1)
    return false
  })
}

/** While a replay window is open, remember what the replay says. */
function recordReplayed(window: ReplayWindow | null, frame: NarrativeFrame): ReplayWindow | null {
  const text = frame.text.trim()
  if (!window || !text) return window
  return { ...window, lines: [...window.lines, { speaker: frame.speaker, text }] }
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

export const useSessionStore = create<SessionState>((set, get) => ({
  entries: [],
  replay: null,
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
      case "welcome":
        // Lives here rather than in the connection store because the log is
        // this store's: `beginReplay` says what a reconnect does to it. A turn
        // that was running on the dead connection is no longer this table's to
        // wait for (the server restarted, or its idle edge went down with the
        // link), so the busy line goes too. The hub re-sends `busy` to a new
        // subscriber when a turn really is running, and that frame follows the
        // welcome — so nothing live is lost by clearing it here.
        set((s) => ({ ...beginReplay(s, now), turn: IDLE_TURN }))
        return
      case "narrative":
        set((s) => ({
          entries: ingestNarrative(retireEcho(s.entries, frame), frame),
          replay: recordReplayed(s.replay, frame),
        }))
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
        // panel data is already fresh and the scrollback must go too. The
        // sidebar `ui` regions STAY — owner's call: a region is a keeper's
        // standing readout, not campaign residue, and a wipe that emptied
        // the sidebar would look like the hooks had broken.
        // A `state` frame also ends a join replay: both carriers send the
        // snapshot right after it, behind the live frames the replay held.
        set((s) => {
          if (frame.reset) return { game: frame, entries: [], replay: null }
          return {
            game: frame,
            entries: s.replay ? settleReplay(s.entries, s.replay) : s.entries,
            replay: null,
          }
        })
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
      // The input box holds a draft while a replay runs, so this is only the
      // backstop for a caller that sends anyway: the carried lines go back
      // first, so at least the new line lands below them rather than above.
      entries: pushEntry(s.replay ? settleReplay(s.entries, s.replay) : s.entries, {
        kind: "pending",
        pending: { speaker, text, at: now },
      }),
      replay: null,
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

  resendEcho: (seq, now = Date.now()) => {
    const entry = get().entries.find((e) => e.kind === "pending" && e.seq === seq)
    // Checked and flipped in one synchronous step: the first call takes the
    // line out of the undelivered state, so a double click finds nothing to send.
    if (entry?.kind !== "pending" || !entry.pending.failed) return
    set((s) => ({
      entries: s.entries.map((e) =>
        e === entry ? { ...entry, pending: { ...entry.pending, failed: false, at: now } } : e,
      ),
    }))
    void transportSend({ type: "input", text: entry.pending.text }).catch(() => {
      // The transport surfaces failures through status events; the line says
      // so where the player is actually looking.
      get().failEcho(seq)
    })
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

  expireReplay: (now) => {
    // Every carrier sends the `state` snapshot right behind the replay, so this
    // only fires against a server that never does: the log is as rebuilt as it
    // will get, and the carried lines go back where the player can resend them.
    set((s) =>
      s.replay && now - s.replay.since >= JOIN_REPLAY_TIMEOUT_MS
        ? { entries: settleReplay(s.entries, s.replay), replay: null }
        : s,
    )
  },

  clear: () => {
    // Explicit new play session (connect calls this). Campaign wipe is
    // `state{reset:true}` and must not go through here — a keeper's last
    // room-op / generate / error still belongs to this table.
    usePanelsStore.getState().resetSession()
    useAdminStore.getState().reset()
    clearDataUrlCache()
    set({
      entries: [],
      replay: null,
      game: null,
      presence: null,
      turn: IDLE_TURN,
      uiPanels: [],
      packCards: null,
    })
  },
}))
