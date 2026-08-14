import { beforeEach, describe, expect, it } from "vitest"
import { PROTOCOL_VERSION } from "@loreweaver/protocol"
import { sanitizeTicket, useConnectionStore } from "./connection"

const WELCOME = {
  type: "welcome",
  protocol: PROTOCOL_VERSION,
  room: "r1",
  you: { id: "u1", name: "Nyx", role: "player" },
  locale: "en",
  server: "loreweaver/1",
}

function reset() {
  useConnectionStore.setState({ status: "offline", attempt: 0, lastError: null, welcome: null })
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

    const state = useConnectionStore.getState()
    // Refused: never online, no welcome to render a room from, and the reason names
    // both versions so the operator knows which side to move.
    expect(state.status).toBe("offline")
    expect(state.welcome).toBeNull()
    expect(state.lastError).toContain("4.0")
    expect(state.lastError).toContain(PROTOCOL_VERSION)
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
})
