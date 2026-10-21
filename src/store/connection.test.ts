import { beforeEach, describe, expect, it, vi } from "vitest"
import { PROTOCOL_VERSION } from "@loreweaver/protocol"
import i18n from "../i18n"
import type { TransportEvent } from "../lib/transport"
import { sanitizeTicket, useConnectionStore } from "./connection"
import { useLastTableStore } from "./lastTable"
import { useSessionStore } from "./session"

const bridge = vi.hoisted(() => ({
  tauri: false,
  nextIds: [] as string[],
  seq: 0,
  connect: vi.fn(),
  disconnect: vi.fn(),
}))

vi.mock("../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/transport")>()
  return {
    ...actual,
    isTauri: () => bridge.tauri,
    createConnection: () => {
      const id = bridge.nextIds.shift()
      bridge.seq += 1
      return {
        connectionId: id ?? actual.createConnection().connectionId,
        session: "page-under-test",
        seq: bridge.seq,
      }
    },
    transportConnect: ((...args: unknown[]) => bridge.connect(...args)) as typeof actual.transportConnect,
    transportDisconnect: ((...args: unknown[]) =>
      bridge.disconnect(...args)) as typeof actual.transportDisconnect,
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
  bridge.seq = 0
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
  useLastTableStore.getState().forget()
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

  it("rebuilds the log from the join replay after the transport redials by itself", () => {
    // The welcome never used to reach the session store, so every automatic
    // reconnect appended the server's replay (fresh ids and all) to the log.
    let replayId = 0
    const join = (status: "connecting" | "reconnecting") => {
      handle({ kind: "status", status, attempt: 1 })
      handle({ kind: "frame", frame: WELCOME })
      handle({ kind: "status", status: "online", attempt: 0 })
      for (const text of ["The pier creaks.", "A lantern gutters."]) {
        replayId += 1
        handle({
          kind: "frame",
          frame: { type: "narrative", id: `replay-${replayId}`, speaker: "kp", text, format: "markdown" },
        })
      }
      handle({ kind: "frame", frame: { type: "state", party: [], initiative: [], online: 1 } })
    }
    const texts = () =>
      useSessionStore
        .getState()
        .entries.map((entry) => (entry.kind === "narrative" ? entry.frame.text : entry.kind))

    join("connecting")
    handle({ kind: "status", status: "reconnecting", attempt: 1 })
    join("reconnecting")
    handle({ kind: "status", status: "reconnecting", attempt: 1 })
    join("reconnecting")

    expect(texts()).toEqual(["The pier creaks.", "A lantern gutters."])
  })

  it("leaves the log alone when it refuses the welcome", () => {
    useSessionStore.getState().ingest({
      type: "narrative",
      id: "n1",
      speaker: "kp",
      text: "The pier creaks.",
      format: "markdown",
    })
    handle({ kind: "frame", frame: { ...WELCOME, protocol: "4.0" } })
    expect(useSessionStore.getState().entries).toHaveLength(1)
  })

  it("words a connect timeout for the operator, with the transport's detail kept out of it", async () => {
    await i18n.changeLanguage("en")
    handle({ kind: "status", status: "connecting", attempt: 0 })
    handle({
      kind: "status",
      status: "offline",
      attempt: 0,
      error: "connect timeout: no connection to the host within 15s",
      errorCode: "connect_timeout",
    })

    const state = useConnectionStore.getState()
    expect(state.status).toBe("offline")
    expect(state.lastError).toBe(i18n.t("connect.error.connectTimeout"))
    expect(state.lastError).toContain("ticket")
    expect(state.lastError).not.toContain("15s")

    // Same event, other language: the sentence follows the operator's locale.
    await i18n.changeLanguage("zh")
    try {
      handle({
        kind: "status",
        status: "offline",
        attempt: 0,
        error: "connect timeout: no connection to the host within 15s",
        errorCode: "connect_timeout",
      })
      expect(useConnectionStore.getState().lastError).toBe(i18n.t("connect.error.connectTimeout"))
      expect(useConnectionStore.getState().lastError).toMatch(/[\u4e00-\u9fff]/)
    } finally {
      await i18n.changeLanguage("en")
    }
  })

  it("words the join timeout and an outright connect failure too", async () => {
    await i18n.changeLanguage("en")
    handle({
      kind: "status",
      status: "offline",
      attempt: 0,
      error: "join timeout",
      errorCode: "join_timeout",
    })
    expect(useConnectionStore.getState().lastError).toBe(i18n.t("connect.error.joinTimeout"))

    handle({
      kind: "status",
      status: "offline",
      attempt: 0,
      error: "connect failed: connect: no route",
      errorCode: "connect_failed",
    })
    // The failed-connect sentence carries the transport's reason, since that
    // is the only thing that tells the operator what went wrong.
    expect(useConnectionStore.getState().lastError).toContain("connect failed: connect: no route")
  })

  it("shows a failure it has no sentence for exactly as the transport said it", () => {
    handle({ kind: "status", status: "offline", attempt: 0, error: "invalid ticket: nope" })
    expect(useConnectionStore.getState().lastError).toBe("invalid ticket: nope")
    // An unknown future code falls back the same way rather than showing a key.
    handle({
      kind: "status",
      status: "offline",
      attempt: 0,
      error: "something new",
      errorCode: "from_the_future",
    })
    expect(useConnectionStore.getState().lastError).toBe("something new")
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

  it("hands the bridge an ordering a stale dial can be refused by", async () => {
    // The Rust slot used to seat whoever invoked last, whatever the WebView was
    // on: a slow dial from a generation the operator had left would close the
    // live actor and seat itself in its place, and every event the replacement
    // emitted was then dropped on arrival while the offline from the actor it
    // had just killed was accepted. A fast reconnect took a healthy table
    // apart. The slot can only refuse that dial if it is told who is asking.
    bridge.tauri = true
    bridge.nextIds = ["gen-A", "gen-B"]

    await useConnectionStore.getState().connect({ ticket: "endpoint-a", key: "ka" })
    await useConnectionStore.getState().connect({ ticket: "endpoint-b", key: "kb" })

    const first = bridge.connect.mock.calls[0][0].generation
    const second = bridge.connect.mock.calls[1][0].generation
    expect(first.connectionId).toBe("gen-A")
    expect(second.connectionId).toBe("gen-B")
    expect(second.session).toBe(first.session)
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  it("names the generation it is dropping, so a disconnect cannot take a newer actor with it", async () => {
    bridge.tauri = true
    bridge.nextIds = ["gen-A"]
    await useConnectionStore.getState().connect({ ticket: "endpoint-a", key: "ka" })

    await useConnectionStore.getState().disconnect()

    expect(bridge.disconnect).toHaveBeenCalledWith("gen-A")
    expect(useConnectionStore.getState().connectionId).toBeNull()
  })

  it("holds no generation, so it asks the bridge to drop nothing", async () => {
    // After a reload the store owns no connection. The actor the previous page
    // seated is not ours to close — the next dial replaces it.
    bridge.tauri = true
    useConnectionStore.setState({ connectionId: null })

    await useConnectionStore.getState().disconnect()

    expect(bridge.disconnect).toHaveBeenCalledWith(null)
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

describe("remembering a hand-dialed table", () => {
  const params = { ticket: " ticket=endpointabc\n123 ", key: " k-1 ", name: " Nyx " }

  beforeEach(() => {
    reset()
    bridge.tauri = true
  })

  /** Dial as the connect form does, then let the bridge speak under that dial's id. */
  async function dial(id: string, remember: boolean) {
    bridge.nextIds = [id]
    await useConnectionStore.getState().connect(params, remember ? { remember: true } : undefined)
  }

  it("remembers the (sanitized) ticket, key and name once the welcome is accepted", async () => {
    await dial("gen-a", true)
    // Not on dial: a table that never answered is not a table worth coming back to.
    expect(useLastTableStore.getState().ticket).toBe("")
    handle({ kind: "status", connectionId: "gen-a", status: "connecting", attempt: 0 })
    expect(useLastTableStore.getState().ticket).toBe("")

    handle({ kind: "frame", connectionId: "gen-a", frame: WELCOME })
    expect(useLastTableStore.getState()).toMatchObject({
      ticket: "endpointabc123",
      key: "k-1",
      name: "Nyx",
    })
  })

  it("does both on one welcome: saves the table and rebuilds the log from the replay", async () => {
    // The welcome has two jobs that must not shadow each other: the store
    // remembers the hand-dialed table AND the session store hears it, so an
    // earlier transcript is replaced by the join replay instead of extended.
    await dial("gen-both", true)
    // dial() wipes the log; a line that lands before the welcome stands for what an
    // earlier session of this client had already shown.
    useSessionStore.getState().ingest({
      type: "narrative",
      id: "old-1",
      speaker: "kp",
      text: "The pier creaks.",
      format: "markdown",
    })
    handle({ kind: "frame", connectionId: "gen-both", frame: WELCOME })
    handle({
      kind: "frame",
      connectionId: "gen-both",
      frame: {
        type: "narrative",
        id: "replay-1",
        speaker: "kp",
        text: "The pier creaks.",
        format: "markdown",
      },
    })
    handle({
      kind: "frame",
      connectionId: "gen-both",
      frame: { type: "state", party: [], initiative: [], online: 1 },
    })

    expect(useLastTableStore.getState()).toMatchObject({ ticket: "endpointabc123", key: "k-1", name: "Nyx" })
    expect(
      useSessionStore
        .getState()
        .entries.map((entry) => (entry.kind === "narrative" ? entry.frame.id : entry.kind)),
    ).toEqual(["replay-1"])
  })

  it("does not remember a dial nobody asked to remember (the local-host path)", async () => {
    useLastTableStore.getState().remember({ ticket: "endpointold", key: "k-old", name: "" })
    await dial("gen-b", false)
    handle({ kind: "frame", connectionId: "gen-b", frame: WELCOME })
    expect(useLastTableStore.getState().ticket).toBe("endpointold")
  })

  it("does not let a later plain dial inherit an earlier remembered one", async () => {
    await dial("gen-c", true)
    bridge.nextIds = ["gen-d"]
    await useConnectionStore.getState().connect({ ticket: "endpointlocal", key: "k-local" })
    // The first dial's welcome arrives late, from a generation that is gone.
    handle({ kind: "frame", connectionId: "gen-c", frame: WELCOME })
    handle({ kind: "frame", connectionId: "gen-d", frame: WELCOME })
    expect(useLastTableStore.getState().ticket).toBe("")
  })

  it("does not remember a server whose handshake the app refused", async () => {
    await dial("gen-e", true)
    handle({ kind: "frame", connectionId: "gen-e", frame: { ...WELCOME, protocol: "99.0" } })
    expect(useLastTableStore.getState().ticket).toBe("")
  })

  it("forgets the saved table when the server rejects its key", async () => {
    useLastTableStore.getState().remember({ ticket: "endpointabc123", key: "k-1", name: "Nyx" })
    await dial("gen-f", true)
    handle({
      kind: "frame",
      connectionId: "gen-f",
      frame: { type: "error", code: "bad_key", message: "unknown key" },
    })
    expect(useLastTableStore.getState()).toMatchObject({ ticket: "", key: "", name: "" })
  })

  it("keeps the saved table when a DIFFERENT key the player typed is the one rejected", async () => {
    useLastTableStore.getState().remember({ ticket: "endpointabc123", key: "k-good", name: "Nyx" })
    await dial("gen-g", true)
    handle({
      kind: "frame",
      connectionId: "gen-g",
      frame: { type: "error", code: "bad_key", message: "unknown key" },
    })
    expect(useLastTableStore.getState().key).toBe("k-good")
  })

  it("keeps the saved table through every other failure", async () => {
    useLastTableStore.getState().remember({ ticket: "endpointabc123", key: "k-1", name: "Nyx" })
    await dial("gen-h", true)
    handle({
      kind: "frame",
      connectionId: "gen-h",
      frame: { type: "error", code: "rate_limited", message: "slow down" },
    })
    handle({ kind: "status", connectionId: "gen-h", status: "offline", attempt: 0, error: "invalid ticket" })
    expect(useLastTableStore.getState().key).toBe("k-1")
  })

  it("keeps the saved table when the dial times out: a stale address is not a bad table", async () => {
    useLastTableStore.getState().remember({ ticket: "endpointabc123", key: "k-1", name: "Nyx" })
    await dial("gen-i", true)
    handle({
      kind: "status",
      connectionId: "gen-i",
      status: "offline",
      attempt: 0,
      error: "connect timeout: no connection to the host within 15s",
      errorCode: "connect_timeout",
    })
    expect(useConnectionStore.getState().lastError).toBe(i18n.t("connect.error.connectTimeout"))
    expect(useLastTableStore.getState()).toMatchObject({ ticket: "endpointabc123", key: "k-1", name: "Nyx" })
  })
})

describe("cancelling a dial", () => {
  beforeEach(reset)

  it("drops the attempt at once, names it to the bridge, and lets the next connect through", async () => {
    bridge.tauri = true
    bridge.nextIds = ["gen-A", "gen-B"]
    await useConnectionStore.getState().connect({ ticket: "endpoint-a", key: "ka" })
    expect(useConnectionStore.getState().status).toBe("connecting")

    await useConnectionStore.getState().disconnect()

    // Cancel is the ordinary disconnect: offline now, the dying actor's own
    // events can no longer write back, and the bridge is asked to close it.
    expect(useConnectionStore.getState().status).toBe("offline")
    expect(useConnectionStore.getState().connectionId).toBeNull()
    expect(useConnectionStore.getState().lastError).toBeNull()
    expect(bridge.disconnect).toHaveBeenCalledWith("gen-A")
    handle({ kind: "status", status: "online", attempt: 0, connectionId: "gen-A" })
    expect(useConnectionStore.getState().status).toBe("offline")

    // The button works again immediately: a fresh generation, a fresh dial.
    await useConnectionStore.getState().connect({ ticket: "endpoint-b", key: "kb" })
    expect(useConnectionStore.getState().status).toBe("connecting")
    expect(useConnectionStore.getState().connectionId).toBe("gen-B")
    expect(bridge.connect).toHaveBeenCalledTimes(2)
  })

  it("closes the actor a cancelled dial seated after the cancel had already passed", async () => {
    // The cancel can reach the bridge before the dial it cancels has been
    // seated: the slot then holds nothing of that generation to close, and the
    // actor seated a moment later would dial on with no one listening.
    bridge.tauri = true
    bridge.nextIds = ["gen-A"]
    let seat: (value?: unknown) => void = () => {
      throw new Error("seat not armed")
    }
    bridge.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          seat = resolve
        }),
    )

    const pending = useConnectionStore.getState().connect({ ticket: "endpoint-a", key: "ka" })
    await useConnectionStore.getState().disconnect()
    expect(bridge.disconnect).toHaveBeenCalledTimes(1)

    seat()
    await pending

    expect(bridge.disconnect).toHaveBeenCalledTimes(2)
    expect(bridge.disconnect).toHaveBeenLastCalledWith("gen-A")
    expect(useConnectionStore.getState().status).toBe("offline")
    expect(useConnectionStore.getState().connectionId).toBeNull()
  })

  it("leaves a newer dial alone when an older one is seated late", async () => {
    bridge.tauri = true
    bridge.nextIds = ["gen-A", "gen-B"]
    let seatA: (value?: unknown) => void = () => {
      throw new Error("seatA not armed")
    }
    bridge.connect
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            seatA = resolve
          }),
      )
      .mockResolvedValueOnce(undefined)

    const pendingA = useConnectionStore.getState().connect({ ticket: "endpoint-a", key: "ka" })
    await useConnectionStore.getState().connect({ ticket: "endpoint-b", key: "kb" })
    seatA()
    await pendingA

    // B owns the store; A's late seat must not ask the bridge to drop anything
    // (the slot replaced A when B was seated).
    expect(bridge.disconnect).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().connectionId).toBe("gen-B")
    expect(useConnectionStore.getState().status).toBe("connecting")
  })

  it("a dial that timed out leaves the store offline with the reason and ready for the next dial", async () => {
    bridge.tauri = true
    bridge.nextIds = ["gen-A", "gen-B"]
    await i18n.changeLanguage("en")
    await useConnectionStore.getState().connect({ ticket: "endpoint-a", key: "ka" })

    handle({
      kind: "status",
      status: "offline",
      attempt: 0,
      error: "connect timeout: no connection to the host within 15s",
      errorCode: "connect_timeout",
      connectionId: "gen-A",
    })
    expect(useConnectionStore.getState().status).toBe("offline")
    expect(useConnectionStore.getState().lastError).toBe(i18n.t("connect.error.connectTimeout"))

    await useConnectionStore.getState().connect({ ticket: "endpoint-b", key: "kb" })
    expect(useConnectionStore.getState().status).toBe("connecting")
    expect(useConnectionStore.getState().lastError).toBeNull()
    expect(bridge.connect).toHaveBeenCalledTimes(2)
  })
})
