import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NarrativeFrame, ServerFrame } from "@loreweaver/protocol"
import { dataUrlCacheHas, loadDataUrl } from "../lib/dataUrlCache"

const sent: unknown[] = []
vi.mock("../lib/transport", () => ({
  transportSend: async (frame: unknown) => {
    sent.push(frame)
  },
}))

import { useAdminStore } from "./admin"
import { usePanelsStore } from "./panels"
import {
  MAX_LOG_ENTRIES,
  MAX_STREAM_TEXT,
  PENDING_ECHO_TIMEOUT_MS,
  TURN_BUSY_TIMEOUT_MS,
  useSessionStore,
} from "./session"

function narrative(id: string, text: string, extra: Partial<NarrativeFrame> = {}): ServerFrame {
  return { type: "narrative", id, speaker: "kp", text, format: "markdown", ...extra }
}

function delta(id: string, text: string): ServerFrame {
  return { type: "narrative_delta", id, speaker: "kp", text }
}

const ingest = (frame: ServerFrame, now?: number) => useSessionStore.getState().ingest(frame, now)

describe("session store", () => {
  beforeEach(() => useSessionStore.getState().clear())

  it("appends narrative lines and dedups history replays by id", () => {
    ingest(narrative("n1", "The pier creaks."))
    ingest(narrative("n2", "A lantern gutters."))
    // Reconnect: the server replays recent history with the same ids.
    ingest(narrative("n1", "The pier creaks."))
    const { entries } = useSessionStore.getState()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.kind)).toEqual(["narrative", "narrative"])
  })

  it("accumulates deltas into one draft and replaces it with the closing narrative", () => {
    ingest(delta("s1", "The fog "))
    ingest(delta("s1", "thickens"))
    ingest(delta("s1", "."))
    let entries = useSessionStore.getState().entries
    expect(entries).toHaveLength(1)
    let entry = entries[0]
    if (entry.kind !== "narrative") throw new Error("expected narrative")
    expect(entry.draft).toBe(true)
    expect(entry.frame.text).toBe("The fog thickens.")

    // The closing `narrative` (same id) carries the full final text — any
    // post-generation correction is already folded in — and closes the draft.
    ingest(narrative("s1", "The fog thickens over the pier."))
    entries = useSessionStore.getState().entries
    expect(entries).toHaveLength(1)
    entry = entries[0]
    if (entry.kind !== "narrative") throw new Error("expected narrative")
    expect(entry.draft).toBe(false)
    expect(entry.frame.text).toBe("The fog thickens over the pier.")
  })

  it("drops an abandoned draft when its closing narrative is empty", () => {
    ingest(delta("s1", "The fog thick"))
    ingest(narrative("s1", ""))
    expect(useSessionStore.getState().entries).toHaveLength(0)
  })

  it("ignores an empty narrative with no matching draft", () => {
    ingest(narrative("n1", "The pier creaks."))
    ingest(narrative("n2", ""))
    expect(useSessionStore.getState().entries).toHaveLength(1)
  })

  it("keeps drafts with different ids as separate bubbles", () => {
    ingest(delta("s1", "tool-round draft"))
    ingest(delta("s2", "The real reply"))
    expect(useSessionStore.getState().entries).toHaveLength(2)
    // Closing one stream leaves the other draft untouched.
    ingest(narrative("s2", "The real reply lands."))
    const { entries } = useSessionStore.getState()
    expect(entries).toHaveLength(2)
    const closed = entries[1]
    if (closed.kind !== "narrative") throw new Error("expected narrative")
    expect(closed.frame.id).toBe("s2")
    expect(closed.draft).toBe(false)
    expect(closed.frame.text).toBe("The real reply lands.")
    const open = entries[0]
    if (open.kind !== "narrative") throw new Error("expected narrative")
    expect(open.draft).toBe(true)
  })

  it("never evicts a draft on a player's plain line", () => {
    ingest(delta("s1", "draft one "))
    ingest(narrative("p1", "I wait.", { speaker: "player", name: "Ash" }))
    expect(useSessionStore.getState().entries).toHaveLength(2)
  })

  it("caps a runaway stream at MAX_STREAM_TEXT", () => {
    ingest(delta("s1", "x".repeat(MAX_STREAM_TEXT - 10)))
    ingest(delta("s1", "y".repeat(100)))
    const entry = useSessionStore.getState().entries[0]
    if (entry.kind !== "narrative") throw new Error("expected narrative")
    expect(entry.frame.text).toHaveLength(MAX_STREAM_TEXT)
  })

  it("caps the scrollback at MAX_LOG_ENTRIES", () => {
    for (let i = 0; i < MAX_LOG_ENTRIES + 5; i += 1) {
      ingest({ type: "dice", actor: "Nyx", kind: "roll", expr: "1d6", rolls: [i], total: i })
    }
    expect(useSessionStore.getState().entries).toHaveLength(MAX_LOG_ENTRIES)
  })

  it("stores state snapshots and clears the scrollback on reset", () => {
    ingest(narrative("n1", "before the wipe"))
    ingest({ type: "state", party: [], initiative: [], online: 1 })
    expect(useSessionStore.getState().game?.online).toBe(1)
    expect(useSessionStore.getState().entries).toHaveLength(1)

    ingest({ type: "state", party: [], initiative: [], online: 1, reset: true })
    expect(useSessionStore.getState().entries).toHaveLength(0)
  })

  it("clears hook sidebar regions on a campaign wipe, not the module manifest or pack inventory", () => {
    // TUI GameView drops sidebarUi with the log; the module list and the
    // server's installed-pack card catalog are not campaign residue.
    usePanelsStore.getState().applyManifest([
      {
        id: "harbour/case-board",
        title: { en: "Case Board" },
        slot: "sidebar",
        tier: 1,
        blocks: [{ kind: "text", text: { en: "clues" } }],
      },
    ])
    ingest({
      type: "ui",
      panel: "sidebar",
      id: "hud",
      blocks: [{ kind: "badge", label: "omen" }],
    })
    ingest({
      type: "pack_cards",
      cards: [{ ref: "harbour/cards/pilot.png", pack: "harbour", name: "pilot" }],
    })
    expect(useSessionStore.getState().uiPanels).toHaveLength(1)

    ingest({ type: "state", party: [], initiative: [], online: 1, reset: true })

    expect(useSessionStore.getState().entries).toHaveLength(0)
    expect(useSessionStore.getState().uiPanels).toHaveLength(0)
    expect(usePanelsStore.getState().manifest.map((panel) => panel.id)).toEqual(["harbour/case-board"])
    expect(useSessionStore.getState().packCards).toEqual([
      { ref: "harbour/cards/pilot.png", pack: "harbour", name: "pilot" },
    ])
  })

  it("drops keeper-admin leftovers on session clear, not on a campaign wipe", () => {
    useAdminStore.setState({
      generated: {
        type: "admin_generated",
        kind: "module",
        ok: true,
        id: "old",
        name: "Old Room Module",
        error: "",
        detail: "installed",
      },
      roomOp: {
        type: "admin_room_op",
        action: "reset",
        room: "old-room",
        keys: 2,
        store_rows: 4,
        vector_points: 0,
      },
      serverUpdate: { type: "admin_update", status: "failed", output: "stale" },
      lastError: "stale forbidden",
    })

    ingest({ type: "state", party: [], initiative: [], online: 1, reset: true })
    expect(useAdminStore.getState().lastError).toBe("stale forbidden")
    expect(useAdminStore.getState().generated?.name).toBe("Old Room Module")
    expect(useAdminStore.getState().roomOp?.room).toBe("old-room")
    expect(useAdminStore.getState().serverUpdate?.status).toBe("failed")

    useSessionStore.getState().clear()
    const admin = useAdminStore.getState()
    expect(admin.generated).toBeNull()
    expect(admin.roomOp).toBeNull()
    expect(admin.serverUpdate).toBeNull()
    expect(admin.lastError).toBeNull()
  })

  it("recycles settled picture URLs when the play session is cleared", async () => {
    const hash = "a".repeat(64)
    await loadDataUrl(hash, () => Promise.resolve("data:image/png;base64,xx"))
    expect(dataUrlCacheHas(hash)).toBe(true)
    useSessionStore.getState().clear()
    expect(dataUrlCacheHas(hash)).toBe(false)
  })

  it("tracks presence and turn status with a safety timeout", () => {
    ingest({ type: "presence", players: [{ id: "u1", name: "Nyx", online: true }], online: 1 })
    expect(useSessionStore.getState().presence?.online).toBe(1)

    ingest({ type: "turn_status", status: "busy", actor: "Nyx" }, 1_000)
    expect(useSessionStore.getState().turn).toMatchObject({ busy: true, actor: "Nyx" })

    // Before the timeout nothing changes; after it the indicator clears.
    useSessionStore.getState().expireTurnSafety(1_000 + TURN_BUSY_TIMEOUT_MS - 1)
    expect(useSessionStore.getState().turn.busy).toBe(true)
    useSessionStore.getState().expireTurnSafety(1_000 + TURN_BUSY_TIMEOUT_MS)
    expect(useSessionStore.getState().turn.busy).toBe(false)

    ingest({ type: "turn_status", status: "busy", actor: "Nyx" }, 5_000)
    ingest({ type: "turn_status", status: "idle" })
    expect(useSessionStore.getState().turn.busy).toBe(false)
  })

  it("ignores frame types it does not render", () => {
    ingest({ type: "pong", t: 1 })
    ingest({
      type: "audio_control",
      id: "a1",
      action: "play",
      layer: "bgm",
    })
    expect(useSessionStore.getState().entries).toHaveLength(0)
  })
})

describe("session store — ui frames (v1.7)", () => {
  beforeEach(() => useSessionStore.getState().clear())

  const uiFrame = (extra: Record<string, unknown>): ServerFrame =>
    ({
      type: "ui",
      blocks: [{ kind: "badge", label: "omen" }],
      panel: "inline",
      ...extra,
    }) as ServerFrame

  it("appends inline ui frames to the chronicle", () => {
    ingest(uiFrame({}))
    ingest(uiFrame({}))
    expect(useSessionStore.getState().entries.map((e) => e.kind)).toEqual(["ui", "ui"])
  })

  it("updates an inline ui frame in place when replace + id match", () => {
    ingest(uiFrame({ id: "hud" }))
    ingest(uiFrame({ id: "hud", replace: true, blocks: [{ kind: "stat", label: "Doom", value: 2 }] }))
    const { entries } = useSessionStore.getState()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (entry.kind !== "ui") throw new Error("expected ui entry")
    expect(entry.frame.blocks[0]).toMatchObject({ kind: "stat", label: "Doom" })
  })

  it("appends when replace has no prior inline frame to update", () => {
    ingest(uiFrame({ id: "hud", replace: true }))
    expect(useSessionStore.getState().entries).toHaveLength(1)
  })

  it("keys sidebar regions by id and replaces them on re-emit", () => {
    ingest(uiFrame({ panel: "sidebar", id: "hud" }))
    ingest(uiFrame({ panel: "sidebar", id: "map" }))
    ingest(uiFrame({ panel: "sidebar", id: "hud", blocks: [{ kind: "stat", label: "Doom", value: 9 }] }))
    const { uiPanels, entries } = useSessionStore.getState()
    expect(entries).toHaveLength(0)
    expect(uiPanels.map((p) => p.key)).toEqual(["hud", "map"])
    expect(uiPanels[0].frame.blocks[0]).toMatchObject({ kind: "stat" })
  })

  it("treats id-less sidebar frames as one anonymous region", () => {
    ingest(uiFrame({ panel: "sidebar" }))
    ingest(uiFrame({ panel: "sidebar", blocks: [{ kind: "divider" }] }))
    const { uiPanels } = useSessionStore.getState()
    expect(uiPanels).toHaveLength(1)
    expect(uiPanels[0].frame.blocks[0]).toMatchObject({ kind: "divider" })
  })
})

describe("session store — installed-pack cards (v2.2)", () => {
  beforeEach(() => {
    sent.length = 0
    useSessionStore.getState().clear()
  })

  it("starts unknown and populates from a pack_cards frame", () => {
    expect(useSessionStore.getState().packCards).toBeNull()
    useSessionStore.getState().ingest({
      type: "pack_cards",
      cards: [
        { ref: "midnight-pier/cards/lin_wan.png", pack: "midnight-pier", name: "lin_wan" },
        { ref: "midnight-pier/cards/chen_jiuli.png", pack: "midnight-pier", name: "chen_jiuli" },
      ],
    })
    expect(useSessionStore.getState().packCards).toEqual([
      { ref: "midnight-pier/cards/lin_wan.png", pack: "midnight-pier", name: "lin_wan" },
      { ref: "midnight-pier/cards/chen_jiuli.png", pack: "midnight-pier", name: "chen_jiuli" },
    ])
  })

  it("keeps an empty reply (nothing installed) distinct from no reply yet", () => {
    useSessionStore.getState().ingest({ type: "pack_cards", cards: [] })
    expect(useSessionStore.getState().packCards).toEqual([])
    useSessionStore.getState().clear()
    expect(useSessionStore.getState().packCards).toBeNull()
  })

  it("requestPackCards sends the list_pack_cards request through the transport", () => {
    useSessionStore.getState().requestPackCards()
    expect(sent).toEqual([{ type: "list_pack_cards" }])
  })
})

describe("pending echoes", () => {
  beforeEach(() => useSessionStore.getState().clear())

  const echo = (text: string, seat = "Nyx", now = 1_000) =>
    useSessionStore.getState().echoLocalInput(text, seat, now)
  const pendings = () => useSessionStore.getState().entries.filter((e) => e.kind === "pending")

  it("shows a sent line immediately, and retires it when the broadcast arrives", () => {
    echo("I check the ledger.")
    expect(pendings()).toHaveLength(1)

    ingest(narrative("p1", "I check the ledger.", { speaker: "player", name: "Nyx" }))
    const { entries } = useSessionStore.getState()
    // Exactly once: the real line, and no echo beside it.
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("narrative")
  })

  it("retires the echo even when the server labels the seat differently", () => {
    echo("I check the ledger.")
    ingest(narrative("p1", "I check the ledger.", { speaker: "player", name: "林晚" }))
    expect(pendings()).toHaveLength(0)
  })

  it("keeps the echo when a different line comes back", () => {
    echo("I check the ledger.")
    ingest(narrative("p1", "I light the lantern.", { speaker: "player", name: "Nyx" }))
    ingest(narrative("k1", "I check the ledger."))
    expect(pendings()).toHaveLength(1)
  })

  // The server DOES echo a matched command back — to the sender alone, as a
  // `narrative{speaker:"player"}` carrying the command line (`gateway/turn.py`:
  // `origin.deliver(action_event)`). Its REPLY is a system-speaker narrative,
  // and a command turn never publishes `turn_status idle`, so the echo is the
  // only thing that can retire the held line.
  it("retires a command echo on the server's own echo of the command line", () => {
    echo(".pack install gh:1A7432/antu@v1.0.0")
    ingest(
      narrative("e1", ".pack install gh:1A7432/antu@v1.0.0", {
        speaker: "player",
        name: "Nyx",
        format: "plain",
      }),
    )
    expect(pendings()).toHaveLength(0)

    // The reply lands after it, and is the only other line in the log.
    ingest(narrative("r1", "Installed 安土 — 5 skills enabled.", { speaker: "system" }))
    const kinds = useSessionStore.getState().entries.map((e) => e.kind)
    expect(kinds).toEqual(["narrative", "narrative"])
  })

  it("retires two identical commands one echo at a time", () => {
    echo(".undo")
    echo(".undo")
    expect(pendings()).toHaveLength(2)

    ingest(narrative("e1", ".undo", { speaker: "player", name: "Nyx", format: "plain" }))
    expect(pendings()).toHaveLength(1)
    ingest(narrative("e2", ".undo", { speaker: "player", name: "Nyx", format: "plain" }))
    expect(pendings()).toHaveLength(0)
  })

  it("keeps a queued command waiting: the queue receipt is a system frame, not an echo", () => {
    echo(".pack install gh:1A7432/antu@v1.0.0")
    // `net/session.py: notify_turn_queued` — sent while someone else's turn holds
    // the room lock, long before this command runs.
    ingest({ type: "system", level: "info", text: "Your input is queued behind the running turn." })
    expect(pendings()).toHaveLength(1)
    // The notice itself is not just swallowed on the way past the pending echo —
    // it lands in the chronicle as its own visible line, beside the still-held one.
    const { entries } = useSessionStore.getState()
    const system = entries.find((e) => e.kind === "system")
    expect(system?.kind === "system" && system.frame.text).toBe(
      "Your input is queued behind the running turn.",
    )
    expect(entries.map((e) => e.kind)).toEqual(["pending", "system"])
  })

  it("keeps a waiting line through another member's dice, system and idle frames", () => {
    echo(".st STR=50")
    echo("I check the ledger.")
    ingest({
      type: "dice",
      actor: "Ash",
      kind: "check",
      expr: "1d100",
      rolls: [12],
      total: 12,
    } as ServerFrame)
    ingest({ type: "system", level: "info", text: "Ash spends a luck point." })
    ingest({ type: "turn_status", status: "idle" })
    ingest({ type: "ui", panel: "inline", blocks: [{ kind: "badge", label: "omen" }] } as ServerFrame)
    expect(pendings().map((e) => e.kind === "pending" && e.pending.text)).toEqual([
      ".st STR=50",
      "I check the ledger.",
    ])
  })

  it("marks an echo undelivered after the timeout, and on an outright send failure", () => {
    const seq = echo("I check the ledger.", "Nyx", 1_000)
    useSessionStore.getState().expirePendingEchoes(1_000 + PENDING_ECHO_TIMEOUT_MS - 1)
    const first = pendings()[0]
    expect(first.kind === "pending" && first.pending.failed).toBeFalsy()

    useSessionStore.getState().expirePendingEchoes(1_000 + PENDING_ECHO_TIMEOUT_MS)
    expect(pendings()[0]).toMatchObject({ pending: { failed: true } })

    const other = echo("I run.", "Nyx", 9_000)
    useSessionStore.getState().failEcho(other)
    expect(pendings().map((e) => e.kind === "pending" && e.pending.failed)).toEqual([true, true])
    expect(seq).not.toBe(other)
  })

  // Every path that accepts a line echoes it, and every path that refuses one
  // sends an `error` frame — so the timeout is the last resort it was meant to
  // be (a dropped connection, a server that answers neither way).
  it("falls back to the timeout for a command nothing ever came back for", () => {
    echo(".skill enable keeper-only", "Nyx", 1_000)
    ingest(narrative("r1", "Only the keeper can do that.", { speaker: "system" }))
    expect(pendings()[0]).not.toMatchObject({ pending: { failed: true } })

    useSessionStore.getState().expirePendingEchoes(1_000 + PENDING_ECHO_TIMEOUT_MS)
    expect(pendings()[0]).toMatchObject({ pending: { failed: true } })
  })

  it("fails the oldest waiting line the moment the server refuses one", () => {
    echo("I check the ledger.", "Nyx", 1_000)
    echo("I run.", "Nyx", 2_000)
    ingest({ type: "error", code: "rate_limited", message: "Slow down." })

    expect(pendings().map((e) => e.kind === "pending" && Boolean(e.pending.failed))).toEqual([true, false])
    // …and the refusal is shown, where the player is already looking.
    const last = useSessionStore.getState().entries.at(-1)
    expect(last).toMatchObject({ kind: "error", frame: { code: "rate_limited" } })
  })

  // Nothing survives a wipe or a redial: `.reset` publishes `state{reset:true}`
  // and a fresh dial calls `clear()` (`store/connection.ts`), so a line held
  // from before cannot outlive the log it belonged to.
  it("drops held lines with the scrollback on a campaign wipe", () => {
    echo(".pack install gh:1A7432/antu@v1.0.0")
    echo("I check the ledger.")
    ingest({ type: "state", party: [], initiative: [], online: 1, reset: true })
    expect(useSessionStore.getState().entries).toHaveLength(0)
  })

  it("leaves waiting lines alone for a media refusal — the upload deck owns those", () => {
    echo("I check the ledger.", "Nyx", 1_000)
    ingest({ type: "error", code: "media_disabled", message: "Uploads are off here." })
    expect(pendings().map((e) => e.kind === "pending" && Boolean(e.pending.failed))).toEqual([false])
    expect(useSessionStore.getState().entries.at(-1)).toMatchObject({ kind: "error" })
  })
})
