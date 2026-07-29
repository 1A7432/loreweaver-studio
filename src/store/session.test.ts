import { beforeEach, describe, expect, it } from "vitest"
import type { NarrativeFrame, ServerFrame } from "@loreweaver/protocol"
import { MAX_LOG_ENTRIES, MAX_STREAM_TEXT, TURN_BUSY_TIMEOUT_MS, useSessionStore } from "./session"

function narrative(id: string, text: string, extra: Partial<NarrativeFrame> = {}): ServerFrame {
  return { type: "narrative", id, speaker: "kp", text, format: "markdown", ...extra }
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

  it("merges streaming chunks by id and finalizes on done", () => {
    ingest(narrative("s1", "The fog ", { stream: true }))
    ingest(narrative("s1", "thickens", { stream: true }))
    ingest(narrative("s1", ".", { stream: true, done: true }))
    const { entries } = useSessionStore.getState()
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    if (entry.kind !== "narrative") throw new Error("expected narrative")
    expect(entry.frame.text).toBe("The fog thickens.")
    expect(entry.frame.done).toBe(true)
  })

  it("caps a runaway stream at MAX_STREAM_TEXT", () => {
    ingest(narrative("s1", "x".repeat(MAX_STREAM_TEXT - 10), { stream: true }))
    ingest(narrative("s1", "y".repeat(100), { stream: true }))
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
