import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionFailure, ConnectionState } from "../lib/connection"
import type { HostExited, HostReady } from "../lib/hostLocal"

const bridge = vi.hoisted(() => ({
  tauri: true,
  hostLocalStart: vi.fn(),
  hostLocalStop: vi.fn(async () => true),
  hostLocalStatus: vi.fn(async () => ({
    home: "/app/local-server",
    dataDir: "/app/local-server/data",
    running: false,
  })),
  hostLocalForgetKey: vi.fn(async () => true),
  /** The store's exit handler, registered by its first start (once per module). */
  exit: undefined as ((event: HostExited) => void) | undefined,
  onHostLocalExit: vi.fn(async (handler: (event: HostExited) => void) => {
    bridge.exit = handler
    return () => {}
  }),
}))
vi.mock("../lib/hostLocal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/hostLocal")>()
  return {
    ...actual,
    hostLocalStart: bridge.hostLocalStart,
    hostLocalStop: bridge.hostLocalStop,
    hostLocalStatus: bridge.hostLocalStatus,
    hostLocalForgetKey: bridge.hostLocalForgetKey,
    onHostLocalExit: bridge.onHostLocalExit,
  }
})
vi.mock("../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/transport")>()
  return { ...actual, isTauri: () => bridge.tauri }
})

import { useConnectionStore } from "./connection"
import { quitTable, useHostLocalStore } from "./hostLocal"

const READY: HostReady = {
  hostId: "host-1",
  ticket: "endpointlocal",
  key: "admin-key-secret",
  room: "main",
  keySource: "first",
  notes: ["model_not_configured"],
  version: "3.0.0",
  dataDir: "/app/local-server/data",
  network: "n0",
  reused: false,
}

/** Just enough of a `Connection` for the store: its state, its listeners, stop. */
function fakeConnection() {
  let state: ConnectionState = { phase: "dialing", attempt: 0, established: false, failure: null }
  const listeners = new Set<() => void>()
  const set = (next: Partial<ConnectionState>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  return {
    stop: vi.fn(() => set({ phase: "ended" })),
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    end: (failure: ConnectionFailure) => set({ phase: "ended", failure }),
  }
}

let connection = fakeConnection()
const connect = vi.fn(async (params: { ticket: string; key: string; network?: string }) => {
  void params
  useConnectionStore.setState({ connection: connection as never })
})
const disconnect = vi.fn(async () => {
  useConnectionStore.getState().connection?.stop()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  bridge.tauri = true
  connection = fakeConnection()
  useConnectionStore.setState({ connection: null, connect: connect as never, disconnect })
  useHostLocalStore.setState({
    phase: "idle",
    problem: null,
    hosted: null,
    connection: null,
    notesDismissed: false,
    homeOverride: "",
    effectiveHome: "",
    running: false,
  })
})

describe("hostLocal store", () => {
  it("starts the server and sits down at it as the room admin, dialling it as any pasted ticket is dialled", async () => {
    bridge.hostLocalStart.mockResolvedValueOnce(READY)
    useHostLocalStore.setState({ homeOverride: " /srv/lw " })
    await useHostLocalStore.getState().start()
    expect(bridge.hostLocalStart).toHaveBeenCalledWith(expect.objectContaining({ homeOverride: "/srv/lw" }))
    expect(connect).toHaveBeenCalledWith({
      ticket: "endpointlocal",
      key: "admin-key-secret",
      network: "n0",
    })
    const state = useHostLocalStore.getState()
    expect(state.phase).toBe("hosting")
    expect(state.connection).toBe(connection)
    expect(state.hosted).toEqual({
      hostId: "host-1",
      dataDir: "/app/local-server/data",
      room: "main",
      keySource: "first",
      notes: ["model_not_configured"],
    })
    // The key went to the connection and is kept nowhere in this store.
    expect(JSON.stringify(state)).not.toContain("admin-key-secret")
  })

  it("dials the profile Rust reports: a server hosted loopback-only for a test is dialled with `local`", async () => {
    bridge.hostLocalStart.mockResolvedValueOnce({ ...READY, network: "local" })
    await useHostLocalStore.getState().start()
    expect(connect).toHaveBeenCalledWith({
      ticket: "endpointlocal",
      key: "admin-key-secret",
      network: "local",
    })
  })

  it("is starting while Rust waits for the ready line", async () => {
    const pending = deferred<HostReady>()
    bridge.hostLocalStart.mockReturnValueOnce(pending.promise)
    const started = useHostLocalStore.getState().start()
    await settle()
    expect(useHostLocalStore.getState().phase).toBe("starting")
    // A second press while starting does nothing.
    await useHostLocalStore.getState().start()
    expect(bridge.hostLocalStart).toHaveBeenCalledTimes(1)
    pending.resolve(READY)
    await started
    expect(useHostLocalStore.getState().phase).toBe("hosting")
  })

  it("says what the server refused, with its code and problems", async () => {
    const refused = {
      code: "refused",
      refusal: "bad_settings",
      problems: [{ variable: "TRPG_LLM__API_KEY", problem: "missing" }],
    }
    bridge.hostLocalStart.mockRejectedValueOnce(refused)
    await useHostLocalStore.getState().start()
    expect(useHostLocalStore.getState()).toMatchObject({ phase: "failed", problem: refused })
    expect(connect).not.toHaveBeenCalled()
  })

  it("turns a rejection that is not a failure into an io problem", async () => {
    bridge.hostLocalStart.mockRejectedValueOnce("ipc broke")
    await useHostLocalStore.getState().start()
    expect(useHostLocalStore.getState().problem).toEqual({ code: "io", detail: "ipc broke" })
  })

  it("off the desktop app it says so and starts nothing", async () => {
    bridge.tauri = false
    await useHostLocalStore.getState().start()
    expect(useHostLocalStore.getState().problem).toEqual({ code: "desktop_only" })
    expect(bridge.hostLocalStart).not.toHaveBeenCalled()
  })

  it("Cancel during the start stops it, and its late answer is not shown", async () => {
    const pending = deferred<HostReady>()
    bridge.hostLocalStart.mockReturnValueOnce(pending.promise)
    const started = useHostLocalStore.getState().start()
    await settle()
    await useHostLocalStore.getState().stop()
    expect(bridge.hostLocalStop).toHaveBeenCalledTimes(1)
    pending.reject({ code: "cancelled" })
    await started
    expect(useHostLocalStore.getState()).toMatchObject({ phase: "idle", problem: null })
  })

  it("a server that came up after Cancel reached Rust first is stopped again", async () => {
    const pending = deferred<HostReady>()
    bridge.hostLocalStart.mockReturnValueOnce(pending.promise)
    const started = useHostLocalStore.getState().start()
    await settle()
    await useHostLocalStore.getState().stop()
    pending.resolve(READY)
    await started
    expect(bridge.hostLocalStop).toHaveBeenCalledTimes(2)
    expect(connect).not.toHaveBeenCalled()
    expect(useHostLocalStore.getState().phase).toBe("idle")
  })

  it("a server that died ends the table and says so with its last lines", async () => {
    bridge.hostLocalStart.mockResolvedValueOnce(READY)
    await useHostLocalStore.getState().start()
    const exited = bridge.exit
    expect(exited).toBeDefined()
    // Another server's death is not this one's.
    exited?.({ hostId: "host-0", code: 1, stderr: [] })
    expect(useHostLocalStore.getState().phase).toBe("hosting")
    exited?.({ hostId: "host-1", code: 7, stderr: ["fatal: the store went away"] })
    expect(useHostLocalStore.getState()).toMatchObject({
      phase: "failed",
      problem: { code: "died", exitCode: 7, stderr: ["fatal: the store went away"] },
      hosted: null,
      connection: null,
    })
    expect(connection.stop).toHaveBeenCalled()
  })

  it("leaving the hosted table stops its server; leaving another table does not", async () => {
    bridge.hostLocalStart.mockResolvedValueOnce(READY)
    await useHostLocalStore.getState().start()
    await quitTable()
    expect(disconnect).toHaveBeenCalled()
    expect(bridge.hostLocalStop).toHaveBeenCalledTimes(1)
    expect(useHostLocalStore.getState().phase).toBe("idle")

    vi.clearAllMocks()
    connection = fakeConnection()
    useConnectionStore.setState({ connection: connection as never })
    await quitTable()
    expect(disconnect).toHaveBeenCalled()
    expect(bridge.hostLocalStop).not.toHaveBeenCalled()
  })

  it("a kept key the server turns down is forgotten and the server stopped", async () => {
    bridge.hostLocalStart.mockResolvedValueOnce({ ...READY, keySource: "kept" })
    await useHostLocalStore.getState().start()
    connection.end({ kind: "refused", code: "bad_key", message: "unknown key" })
    await settle()
    expect(useHostLocalStore.getState()).toMatchObject({ phase: "failed", problem: { code: "key_refused" } })
    expect(bridge.hostLocalForgetKey).toHaveBeenCalled()
    expect(bridge.hostLocalStop).toHaveBeenCalled()
  })

  it("another way the hosted table ends leaves the server running", async () => {
    bridge.hostLocalStart.mockResolvedValueOnce(READY)
    await useHostLocalStore.getState().start()
    connection.end({ kind: "lost", code: "connection_lost", detail: "gone" })
    await settle()
    expect(useHostLocalStore.getState().phase).toBe("hosting")
    expect(bridge.hostLocalStop).not.toHaveBeenCalled()
  })

  it("keeps only the folder from what 2.x persisted", () => {
    const migrate = useHostLocalStore.persist.getOptions().migrate
    expect(
      migrate?.({ homeOverride: "/old", lastTicket: "t", lastKey: "k", lastTicketHome: "/old" }, 0),
    ).toEqual({
      homeOverride: "/old",
    })
    expect(migrate?.(undefined, 0)).toEqual({ homeOverride: "" })
  })
})
