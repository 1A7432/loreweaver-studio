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
  })
}

describe("hostLocal store", () => {
  beforeEach(() => {
    reset()
    vi.clearAllMocks()
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
      expect(bridge.hostLocalStart).toHaveBeenCalledWith(undefined, "/Volumes/Table/loreweaver")
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
