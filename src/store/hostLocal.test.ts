import { beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => ({
  hostLocalStart: vi.fn(async () => {}),
  hostLocalStop: vi.fn(async () => true),
  hostLocalStatus: vi.fn(async () => ({
    running: false,
    home: "/tmp/.loreweaver",
    dataDir: "/tmp/.loreweaver/data",
    hostId: null as string | null,
  })),
  onHostLocalEvent: vi.fn(async () => () => {}),
  mintHostId: vi.fn(() => "minted-host"),
}))
vi.mock("../lib/hostLocal", async () => {
  const actual = await vi.importActual<typeof import("../lib/hostLocal")>("../lib/hostLocal")
  return {
    ...actual,
    ...bridge,
    mintHostId: bridge.mintHostId,
    HOST_LOCAL_EVENT: "loreweaver://host-local",
  }
})
// `start` refuses outright off the desktop app, so the reconnect path needs a shell.
vi.mock("../lib/transport", () => ({
  isTauri: () => true,
  transportSend: vi.fn(async () => {}),
  TRANSPORT_EVENT: "loreweaver://transport",
}))

import type { HostLocalEvent, HostLocalEventKind } from "../lib/hostLocal"
import { useConnectionStore } from "./connection"
import { quitTable, useHostLocalStore } from "./hostLocal"

const HOST = "host-a"

function ev(event: HostLocalEventKind, hostId = HOST): HostLocalEvent {
  return { hostId, ...event }
}

function reset() {
  useHostLocalStore.setState({
    phase: "idle",
    log: [],
    error: null,
    exitKind: null,
    exitCode: null,
    hostId: null,
    stoppingHostId: null,
    hostedSession: false,
    homeOverride: "",
    effectiveHome: "",
    devSourceRoot: "",
    lastTicket: "",
    lastKey: "",
    lastTicketHome: "",
  })
}

describe("hostLocal store", () => {
  beforeEach(() => {
    reset()
    vi.clearAllMocks()
    bridge.mintHostId.mockReturnValue("minted-host")
  })

  it("sits back down at a server it already started instead of refusing to start one", async () => {
    // The dead end this closes: the WebView reloads (a paste crash, a dev HMR, a
    // devtools refresh), the Rust side is still serving, and pressing the one button
    // answered "a local server is already running" with nowhere to go — a keeper had
    // to dig a ticket out of a text file to sit back down at their own table.
    const connect = vi.fn(async () => {})
    useConnectionStore.setState({ connect } as never)
    bridge.hostLocalStatus.mockResolvedValueOnce({
      running: true,
      home: "/tmp/.loreweaver",
      dataDir: "/tmp/.loreweaver/data",
      hostId: "live-child",
    })
    useHostLocalStore.setState({ lastTicket: "tkt", lastKey: "kee", lastTicketHome: "/tmp/.loreweaver" })

    await useHostLocalStore.getState().start()

    expect(connect).toHaveBeenCalledWith({ ticket: "tkt", key: "kee" })
    expect(bridge.hostLocalStart).not.toHaveBeenCalled()
    expect(useHostLocalStore.getState().phase).toBe("ready")
    expect(useHostLocalStore.getState().hostId).toBe("live-child")
  })

  it("accepts Exit for a hostId adopted after reload", async () => {
    useConnectionStore.setState({ connect: vi.fn(async () => {}) } as never)
    bridge.hostLocalStatus.mockResolvedValueOnce({
      running: true,
      home: "/tmp/.loreweaver",
      dataDir: "/tmp/.loreweaver/data",
      hostId: "live-child",
    })
    useHostLocalStore.setState({ lastTicket: "tkt", lastKey: "kee", lastTicketHome: "/tmp/.loreweaver" })

    await useHostLocalStore.getState().start()
    useHostLocalStore.getState().ingest(ev({ kind: "exit", code: 9 }, "live-child"))

    const state = useHostLocalStore.getState()
    expect(state.phase).toBe("error")
    expect(state.hostedSession).toBe(false)
    expect(state.exitKind).toBe("unexpected")
    expect(state.exitCode).toBe(9)
    expect(state.hostId).toBeNull()
  })

  it("will not dial one server with another home's credentials", async () => {
    const connect = vi.fn(async () => {})
    useConnectionStore.setState({ connect } as never)
    bridge.hostLocalStatus.mockResolvedValueOnce({
      running: true,
      home: "/tmp/other-home",
      dataDir: "/tmp/other-home/data",
      hostId: "other-child",
    })
    useHostLocalStore.setState({ lastTicket: "tkt", lastKey: "kee", lastTicketHome: "/tmp/.loreweaver" })

    await useHostLocalStore.getState().start()

    expect(connect).not.toHaveBeenCalled()
    expect(bridge.hostLocalStart).toHaveBeenCalledWith(undefined, undefined, undefined, "minted-host")
  })

  it("mints a hostId and passes it to the bridge on a real start", async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    try {
      await useHostLocalStore.getState().start()
      expect(useHostLocalStore.getState().hostId).toBe("minted-host")
      expect(bridge.hostLocalStart).toHaveBeenCalledWith(undefined, undefined, undefined, "minted-host")
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it("remembers the credentials a ready server handed it", () => {
    useConnectionStore.setState({ connect: vi.fn(async () => {}) } as never)
    useHostLocalStore.setState({ hostId: HOST })
    useHostLocalStore.getState().ingest(ev({ kind: "ready", ticket: "tkt", key: "kee" }))
    const state = useHostLocalStore.getState()
    expect(state.lastTicket).toBe("tkt")
    expect(state.lastKey).toBe("kee")
    const persisted = useHostLocalStore.persist.getOptions().partialize!(state) as { lastTicket: string }
    expect(persisted.lastTicket).toBe("tkt")
  })

  it("streams log lines with a cap and never loses the newest", () => {
    useHostLocalStore.setState({ hostId: HOST })
    const ingest = useHostLocalStore.getState().ingest
    for (let i = 0; i < 450; i++) ingest(ev({ kind: "log", level: "out", text: `line ${i}` }))
    const log = useHostLocalStore.getState().log
    expect(log.length).toBe(400)
    expect(log.at(-1)).toBe("line 449")
  })

  it("dials the connection the moment the ticket + keeper key arrive", () => {
    const connect = vi.fn(async () => {})
    useConnectionStore.setState({ connect })
    useHostLocalStore.setState({ hostId: HOST })
    useHostLocalStore.getState().ingest(ev({ kind: "ready", ticket: "endpointabc", key: "KEEPERKEY1234567" }))
    expect(useHostLocalStore.getState().phase).toBe("ready")
    expect(useHostLocalStore.getState().hostedSession).toBe(true)
    expect(connect).toHaveBeenCalledWith({ ticket: "endpointabc", key: "KEEPERKEY1234567" })
  })

  it("turns an early exit and a ready-time crash into structured exit state", () => {
    useHostLocalStore.setState({ phase: "starting", hostId: HOST })
    useHostLocalStore.getState().ingest(ev({ kind: "exit", code: 1 }))
    expect(useHostLocalStore.getState().phase).toBe("error")
    expect(useHostLocalStore.getState().exitKind).toBe("before-ready")
    expect(useHostLocalStore.getState().exitCode).toBe(1)
    expect(useHostLocalStore.getState().hostId).toBeNull()

    useHostLocalStore.setState({
      phase: "ready",
      hostedSession: true,
      error: null,
      exitKind: null,
      log: [],
      hostId: HOST,
    })
    useHostLocalStore.getState().ingest(ev({ kind: "exit", code: 0 }))
    const afterReady = useHostLocalStore.getState()
    expect(afterReady.phase).toBe("error")
    expect(afterReady.hostedSession).toBe(false)
    expect(afterReady.exitKind).toBe("unexpected")
    expect(afterReady.exitCode).toBe(0)
    expect(afterReady.hostId).toBeNull()
  })

  it("clears a ready hosted session on a spontaneous Exit", () => {
    useHostLocalStore.setState({
      phase: "ready",
      hostedSession: true,
      error: null,
      exitKind: null,
      log: ["server is up"],
      hostId: HOST,
    })
    useHostLocalStore.getState().ingest(ev({ kind: "exit", code: 137 }))
    const state = useHostLocalStore.getState()
    expect(state.phase).toBe("error")
    expect(state.hostedSession).toBe(false)
    expect(state.exitKind).toBe("unexpected")
    expect(state.exitCode).toBe(137)
    expect(state.hostId).toBeNull()
  })

  it("drops a late Ready after Exit so a dead server cannot become ready again", () => {
    useConnectionStore.setState({ connect: vi.fn(async () => {}) } as never)
    useHostLocalStore.setState({
      phase: "ready",
      hostedSession: true,
      hostId: HOST,
      error: null,
      exitKind: null,
    })
    useHostLocalStore.getState().ingest(ev({ kind: "exit", code: 1 }))
    useHostLocalStore.getState().ingest(ev({ kind: "ready", ticket: "late", key: "kee" }))
    const state = useHostLocalStore.getState()
    expect(state.phase).toBe("error")
    expect(state.hostedSession).toBe(false)
    expect(state.exitKind).toBe("unexpected")
    expect(state.lastTicket).not.toBe("late")
  })

  it("drops a queued Exit from a previous host after a new start", () => {
    useHostLocalStore.setState({ phase: "starting", hostId: "new-host", hostedSession: false })
    useHostLocalStore.getState().ingest(ev({ kind: "exit", code: 1 }, "old-host"))
    const state = useHostLocalStore.getState()
    expect(state.phase).toBe("starting")
    expect(state.exitKind).toBeNull()
    expect(state.hostedSession).toBe(false)
    expect(state.hostId).toBe("new-host")
  })

  it("does not let a follow-up Exit overwrite a readiness error", () => {
    useHostLocalStore.setState({
      phase: "starting",
      hostedSession: false,
      error: null,
      log: [],
      hostId: HOST,
    })
    useHostLocalStore.getState().ingest(
      ev({
        kind: "error",
        message: "the server exited before it was ready",
      }),
    )
    useHostLocalStore.getState().ingest(ev({ kind: "exit", code: 1 }))
    const state = useHostLocalStore.getState()
    expect(state.phase).toBe("error")
    expect(state.hostedSession).toBe(false)
    expect(state.error).toBe("the server exited before it was ready")
    expect(state.hostId).toBeNull()
  })

  it("does not treat the confirming Exit of an explicit stop as a crash", async () => {
    useHostLocalStore.setState({
      phase: "ready",
      hostedSession: true,
      error: null,
      log: ["up"],
      hostId: HOST,
    })
    await useHostLocalStore.getState().stop()
    expect(useHostLocalStore.getState().phase).toBe("idle")
    expect(useHostLocalStore.getState().hostedSession).toBe(false)
    expect(useHostLocalStore.getState().hostId).toBeNull()
    expect(useHostLocalStore.getState().stoppingHostId).toBe(HOST)
    useHostLocalStore.getState().ingest(ev({ kind: "exit", code: null }))
    const state = useHostLocalStore.getState()
    expect(state.phase).toBe("idle")
    expect(state.hostedSession).toBe(false)
    expect(state.error).toBeNull()
    expect(state.exitKind).toBeNull()
    expect(state.log).toEqual(["up"])
    expect(state.stoppingHostId).toBeNull()
  })

  it("drops a late Ready after an explicit stop", async () => {
    useConnectionStore.setState({ connect: vi.fn(async () => {}) } as never)
    useHostLocalStore.setState({ phase: "ready", hostedSession: true, hostId: HOST })
    await useHostLocalStore.getState().stop()
    useHostLocalStore.getState().ingest(ev({ kind: "ready", ticket: "late", key: "kee" }))
    expect(useHostLocalStore.getState().phase).toBe("idle")
    expect(useHostLocalStore.getState().hostedSession).toBe(false)
  })

  it("passes the picked server folder through to the bridge on start", async () => {
    // jsdom is not the shell — fake it so start() reaches the bridge call.
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    try {
      useHostLocalStore.setState({ homeOverride: "  /Volumes/Table/loreweaver  " })
      await useHostLocalStore.getState().start()
      expect(bridge.hostLocalStart).toHaveBeenCalledWith(
        undefined,
        "/Volumes/Table/loreweaver",
        undefined,
        "minted-host",
      )
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it("remembers the dev-room source root it started with", async () => {
    // `TRPG_DEV__SOURCE_ROOT` is read at STARTUP, so a caller that needs a
    // different root has to restart — which it can only know by asking.
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    try {
      await useHostLocalStore.getState().start("/Users/nyx/packs")
      expect(bridge.hostLocalStart).toHaveBeenCalledWith(
        undefined,
        undefined,
        "/Users/nyx/packs",
        "minted-host",
      )
      expect(useHostLocalStore.getState().devSourceRoot).toBe("/Users/nyx/packs")
      await useHostLocalStore.getState().stop()
      expect(useHostLocalStore.getState().devSourceRoot).toBe("")
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it("quitTable stops the server only for sessions we hosted ourselves", async () => {
    const disconnect = vi.fn(async () => {})
    useConnectionStore.setState({ disconnect })

    useHostLocalStore.setState({ hostedSession: false })
    await quitTable()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(bridge.hostLocalStop).not.toHaveBeenCalled()

    useHostLocalStore.setState({ hostedSession: true, hostId: HOST })
    await quitTable()
    expect(bridge.hostLocalStop).toHaveBeenCalledTimes(1)
    expect(useHostLocalStore.getState().hostedSession).toBe(false)
  })
})
