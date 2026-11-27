import { describe, expect, it, vi } from "vitest"
import {
  Connection,
  DEFAULT_PING_EVERY_MS,
  DEFAULT_PING_TIMEOUT_MS,
  DEFAULT_REDIAL_BASE_MS,
  DEFAULT_WELCOME_TIMEOUT_MS,
  LinkDriverError,
  displayStatus,
  type ConnectionOptions,
  type ConnectionState,
} from "./connection"
import { FakeDriver, ManualTimers, fatal, flush, narrativeEvent, welcome } from "./connection.testkit"

function setup(options: Partial<ConnectionOptions> = {}) {
  const driver = new FakeDriver()
  const timers = new ManualTimers()
  const connection = new Connection({
    ticket: "endpointabc",
    key: "k-ada",
    name: "Ada",
    locale: "zh",
    client: { name: "loreweaver-studio", version: "9.9.9" },
    driver,
    timers,
    now: timers.clock,
    ...options,
  })
  return { driver, timers, connection }
}

/** Dial, bring the link up and welcome it. */
async function online(options: Partial<ConnectionOptions> = {}) {
  const parts = setup(options)
  parts.connection.start()
  parts.connection.handleEvent(parts.driver.up())
  await flush()
  parts.connection.handleEvent(parts.driver.frame(welcome({ epoch: 3, head: 5 })))
  return parts
}

describe("Connection", () => {
  it("says hello first, on the link it dialled, as loreweaver-studio in the UI's language", async () => {
    const { driver, connection } = setup()
    connection.start()
    expect(driver.dials).toHaveLength(1)
    expect(driver.dials[0]).toMatchObject({ ticket: "endpointabc", network: "n0" })
    expect(connection.getState().phase).toBe("dialing")
    expect(driver.sent).toEqual([])

    connection.handleEvent(driver.up())
    await flush()
    expect(connection.getState().phase).toBe("linked")
    expect(driver.framesOn(driver.id)).toEqual([
      {
        type: "hello",
        protocol: "3.0",
        key: "k-ada",
        name: "Ada",
        locale: "zh",
        client: { name: "loreweaver-studio", version: "9.9.9" },
        caps: [],
      },
    ])
  })

  it("dials a local server without relays when asked", () => {
    const { driver, connection } = setup({ network: "local" })
    connection.start()
    expect(driver.dials[0].network).toBe("local")
  })

  it("serialises sends: a frame is not handed to the bridge until the one before it settled", async () => {
    const { driver, connection } = setup()
    let release: () => void = () => undefined
    driver.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    connection.start()
    connection.handleEvent(driver.up())
    // The session is not welcomed yet, but a ping may go out before hello settles.
    void connection.session.ping().catch(() => undefined)
    await flush()
    expect(driver.sent.map((entry) => entry.frame.type)).toEqual(["hello"])
    release()
    await flush()
    expect(driver.sent.map((entry) => entry.frame.type)).toEqual(["hello", "ping"])
  })

  it("is online once welcomed, and tells whoever asked", async () => {
    const onWelcome = vi.fn()
    const { connection } = await online({ onWelcome })
    expect(connection.getState()).toMatchObject({
      phase: "online",
      attempt: 0,
      established: true,
      failure: null,
    })
    expect(connection.session.getSnapshot().welcome?.room.id).toBe("main")
    expect(onWelcome).toHaveBeenCalledTimes(1)
  })

  it("ignores every event of a link that is not the current one", async () => {
    const { driver, connection } = setup()
    connection.start()
    connection.handleEvent(driver.up())
    await flush()
    connection.handleEvent({ kind: "frame", connectionId: "an-older-link", frame: welcome() })
    connection.handleEvent({
      kind: "status",
      connectionId: "an-older-link",
      status: "closed",
      code: "closed_by_peer",
    })
    expect(connection.getState().phase).toBe("linked")
    expect(connection.session.status).toBe("connecting")
  })

  it("after a drop, redials with backoff on a NEW link and resumes from the log it kept", async () => {
    const { driver, timers, connection } = await online()
    connection.handleEvent(driver.frame(narrativeEvent(5)))
    const first = driver.id

    connection.handleEvent(driver.closed("connection_lost"))
    expect(connection.getState()).toMatchObject({ phase: "waiting", attempt: 1 })
    expect(displayStatus(connection.getState())).toBe("reconnecting")
    expect(driver.dials).toHaveLength(1)

    timers.advance(DEFAULT_REDIAL_BASE_MS)
    expect(driver.dials).toHaveLength(2)
    const second = driver.id
    expect(second).not.toBe(first)
    expect(driver.dials[1].generation.seq).toBeGreaterThan(driver.dials[0].generation.seq)

    // The dead link's late events change nothing.
    connection.handleEvent(driver.frame(welcome({ epoch: 9 }), first))
    connection.handleEvent(driver.up())
    await flush()
    expect(driver.framesOn(second)[0]).toMatchObject({ type: "hello", resume: { epoch: 3, after: 5 } })
    connection.handleEvent(driver.frame(welcome({ epoch: 3, head: 5 })))
    expect(connection.getState()).toMatchObject({ phase: "online", attempt: 0 })
  })

  it("backs off longer on every failed redial", async () => {
    const { driver, timers, connection } = await online()
    connection.handleEvent(driver.closed("connection_lost"))
    timers.advance(DEFAULT_REDIAL_BASE_MS)
    connection.handleEvent(driver.closed("dial_timeout"))
    expect(connection.getState()).toMatchObject({ phase: "waiting", attempt: 2 })
    timers.advance(DEFAULT_REDIAL_BASE_MS)
    expect(driver.dials).toHaveLength(2)
    timers.advance(DEFAULT_REDIAL_BASE_MS)
    expect(driver.dials).toHaveLength(3)
  })

  it("a fatal error ends it for good: refused with the server's words, the link closed, no redial", async () => {
    const onRefused = vi.fn()
    const { driver, timers, connection } = setup({ onRefused })
    connection.start()
    connection.handleEvent(driver.up())
    await flush()
    connection.handleEvent(driver.frame(fatal("bad_key", "这把钥匙不认识。")))

    const failure = { kind: "refused", code: "bad_key", message: "这把钥匙不认识。" }
    expect(connection.getState()).toMatchObject({ phase: "ended", failure })
    expect(onRefused).toHaveBeenCalledWith(failure)
    expect(connection.session.canRedial).toBe(false)
    expect(driver.disconnected).toEqual([driver.id])
    // The server hangs up after its error: that close is old news.
    connection.handleEvent(driver.closed("closed_by_peer"))
    timers.advance(60_000)
    expect(driver.dials).toHaveLength(1)
    expect(connection.getState().failure).toEqual(failure)
  })

  it("refuses a welcome of another protocol major on its own", async () => {
    const { driver, connection } = setup()
    connection.start()
    connection.handleEvent(driver.up())
    await flush()
    connection.handleEvent(driver.frame(welcome({ protocol: "4.0" })))
    expect(connection.getState()).toMatchObject({
      phase: "ended",
      failure: { kind: "refused", code: "protocol_mismatch" },
    })
  })

  it("does not redial a first connection that never got in", () => {
    const { driver, timers, connection } = setup()
    connection.start()
    connection.handleEvent(driver.closed("dial_timeout"))
    expect(connection.getState()).toMatchObject({
      phase: "ended",
      established: false,
      failure: { kind: "link", code: "dial_timeout" },
    })
    timers.advance(60_000)
    expect(driver.dials).toHaveLength(1)
  })

  it("ends with the driver's own code when the dial is refused outright", async () => {
    const { driver, connection } = setup()
    driver.refuseDials = new LinkDriverError("no_shell")
    connection.start()
    await flush()
    expect(connection.getState().failure).toMatchObject({ kind: "link", code: "no_shell" })
  })

  it("drops a link that comes up but is never welcomed", async () => {
    const { driver, timers, connection } = setup()
    connection.start()
    connection.handleEvent(driver.up())
    await flush()
    timers.advance(DEFAULT_WELCOME_TIMEOUT_MS)
    expect(connection.getState().failure).toMatchObject({ kind: "link", code: "welcome_timeout" })
    expect(driver.disconnected).toEqual([driver.id])
  })

  it("pings every 15 s and, when no pong comes, drops the link and redials", async () => {
    const { driver, timers, connection } = await online()
    const first = driver.id
    timers.advance(DEFAULT_PING_EVERY_MS)
    await flush()
    const ping = driver.framesOn(first).at(-1)
    expect(ping).toMatchObject({ type: "ping" })
    // Answered: the next ping is scheduled, nothing drops.
    connection.handleEvent(driver.frame({ type: "pong", t: (ping as { t: number }).t }))
    await flush()
    expect(connection.getState().phase).toBe("online")
    timers.advance(DEFAULT_PING_EVERY_MS)
    await flush()
    expect(driver.framesOn(first).filter((frame) => frame.type === "ping")).toHaveLength(2)
    // Not answered.
    timers.advance(DEFAULT_PING_TIMEOUT_MS)
    await flush()
    expect(connection.getState()).toMatchObject({ phase: "waiting", attempt: 1 })
    expect(driver.disconnected).toEqual([first])
  })

  it("gives up after the last redial and says the table is lost", async () => {
    const { driver, timers, connection } = await online({ maxRedials: 2 })
    connection.handleEvent(driver.closed("connection_lost"))
    for (let attempt = 1; attempt <= 2; attempt++) {
      timers.advance(60_000)
      connection.handleEvent(driver.closed("dial_failed"))
    }
    expect(connection.getState()).toMatchObject({
      phase: "ended",
      failure: { kind: "lost", code: "dial_failed" },
    })
    timers.advance(60_000)
    expect(driver.dials).toHaveLength(3)
  })

  it("drops the link when the bridge refuses a send", async () => {
    const { driver, timers, connection } = await online()
    driver.refuseSends = new Error("that link is not the one seated")
    timers.advance(DEFAULT_PING_EVERY_MS)
    await flush()
    expect(connection.getState()).toMatchObject({ phase: "waiting", attempt: 1 })
  })

  it("stop closes the link and ends the session; nothing is dialled again", async () => {
    const { driver, timers, connection } = await online()
    connection.stop()
    expect(connection.getState()).toMatchObject({ phase: "ended", failure: null })
    expect(connection.session.status).toBe("ended")
    expect(driver.disconnected).toEqual([driver.id])
    connection.handleEvent(driver.closed("closed_by_peer"))
    timers.advance(60_000)
    expect(driver.dials).toHaveLength(1)
    expect(timers.pending).toBe(0)
  })

  it("stop keeps the reason a connection already ended for", async () => {
    const { driver, connection } = setup()
    connection.start()
    connection.handleEvent(driver.closed("dial_timeout"))
    connection.stop()
    expect(connection.getState().failure).toMatchObject({ code: "dial_timeout" })
  })
})

describe("Connection.want", () => {
  /** The view names each `view.subscribe` / `view.unsubscribe` call carried, in order. */
  function viewCalls(driver: FakeDriver) {
    return driver
      .framesOn(driver.id)
      .filter((frame) => frame.type === "call" && frame.method.startsWith("view."))
      .map((frame) => {
        const call = frame as unknown as { method: string; params: { names: string[] } }
        return [call.method, call.params.names]
      })
  }

  it("counts its holders: a view leaves only with the last one that wanted it", async () => {
    const { driver, connection } = await online()
    await flush()
    const first = connection.want(["admin/keys", "audio"])
    const second = connection.want(["audio"])
    await flush()
    expect(viewCalls(driver)).toEqual([["view.subscribe", ["admin/keys", "audio"]]])
    first()
    first()
    await flush()
    expect(viewCalls(driver).at(-1)).toEqual(["view.unsubscribe", ["admin/keys"]])
    second()
    await flush()
    expect(viewCalls(driver).at(-1)).toEqual(["view.unsubscribe", ["audio"]])
  })
})

describe("displayStatus", () => {
  const state = (patch: Partial<ConnectionState>): ConnectionState => ({
    phase: "idle",
    attempt: 0,
    established: false,
    failure: null,
    ...patch,
  })

  it("maps the owner's phases onto what the pill shows", () => {
    expect(displayStatus(state({ phase: "idle" }))).toBe("offline")
    expect(displayStatus(state({ phase: "dialing" }))).toBe("connecting")
    expect(displayStatus(state({ phase: "linked" }))).toBe("connecting")
    expect(displayStatus(state({ phase: "online", established: true }))).toBe("online")
    expect(displayStatus(state({ phase: "waiting", established: true }))).toBe("reconnecting")
    expect(displayStatus(state({ phase: "dialing", established: true }))).toBe("reconnecting")
    expect(displayStatus(state({ phase: "linked", established: true }))).toBe("reconnecting")
    expect(displayStatus(state({ phase: "ended" }))).toBe("offline")
  })
})
