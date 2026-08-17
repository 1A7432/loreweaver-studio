import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NarrativeFrame, ServerFrame } from "@loreweaver/protocol"

const sent: unknown[] = []
vi.mock("../lib/transport", () => ({
  transportSend: async (frame: unknown) => {
    sent.push(frame)
  },
}))

import { MAX_LOG_ENTRIES, MAX_STREAM_TEXT, TURN_BUSY_TIMEOUT_MS, useSessionStore } from "./session"

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
