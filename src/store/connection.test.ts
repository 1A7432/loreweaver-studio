import { beforeEach, describe, expect, it, vi } from "vitest"
import { fatal, flush, welcome } from "../lib/connection.testkit"
import type { LinkEvent } from "../lib/transport"
import { STUDIO_VERSION } from "../version"
import { CLIENT_NAME, sanitizeTicket, useConnectionStore } from "./connection"
import { useLastTableStore } from "./lastTable"

const bridge = vi.hoisted(() => ({
  tauri: true,
  linkConnect: vi.fn(
    async (params: { ticket: string; network: string; generation: { connectionId: string } }) => void params,
  ),
  linkSend: vi.fn(async (connectionId: string, frame: unknown) => void [connectionId, frame]),
  linkDisconnect: vi.fn(async (connectionId: string) => void connectionId),
}))

vi.mock("../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/transport")>()
  return {
    ...actual,
    isTauri: () => bridge.tauri,
    linkConnect: bridge.linkConnect,
    linkSend: bridge.linkSend,
    linkDisconnect: bridge.linkDisconnect,
  }
})

/** The bridge generation of the n-th dial (the latest by default). */
function linkId(index = -1): string {
  const call = bridge.linkConnect.mock.calls.at(index)
  if (call === undefined) throw new Error("nothing dialled")
  return call[0].generation.connectionId
}

function handle(event: LinkEvent): void {
  useConnectionStore.getState().handleEvent(event)
}

/** Bring the latest link up and welcome it. */
async function welcomeLatest(): Promise<void> {
  const connectionId = linkId()
  handle({ kind: "status", connectionId, status: "up" })
  await flush()
  handle({ kind: "frame", connectionId, frame: welcome() })
}

function reset() {
  useConnectionStore.getState().connection?.stop()
  useConnectionStore.setState({ connection: null })
  useLastTableStore.getState().forget()
  bridge.tauri = true
  bridge.linkConnect.mockClear()
  bridge.linkSend.mockClear()
  bridge.linkDisconnect.mockClear()
}

describe("sanitizeTicket", () => {
  it("accepts every real-world paste shape", () => {
    expect(sanitizeTicket("endpointac5qv3krex")).toBe("endpointac5qv3krex")
    expect(sanitizeTicket("ticket=endpointac5qv3krex\n")).toBe("endpointac5qv3krex")
    expect(sanitizeTicket("  Ticket：endpointac5qv3krex")).toBe("endpointac5qv3krex")
    expect(sanitizeTicket("endpointac5qv3\nkrex")).toBe("endpointac5qv3krex")
    expect(sanitizeTicket("not-a-ticket")).toBe("not-a-ticket")
  })
})

describe("the connection slot", () => {
  beforeEach(reset)

  it("dials the sanitised ticket over the relays and says hello as the studio, in the UI's language", async () => {
    await useConnectionStore
      .getState()
      .connect({ ticket: " ticket=endpointabc\n123 ", key: " k-1 ", name: " Nyx " })
    expect(bridge.linkConnect).toHaveBeenCalledTimes(1)
    expect(bridge.linkConnect.mock.calls[0][0]).toMatchObject({ ticket: "endpointabc123", network: "n0" })
    handle({ kind: "status", connectionId: linkId(), status: "up" })
    await flush()
    expect(bridge.linkSend).toHaveBeenCalledWith(linkId(), {
      type: "hello",
      protocol: "3.0",
      key: "k-1",
      name: "Nyx",
      locale: "en",
      client: { name: CLIENT_NAME, version: STUDIO_VERSION },
      caps: [],
    })
  })

  it("passes a local network profile through to the link", async () => {
    await useConnectionStore.getState().connect({ ticket: "endpointabc", key: "k", network: "local" })
    expect(bridge.linkConnect.mock.calls[0][0].network).toBe("local")
  })

  it("stops the previous connection before dialling the next, and routes events only to the current one", async () => {
    await useConnectionStore.getState().connect({ ticket: "endpointa", key: "ka" })
    const first = useConnectionStore.getState().connection
    const firstLink = linkId()
    await useConnectionStore.getState().connect({ ticket: "endpointb", key: "kb" })
    expect(first?.getState().phase).toBe("ended")
    expect(bridge.linkDisconnect).toHaveBeenCalledWith(firstLink)
    // The old link's late events touch nothing.
    handle({ kind: "status", connectionId: firstLink, status: "up" })
    await flush()
    expect(bridge.linkSend).not.toHaveBeenCalled()
    await welcomeLatest()
    expect(useConnectionStore.getState().connection?.getState().phase).toBe("online")
  })

  it("disconnect stops the current connection and keeps it, ended, in the slot", async () => {
    await useConnectionStore.getState().connect({ ticket: "endpointa", key: "ka" })
    await welcomeLatest()
    await useConnectionStore.getState().disconnect()
    const connection = useConnectionStore.getState().connection
    expect(connection?.getState()).toMatchObject({ phase: "ended", failure: null })
    expect(bridge.linkDisconnect).toHaveBeenCalledWith(linkId())
  })

  it("outside the app shell, a dial ends at once with no_shell", async () => {
    bridge.tauri = false
    await useConnectionStore.getState().connect({ ticket: "endpointa", key: "ka" })
    await flush()
    expect(bridge.linkConnect).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().connection?.getState().failure).toMatchObject({
      kind: "link",
      code: "no_shell",
    })
  })
})

describe("remembering a hand-dialed table", () => {
  const params = { ticket: " ticket=endpointabc\n123 ", key: " k-1 ", name: " Nyx " }
  const SAVED = { ticket: "endpointabc123", key: "k-1", name: "Nyx" }

  beforeEach(reset)

  it("remembers the sanitised table once the server welcomes it, not before", async () => {
    await useConnectionStore.getState().connect(params, { remember: true })
    expect(useLastTableStore.getState().ticket).toBe("")
    handle({ kind: "status", connectionId: linkId(), status: "up" })
    await flush()
    expect(useLastTableStore.getState().ticket).toBe("")
    handle({ kind: "frame", connectionId: linkId(), frame: welcome() })
    expect(useLastTableStore.getState()).toMatchObject(SAVED)
  })

  it("does not remember a dial nobody asked to remember (the local-host path)", async () => {
    useLastTableStore.getState().remember({ ticket: "endpointold", key: "k-old", name: "" })
    await useConnectionStore.getState().connect(params)
    await welcomeLatest()
    expect(useLastTableStore.getState().ticket).toBe("endpointold")
  })

  it("does not let a later plain dial inherit an earlier remembered one", async () => {
    await useConnectionStore.getState().connect(params, { remember: true })
    const firstLink = linkId()
    await useConnectionStore.getState().connect({ ticket: "endpointlocal", key: "k-local" })
    handle({ kind: "status", connectionId: firstLink, status: "up" })
    handle({ kind: "frame", connectionId: firstLink, frame: welcome() })
    await welcomeLatest()
    expect(useLastTableStore.getState().ticket).toBe("")
  })

  it("forgets the saved table when the server rejects its key", async () => {
    useLastTableStore.getState().remember(SAVED)
    await useConnectionStore.getState().connect(params, { remember: true })
    handle({ kind: "status", connectionId: linkId(), status: "up" })
    await flush()
    handle({ kind: "frame", connectionId: linkId(), frame: fatal("bad_key") })
    expect(useLastTableStore.getState()).toMatchObject({ ticket: "", key: "", name: "" })
  })

  it("keeps the saved table when a DIFFERENT key the player typed is the one rejected", async () => {
    useLastTableStore.getState().remember({ ...SAVED, key: "k-good" })
    await useConnectionStore.getState().connect(params, { remember: true })
    handle({ kind: "status", connectionId: linkId(), status: "up" })
    await flush()
    handle({ kind: "frame", connectionId: linkId(), frame: fatal("bad_key") })
    expect(useLastTableStore.getState().key).toBe("k-good")
  })

  it("keeps the saved table through every other refusal and failure", async () => {
    useLastTableStore.getState().remember(SAVED)
    await useConnectionStore.getState().connect(params, { remember: true })
    handle({ kind: "status", connectionId: linkId(), status: "up" })
    await flush()
    handle({ kind: "frame", connectionId: linkId(), frame: fatal("protocol_mismatch") })
    await useConnectionStore.getState().connect(params, { remember: true })
    handle({ kind: "status", connectionId: linkId(), status: "closed", code: "dial_timeout" })
    expect(useLastTableStore.getState()).toMatchObject(SAVED)
  })

  it("Forget during a dial wins: the welcome does not write the table back", async () => {
    await useConnectionStore.getState().connect(params, { remember: true })
    useConnectionStore.getState().forgetLastTable()
    await welcomeLatest()
    expect(useLastTableStore.getState().ticket).toBe("")
  })
})
