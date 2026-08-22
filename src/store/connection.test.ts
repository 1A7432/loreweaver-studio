import { beforeEach, describe, expect, it, vi } from "vitest"
import { PROTOCOL_VERSION } from "@loreweaver/protocol"

const transport = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  transportConnect: vi.fn(async () => {}),
  transportDisconnect: vi.fn(async () => {}),
}))

vi.mock("../lib/transport", () => ({
  isTauri: () => transport.isTauri(),
  transportConnect: transport.transportConnect,
  transportDisconnect: transport.transportDisconnect,
  TRANSPORT_EVENT: "loreweaver://transport",
}))

import { sanitizeTicket, useConnectionStore } from "./connection"
import { useAdminStore } from "./admin"

const WELCOME = {
  type: "welcome",
  protocol: PROTOCOL_VERSION,
  room: "r1",
  you: { id: "u1", name: "Nyx", role: "player" },
  locale: "en",
  server: "loreweaver/1",
}

function reset() {
  transport.isTauri.mockReturnValue(false)
  transport.transportConnect.mockClear()
  transport.transportDisconnect.mockClear()
  useConnectionStore.setState({
    status: "offline",
    attempt: 0,
    lastError: null,
    welcome: null,
    refused: false,
  })
  useAdminStore.getState().reset()
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
    const handle = useConnectionStore.getState().handleEvent
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
    const handle = useConnectionStore.getState().handleEvent
    handle({ kind: "frame", frame: { type: "welcome" } })
    handle({ kind: "frame", frame: "not even an object" })
    handle({ kind: "frame", frame: { type: "state" } })
    expect(useConnectionStore.getState().welcome).toBeNull()
  })

  it("keeps the fatal error and clears the welcome when going offline", () => {
    const handle = useConnectionStore.getState().handleEvent
    handle({ kind: "frame", frame: WELCOME })
    handle({ kind: "status", status: "online", attempt: 0 })
    handle({ kind: "status", status: "offline", attempt: 0, error: "bad_key: unknown key" })

    const state = useConnectionStore.getState()
    expect(state.status).toBe("offline")
    expect(state.lastError).toContain("bad_key")
    expect(state.welcome).toBeNull()
  })

  it("refuses a welcome announcing a different protocol MAJOR", () => {
    const handle = useConnectionStore.getState().handleEvent
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
    const handle = useConnectionStore.getState().handleEvent
    handle({ kind: "status", status: "connecting", attempt: 0 })
    handle({ kind: "frame", frame: { type: "welcome", protocol: PROTOCOL_VERSION } })
    handle({ kind: "status", status: "online", attempt: 0 })

    const state = useConnectionStore.getState()
    expect(state.status).toBe("offline")
    expect(state.welcome).toBeNull()
    expect(state.lastError).not.toBeNull()
  })

  it("lifts the refusal on the next explicit connect, not before", async () => {
    const handle = useConnectionStore.getState().handleEvent
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
    const handle = useConnectionStore.getState().handleEvent
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
    const handle = useConnectionStore.getState().handleEvent
    const major = PROTOCOL_VERSION.split(".")[0]
    handle({ kind: "frame", frame: { ...WELCOME, protocol: `${major}.999` } })

    const state = useConnectionStore.getState()
    expect(state.welcome?.room).toBe("r1")
    expect(state.lastError).toBeNull()
  })

  it("tracks redial attempts while reconnecting", () => {
    const handle = useConnectionStore.getState().handleEvent
    handle({ kind: "status", status: "reconnecting", attempt: 3 })
    expect(useConnectionStore.getState().attempt).toBe(3)
  })

  it("refuses to connect outside the tauri shell", async () => {
    await useConnectionStore.getState().connect({ ticket: "endpoint-x", key: "k" })
    const state = useConnectionStore.getState()
    expect(state.status).toBe("offline")
    expect(state.lastError).toContain("app shell")
  })

  it("drops keeper-admin leftovers on an explicit new dial, not on auto-reconnect", async () => {
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

    const handle = useConnectionStore.getState().handleEvent
    handle({ kind: "status", status: "reconnecting", attempt: 2 })
    handle({ kind: "status", status: "online", attempt: 2 })
    expect(useAdminStore.getState().lastError).toBe("stale forbidden")
    expect(useAdminStore.getState().generated?.name).toBe("Old Room Module")
    expect(useAdminStore.getState().roomOp?.room).toBe("old-room")
    expect(useAdminStore.getState().serverUpdate?.status).toBe("failed")

    transport.isTauri.mockReturnValue(true)
    await useConnectionStore.getState().connect({ ticket: "endpoint-new", key: "k" })
    const admin = useAdminStore.getState()
    expect(admin.generated).toBeNull()
    expect(admin.roomOp).toBeNull()
    expect(admin.serverUpdate).toBeNull()
    expect(admin.lastError).toBeNull()
    expect(transport.transportConnect).toHaveBeenCalled()
  })
})
