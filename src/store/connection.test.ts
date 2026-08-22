import { beforeEach, describe, expect, it, vi } from "vitest"
import { PROTOCOL_VERSION } from "@loreweaver/protocol"
import type { TransportEvent } from "../lib/transport"
import { sanitizeTicket, useConnectionStore } from "./connection"
import { useSessionStore } from "./session"

const bridge = vi.hoisted(() => ({
  tauri: false,
  nextIds: [] as string[],
  connect: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock("../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/transport")>()
  return {
    ...actual,
    isTauri: () => bridge.tauri,
    createConnectionId: () => {
      const id = bridge.nextIds.shift()
      return id === undefined ? actual.createConnectionId() : id
    },
    transportConnect: ((...args: unknown[]) => bridge.connect(...args)) as typeof actual.transportConnect,
    transportDisconnect: (() => bridge.disconnect()) as typeof actual.transportDisconnect,
  }
})

const WELCOME = {
  type: "welcome",
  protocol: PROTOCOL_VERSION,
  room: "r1",
  you: { id: "u1", name: "Nyx", role: "player" },
  locale: "en",
  server: "loreweaver/1",
}

const GEN = "gen-test"

function reset() {
  bridge.tauri = false
  bridge.nextIds = []
  bridge.connect.mockReset()
  bridge.connect.mockResolvedValue(undefined)
  bridge.disconnect.mockReset()
  bridge.disconnect.mockResolvedValue(undefined)
  useConnectionStore.setState({
    status: "offline",
    attempt: 0,
    lastError: null,
    welcome: null,
    connectionId: GEN,
    refused: false,
  })
  useSessionStore.getState().clear()
}

function handle(event: { kind: "status" | "frame"; connectionId?: string; [key: string]: unknown }): void {
  useConnectionStore.getState().handleEvent({
    ...event,
    connectionId: event.connectionId ?? GEN,
  } as TransportEvent)
}

describe("sanitizeTicket", () => {
  it("accepts every real-world paste shape the engine produces", () => {
    // Bare ticket: untouched.
    expect(sanitizeTicket("endpointac5qv3krex")).toBe("endpointac5qv3krex")
    // iroh-ticket.txt env-file line (this exact shape failed in live testing).
    expect(sanitizeTicket("ticket=endpointac5qv3krex\n")).toBe("endpointac5qv3krex")
    // Copied console announce line, CJK label included.
    expect(sanitizeTicket("  Ticket：endpointac5qv3krex")).toBe("endpointac5qv3krex")
    // Terminal-wrapped ticket with an embedded newline.
    expect(sanitizeTicket("endpointac5qv3\nkrex")).toBe("endpointac5qv3krex")
    // Garbage passes through for the transport's own error.
    expect(sanitizeTicket("not-a-ticket")).toBe("not-a-ticket")
  })
})

describe("connection store", () => {
  beforeEach(reset)

  it("follows the connect → welcome → online sequence", () => {
    handle({ kind: "status", status: "connecting", attempt: 0 })
    expect(useConnectionStore.getState().status).toBe("connecting")

    handle({ kind: "frame", frame: WELCOME })
    handle({ kind: "status", status: "online", attempt: 0 })

    const state = useConnectionStore.getState()
    expect(state.status).toBe("online")
    expect(state.welcome?.room).toBe("r1")
    expect(state.welcome?.you.role).toBe("player")
  })

  it("drops malformed frames via the shared validator", () => {
    handle({ kind: "frame", frame: { type: "welcome" } })
    handle({ kind: "frame", frame: "not even an object" })
    handle({ kind: "frame", frame: { type: "state" } })
    expect(useConnectionStore.getState().welcome).toBeNull()
  })

  it("keeps the fatal error and clears the welcome when going offline", () => {
    handle({ kind: "frame", frame: WELCOME })
    handle({ kind: "status", status: "online", attempt: 0 })
    handle({ kind: "status", status: "offline", attempt: 0, error: "bad_key: unknown key" })

    const state = useConnectionStore.getState()
    expect(state.status).toBe("offline")
    expect(state.lastError).toContain("bad_key")
    expect(state.welcome).toBeNull()
  })

  it("refuses a welcome announcing a different protocol MAJOR", () => {
    handle({ kind: "status", status: "connecting", attempt: 0 })
    handle({ kind: "frame", frame: { ...WELCOME, protocol: "4.0" } })
    // The REAL sequence, not a truncated one. `client.rs` emits the welcome
    // frame and `online` back-to-back, and the disconnect this store asks for
    // arrives later still as `offline`. A refusal that only survives until the
    // next event is not a refusal: the app would flash a room-less play screen
    // and then drop back to the form with nothing to explain it.
    handle({ kind: "status", status: "online", attempt: 0 })
    handle({ kind: "status", status: "offline", attempt: 0 })

    const state = useConnectionStore.getState()
    // Refused: never online, no welcome to render a room from, and the reason names
    // both versions so the operator knows which side to move.
    expect(state.status).toBe("offline")
    expect(state.welcome).toBeNull()
    expect(state.lastError).toContain("4.0")
    expect(state.lastError).toContain(PROTOCOL_VERSION)
  })

  it("refuses a welcome it cannot read at all", () => {
    // The bridge marks the session settled on ANY welcome-typed frame, which
    // disarms its join deadline and announces online. Dropping an unreadable
    // one silently would leave the app online, room-less and errorless forever.
    handle({ kind: "status", status: "connecting", attempt: 0 })
    handle({ kind: "frame", frame: { type: "welcome", protocol: PROTOCOL_VERSION } })
    handle({ kind: "status", status: "online", attempt: 0 })

    const state = useConnectionStore.getState()
    expect(state.status).toBe("offline")
    expect(state.welcome).toBeNull()
    expect(state.lastError).not.toBeNull()
  })

  it("lifts the refusal on the next explicit connect, not before", async () => {
    handle({ kind: "frame", frame: { ...WELCOME, protocol: "4.0" } })
    expect(useConnectionStore.getState().refused).toBe(true)

    // Outside the shell `connect` bails early — but it has already cleared the
    // latch, which is the half this asserts: a new dial gets a clean verdict.
    await useConnectionStore.getState().connect({ ticket: "endpoint-x", key: "k" })
    expect(useConnectionStore.getState().refused).toBe(false)
  })

  it("accepts the live engine's welcome verbatim", () => {
    // The exact shape `net/session.py::welcome_frame` puts on the wire at
    // engine HEAD — extra keys and all. The transport crate forwards it
    // unjudged (see `welcome_of_any_protocol_version_is_forwarded_verbatim`),
    // so this store is the only protocol gate; if it ever refused a real
    // engine, the app would be unable to connect to anything.
    handle({ kind: "status", status: "connecting", attempt: 0 })
    handle({
      kind: "frame",
      frame: {
        type: "welcome",
        protocol: "2.1",
        features: ["media", "audio"],
        room: "r1",
        you: { id: "u1", name: "Nyx", role: "keeper" },
        locale: "zh",
        server: "loreweaver/1",
        version: "0.9.3",
      },
    })
    handle({ kind: "status", status: "online", attempt: 0 })

    const state = useConnectionStore.getState()
    expect(state.status).toBe("online")
    expect(state.lastError).toBeNull()
    expect(state.welcome?.features).toEqual(["media", "audio"])
    expect(state.welcome?.version).toBe("0.9.3")
  })

  it("accepts a newer minor on the same major", () => {
    const major = PROTOCOL_VERSION.split(".")[0]
    handle({ kind: "frame", frame: { ...WELCOME, protocol: `${major}.999` } })

    const state = useConnectionStore.getState()
    expect(state.welcome?.room).toBe("r1")
    expect(state.lastError).toBeNull()
  })

  it("tracks redial attempts while reconnecting", () => {
    handle({ kind: "status", status: "reconnecting", attempt: 3 })
    expect(useConnectionStore.getState().attempt).toBe(3)
  })

  it("refuses to connect outside the tauri shell", async () => {
    await useConnectionStore.getState().connect({ ticket: "endpoint-x", key: "k" })
    const state = useConnectionStore.getState()
    expect(state.status).toBe("offline")
    expect(state.lastError).toContain("app shell")
  })
})

describe("connection generation", () => {
  beforeEach(reset)

  it("drops events stamped with a stale connection id and accepts the current one", () => {
    useConnectionStore.setState({ connectionId: "gen-new", status: "connecting" })

    handle({ kind: "status", status: "online", attempt: 0, connectionId: "gen-old" })
    handle({
      kind: "frame",
      connectionId: "gen-old",
      frame: { ...WELCOME, room: "old-room" },
    })
    handle({
      kind: "frame",
      connectionId: "gen-old",
      frame: {
        type: "narrative",
        id: "n-old",
        speaker: "kp",
        text: "from the previous table",
        format: "markdown",
      },
    })

    expect(useConnectionStore.getState().status).toBe("connecting")
    expect(useConnectionStore.getState().welcome).toBeNull()
    expect(useSessionStore.getState().entries).toHaveLength(0)

    handle({ kind: "frame", frame: { ...WELCOME, room: "new-room" }, connectionId: "gen-new" })
    handle({ kind: "status", status: "online", attempt: 0, connectionId: "gen-new" })
    handle({
      kind: "frame",
      connectionId: "gen-new",
      frame: {
        type: "narrative",
        id: "n-new",
        speaker: "kp",
        text: "from the new table",
        format: "markdown",
      },
    })

    expect(useConnectionStore.getState().status).toBe("online")
    expect(useConnectionStore.getState().welcome?.room).toBe("new-room")
    expect(useSessionStore.getState().entries).toHaveLength(1)
    expect(useSessionStore.getState().entries[0]).toMatchObject({
      kind: "narrative",
      frame: { text: "from the new table" },
    })
  })

  it("invalidates the generation on disconnect so a queued Offline/Frame cannot write back", async () => {
    handle({ kind: "frame", frame: WELCOME })
    handle({ kind: "status", status: "online", attempt: 0 })
    expect(useConnectionStore.getState().welcome?.room).toBe("r1")

    await useConnectionStore.getState().disconnect()

    expect(useConnectionStore.getState().connectionId).toBeNull()
    expect(useConnectionStore.getState().status).toBe("offline")
    expect(useConnectionStore.getState().welcome).toBeNull()

    // Already-emitted events from the dying actor, arriving after invalidate.
    handle({ kind: "status", status: "online", attempt: 0, connectionId: GEN })
    handle({ kind: "frame", frame: { ...WELCOME, room: "zombie" }, connectionId: GEN })
    handle({
      kind: "frame",
      connectionId: GEN,
      frame: {
        type: "narrative",
        id: "n-late",
        speaker: "kp",
        text: "late frame from the closed actor",
        format: "markdown",
      },
    })

    expect(useConnectionStore.getState().status).toBe("offline")
    expect(useConnectionStore.getState().welcome).toBeNull()
    expect(useSessionStore.getState().entries).toHaveLength(0)
  })

  it("keeps the same generation across automatic reconnect status", () => {
    handle({ kind: "frame", frame: WELCOME })
    handle({ kind: "status", status: "online", attempt: 0 })
    handle({ kind: "status", status: "reconnecting", attempt: 1 })
    handle({ kind: "frame", frame: { ...WELCOME, room: "r1" } })
    handle({ kind: "status", status: "online", attempt: 0 })

    const state = useConnectionStore.getState()
    expect(state.connectionId).toBe(GEN)
    expect(state.status).toBe("online")
    expect(state.welcome?.room).toBe("r1")
  })

  it("does not let a stale connect failure overwrite a newer generation", async () => {
    bridge.tauri = true
    bridge.nextIds = ["gen-A", "gen-B"]
    let rejectA: (err: Error) => void = () => {
      throw new Error("rejectA not armed")
    }
    let resolveB: (value?: unknown) => void = () => {
      throw new Error("resolveB not armed")
    }
    bridge.connect
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectA = reject
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = resolve
          }),
      )

    const pendingA = useConnectionStore.getState().connect({ ticket: "endpoint-a", key: "ka" })
    expect(useConnectionStore.getState().connectionId).toBe("gen-A")
    expect(useConnectionStore.getState().status).toBe("connecting")

    const pendingB = useConnectionStore.getState().connect({ ticket: "endpoint-b", key: "kb" })
    expect(useConnectionStore.getState().connectionId).toBe("gen-B")
    expect(useConnectionStore.getState().status).toBe("connecting")

    rejectA(new Error("old ticket refused"))
    await pendingA

    expect(useConnectionStore.getState().connectionId).toBe("gen-B")
    expect(useConnectionStore.getState().status).toBe("connecting")
    expect(useConnectionStore.getState().lastError).toBeNull()

    resolveB()
    await pendingB
    expect(useConnectionStore.getState().connectionId).toBe("gen-B")
    expect(useConnectionStore.getState().status).toBe("connecting")
  })

  it("does not let a stale connect success write after a newer generation owns the store", async () => {
    bridge.tauri = true
    bridge.nextIds = ["gen-A", "gen-B"]
    let resolveA: (value?: unknown) => void = () => {
      throw new Error("resolveA not armed")
    }
    bridge.connect
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve
          }),
      )
      .mockResolvedValueOnce(undefined)

    const pendingA = useConnectionStore.getState().connect({ ticket: "endpoint-a", key: "ka" })
    const pendingB = useConnectionStore.getState().connect({ ticket: "endpoint-b", key: "kb" })
    expect(useConnectionStore.getState().connectionId).toBe("gen-B")

    resolveA()
    await pendingA
    await pendingB

    expect(useConnectionStore.getState().connectionId).toBe("gen-B")
    expect(useConnectionStore.getState().status).toBe("connecting")
    expect(useConnectionStore.getState().lastError).toBeNull()
  })
})
