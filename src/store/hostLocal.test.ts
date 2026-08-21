import { beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => ({
  hostLocalStart: vi.fn(async () => {}),
  hostLocalStop: vi.fn(async () => true),
  hostLocalStatus: vi.fn(async () => ({
    running: false,
    home: "/tmp/.loreweaver",
    dataDir: "/tmp/.loreweaver/data",
  })),
  onHostLocalEvent: vi.fn(async () => () => {}),
}))
vi.mock("../lib/hostLocal", () => ({ ...bridge, HOST_LOCAL_EVENT: "loreweaver://host-local" }))
// `start` refuses outright off the desktop app, so the reconnect path needs a shell.
vi.mock("../lib/transport", () => ({
  isTauri: () => true,
  transportSend: vi.fn(async () => {}),
  TRANSPORT_EVENT: "loreweaver://transport",
}))

import { useConnectionStore } from "./connection"
import { quitTable, useHostLocalStore } from "./hostLocal"

function reset() {
  useHostLocalStore.setState({
    phase: "idle",
    log: [],
    error: null,
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
    })
    useHostLocalStore.setState({ lastTicket: "tkt", lastKey: "kee", lastTicketHome: "/tmp/.loreweaver" })

    await useHostLocalStore.getState().start()

    expect(connect).toHaveBeenCalledWith({ ticket: "tkt", key: "kee" })
    expect(bridge.hostLocalStart).not.toHaveBeenCalled()
    expect(useHostLocalStore.getState().phase).toBe("ready")
  })

  it("will not dial one server with another home's credentials", async () => {
    const connect = vi.fn(async () => {})
    useConnectionStore.setState({ connect } as never)
    bridge.hostLocalStatus.mockResolvedValueOnce({
      running: true,
      home: "/tmp/other-home",
      dataDir: "/tmp/other-home/data",
    })
    useHostLocalStore.setState({ lastTicket: "tkt", lastKey: "kee", lastTicketHome: "/tmp/.loreweaver" })

    await useHostLocalStore.getState().start()

    expect(connect).not.toHaveBeenCalled()
    expect(bridge.hostLocalStart).toHaveBeenCalled() // falls through to a real start
  })

  it("remembers the credentials a ready server handed it", () => {
    useConnectionStore.setState({ connect: vi.fn(async () => {}) } as never)
    useHostLocalStore.getState().ingest({ kind: "ready", ticket: "tkt", key: "kee" })
    const state = useHostLocalStore.getState()
    expect(state.lastTicket).toBe("tkt")
    expect(state.lastKey).toBe("kee")
    const persisted = useHostLocalStore.persist.getOptions().partialize!(state) as { lastTicket: string }
    expect(persisted.lastTicket).toBe("tkt")
  })

  it("streams log lines with a cap and never loses the newest", () => {
    const ingest = useHostLocalStore.getState().ingest
    for (let i = 0; i < 450; i++) ingest({ kind: "log", level: "out", text: `line ${i}` })
    const log = useHostLocalStore.getState().log
    expect(log.length).toBe(400)
    expect(log.at(-1)).toBe("line 449")
  })

  it("dials the connection the moment the ticket + keeper key arrive", () => {
    const connect = vi.fn(async () => {})
    useConnectionStore.setState({ connect })
    useHostLocalStore.getState().ingest({ kind: "ready", ticket: "endpointabc", key: "KEEPERKEY1234567" })
    expect(useHostLocalStore.getState().phase).toBe("ready")
    expect(useHostLocalStore.getState().hostedSession).toBe(true)
    expect(connect).toHaveBeenCalledWith({ ticket: "endpointabc", key: "KEEPERKEY1234567" })
  })

  it("turns an early exit into an error, a later exit into idle", () => {
    useHostLocalStore.setState({ phase: "starting" })
    useHostLocalStore.getState().ingest({ kind: "exit", code: 1 })
    expect(useHostLocalStore.getState().phase).toBe("error")

    useHostLocalStore.setState({ phase: "ready", hostedSession: true })
    useHostLocalStore.getState().ingest({ kind: "exit", code: 0 })
    expect(useHostLocalStore.getState().phase).toBe("idle")
    expect(useHostLocalStore.getState().hostedSession).toBe(false)
  })

  it("passes the picked server folder through to the bridge on start", async () => {
    // jsdom is not the shell — fake it so start() reaches the bridge call.
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    try {
      useHostLocalStore.setState({ homeOverride: "  /Volumes/Table/loreweaver  " })
      await useHostLocalStore.getState().start()
      expect(bridge.hostLocalStart).toHaveBeenCalledWith(undefined, "/Volumes/Table/loreweaver", undefined)
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
      expect(bridge.hostLocalStart).toHaveBeenCalledWith(undefined, undefined, "/Users/nyx/packs")
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

    useHostLocalStore.setState({ hostedSession: true })
    await quitTable()
    expect(bridge.hostLocalStop).toHaveBeenCalledTimes(1)
    expect(useHostLocalStore.getState().hostedSession).toBe(false)
  })
})
