import { beforeEach, describe, expect, it, vi } from "vitest"

const MANIFEST = `
manifest_version: 2
id: corridor-apartment
version: 1.0.0
contents:
  cards:
    - path: cards/keeper.lorecard.json
      kind: world
    - path: cards/hana.json
      kind: character
  lorebooks:
    - lorebooks/rain.json
`

const native = vi.hoisted(() => ({
  runEngineCli: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", timedOut: false })),
  readFileByPath: vi.fn(async () => ({
    name: "pack.yaml",
    bytes: new TextEncoder().encode(MANIFEST),
    path: "/x",
  })),
}))
const hostBridge = vi.hoisted(() => ({
  hostLocalStatus: vi.fn(async () => ({
    running: false,
    home: "/tmp/.loreweaver",
    dataDir: "/tmp/.loreweaver/data",
    hostId: null,
  })),
}))
const transport = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  // Typed parameter (unused, hence the void) so `mock.calls` keeps the frame.
  transportSend: vi.fn(async (frame: { type: string; text?: string }) => void frame),
}))

vi.mock("../lib/native", () => native)
vi.mock("../lib/hostLocal", () => ({
  ...hostBridge,
  HOST_LOCAL_EVENT: "loreweaver://host-local",
  hostLocalStart: vi.fn(async () => {}),
  hostLocalStop: vi.fn(async () => true),
  onHostLocalEvent: vi.fn(async () => () => {}),
  mintHostId: () => "test-host",
  hostEventApplies: () => true,
}))
vi.mock("../lib/transport", () => ({ ...transport, TRANSPORT_EVENT: "loreweaver://transport" }))

import { useAppStore } from "./app"
import { useConnectionStore } from "./connection"
import { useHostLocalStore } from "./hostLocal"
import { useTestDriveStore } from "./testDrive"

const CANDIDATE = { kind: "python-module" as const, program: "python", args: ["-m", "app"], cwd: "/repo" }
const REQUEST = {
  candidate: CANDIDATE,
  packPath: "/out/corridor-apartment-1.0.0.lwpack",
  packId: "corridor-apartment",
  packVersion: "1.0.0",
  carriesSkillsOrRulepacks: false,
}

const WELCOME = {
  type: "welcome" as const,
  protocol: "2.1",
  room: "table",
  you: { id: "u1", name: "keeper", role: "keeper" as const },
  locale: "en",
  server: "loreweaver/1",
}

/** The local server is up and joined — the state `hostLocal` reaches on ready. */
function serving(role: "keeper" | "player" = "keeper") {
  useHostLocalStore.setState({ phase: "ready" })
  useConnectionStore.setState({
    status: "online",
    welcome: { ...WELCOME, you: { ...WELCOME.you, role } },
  })
}

describe("test-drive store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTestDriveStore.getState().reset()
    useHostLocalStore.setState({ phase: "idle", error: null, homeOverride: "" })
    useConnectionStore.setState({ status: "offline", welcome: null, lastError: null })
    useAppStore.setState({ mode: "studio" })
  })

  it("installs into the LOCAL SERVER's data dir, not the studio's own", async () => {
    // The whole reason this store re-runs the install: `--install` lands under
    // `settings.data_dir`, and the one-click server has its own. Without the
    // overlay the pack installs where nothing will look for it.
    serving()
    await useTestDriveStore.getState().run(REQUEST)
    expect(native.runEngineCli).toHaveBeenCalledWith(CANDIDATE, ["--install", REQUEST.packPath, "--yes"], {
      TRPG_DATA_DIR: "/tmp/.loreweaver/data",
    })
    expect(useTestDriveStore.getState().dataDir).toBe("/tmp/.loreweaver/data")
  })

  it("issues the manifest's world import and lorebook import, then opens Play", async () => {
    serving()
    await useTestDriveStore.getState().run(REQUEST)

    const sent = transport.transportSend.mock.calls.map((call) => call[0])
    expect(sent).toEqual([
      { type: "input", text: ".import corridor-apartment/cards/keeper.lorecard.json world" },
      { type: "input", text: ".lore import corridor-apartment/lorebooks/rain.json" },
    ])
    const state = useTestDriveStore.getState()
    expect(state.phase).toBe("ready")
    expect(state.sent).toBe(2)
    expect(useAppStore.getState().mode).toBe("play")
  })

  it("reads the manifest the install wrote, not the studio's session", async () => {
    serving()
    await useTestDriveStore.getState().run(REQUEST)
    expect(native.readFileByPath).toHaveBeenCalledWith(
      "/tmp/.loreweaver/data/packs/corridor-apartment@1.0.0/pack.yaml",
    )
  })

  it("stops at the engine's own message when the install fails", async () => {
    native.runEngineCli.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "pack requires protocol >= 9.0",
      timedOut: false,
    })
    serving()
    await useTestDriveStore.getState().run(REQUEST)
    const state = useTestDriveStore.getState()
    expect(state.phase).toBe("error")
    expect(state.error).toContain("protocol >= 9.0")
    expect(transport.transportSend).not.toHaveBeenCalled()
  })

  it("refuses to import as a player — a world import is keeper-only", async () => {
    serving("player")
    await useTestDriveStore.getState().run(REQUEST)
    expect(useTestDriveStore.getState().error).toBe("testDrive.err.notKeeper")
    expect(transport.transportSend).not.toHaveBeenCalled()
  })

  it("says so when the pack has nothing a keeper could import", async () => {
    native.readFileByPath.mockResolvedValueOnce({
      name: "pack.yaml",
      bytes: new TextEncoder().encode("id: corridor-apartment\ncontents:\n  cards: []\n"),
      path: "/x",
    })
    serving()
    await useTestDriveStore.getState().run(REQUEST)
    expect(useTestDriveStore.getState().error).toBe("testDrive.err.nothing-importable")
  })

  it("reports an unreadable manifest instead of importing nothing silently", async () => {
    native.readFileByPath.mockRejectedValueOnce(new Error("ENOENT"))
    serving()
    await useTestDriveStore.getState().run(REQUEST)
    expect(useTestDriveStore.getState().error).toBe("testDrive.err.noManifest")
  })
})

describe("test-drive: the dev-room mode", () => {
  const MOUNT = { ...REQUEST, mode: "mount-source" as const, sourceDir: "/Users/nyx/packs/corridor" }

  beforeEach(() => {
    vi.clearAllMocks()
    useTestDriveStore.getState().reset()
    useHostLocalStore.setState({ phase: "idle", error: null, homeOverride: "", devSourceRoot: "" })
    useConnectionStore.setState({ status: "offline", welcome: null, lastError: null })
    useAppStore.setState({ mode: "studio" })
  })

  it("starts the server with the tree's PARENT as the dev root, then mounts", async () => {
    // The engine confines every mount under TRPG_DEV__SOURCE_ROOT, and the
    // author's next mount is a sibling — so the root is the packs directory.
    const start = vi.fn(async (root?: string) => {
      useHostLocalStore.setState({ phase: "ready", devSourceRoot: root ?? "" })
      useConnectionStore.setState({ status: "online", welcome: WELCOME })
    })
    useHostLocalStore.setState({ start })

    await useTestDriveStore.getState().run(MOUNT)
    expect(start).toHaveBeenCalledWith("/Users/nyx/packs")
    expect(transport.transportSend.mock.calls.map((call) => call[0])).toEqual([
      { type: "input", text: ".dev mount /Users/nyx/packs/corridor" },
    ])
    expect(useTestDriveStore.getState().phase).toBe("ready")
    expect(useAppStore.getState().mode).toBe("play")
  })

  it("builds and installs nothing — that is the whole point of the mode", async () => {
    useHostLocalStore.setState({
      start: vi.fn(async () => {}),
      phase: "ready",
      devSourceRoot: "/Users/nyx/packs",
    })
    useConnectionStore.setState({ status: "online", welcome: WELCOME })
    await useTestDriveStore.getState().run(MOUNT)
    expect(native.runEngineCli).not.toHaveBeenCalled()
    expect(native.readFileByPath).not.toHaveBeenCalled()
  })

  it("restarts a server that is running under a different dev root", async () => {
    // `TRPG_DEV__SOURCE_ROOT` is read at startup; reconfiguring is not a thing.
    const stop = vi.fn(async () => {})
    const start = vi.fn(async (root?: string) => {
      useHostLocalStore.setState({ phase: "ready", devSourceRoot: root ?? "" })
    })
    useHostLocalStore.setState({ phase: "ready", devSourceRoot: "/somewhere/else", start, stop })
    useConnectionStore.setState({ status: "online", welcome: WELCOME })

    await useTestDriveStore.getState().run(MOUNT)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith("/Users/nyx/packs")
  })

  it("says so when there is no source tree to mount", async () => {
    await useTestDriveStore.getState().run({ ...MOUNT, sourceDir: "" })
    expect(useTestDriveStore.getState().error).toBe("testDrive.err.no-source-dir")
  })
})
