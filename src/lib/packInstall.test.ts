import { beforeEach, describe, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({
  runEngineCli: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", timedOut: false })),
  formatCliCommand: (candidate: { program: string; args: string[] } | null, args: string[]): string =>
    [candidate?.program ?? "python", ...(candidate?.args ?? []), ...args].join(" "),
}))
const host = vi.hoisted(() => ({
  hostLocalStatus: vi.fn(async (homeOverride?: string) => ({
    running: false,
    home: homeOverride ?? "/Users/nyx/.loreweaver",
    dataDir: `${homeOverride ?? "/Users/nyx/.loreweaver"}/data`,
    hostId: null,
  })),
}))

vi.mock("./native", () => native)
vi.mock("./hostLocal", () => ({ ...host, HOST_LOCAL_EVENT: "loreweaver://host-local" }))

import { formatInstallCommand, installDataDir, installPack } from "./packInstall"

const CANDIDATE = { kind: "python-module" as const, program: "python", args: ["-m", "app"], cwd: "/repo" }

describe("installPack", () => {
  beforeEach(() => vi.clearAllMocks())

  it("always targets the LOCAL SERVER's data dir", () => {
    // The one thing this module exists for: the engine installs under
    // settings.data_dir, the local server has its own, and an install that
    // lands anywhere else is a pack the app will never serve.
    return installPack(CANDIDATE, "/out/deep-pier-1.0.0.lwpack").then((install) => {
      expect(native.runEngineCli).toHaveBeenCalledWith(
        CANDIDATE,
        ["--install", "/out/deep-pier-1.0.0.lwpack", "--yes"],
        { TRPG_DATA_DIR: "/Users/nyx/.loreweaver/data" },
      )
      expect(install.dataDir).toBe("/Users/nyx/.loreweaver/data")
    })
  })

  it("follows the author's own server-folder override", async () => {
    await installPack(CANDIDATE, "/out/x.lwpack", "  /Volumes/Table/lw  ")
    expect(host.hostLocalStatus).toHaveBeenCalledWith("/Volumes/Table/lw")
    expect(native.runEngineCli).toHaveBeenCalledWith(CANDIDATE, expect.anything(), {
      TRPG_DATA_DIR: "/Volumes/Table/lw/data",
    })
  })

  it("reads a blank override as no override at all", async () => {
    await installDataDir("   ")
    expect(host.hostLocalStatus).toHaveBeenCalledWith(undefined)
  })

  it("hands back the engine's own result untouched", async () => {
    native.runEngineCli.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "pack requires protocol >= 9.0",
      timedOut: false,
    })
    const install = await installPack(CANDIDATE, "/out/x.lwpack")
    expect(install.result.code).toBe(1)
    expect(install.result.stderr).toContain("protocol >= 9.0")
  })
})

describe("formatInstallCommand", () => {
  it("carries the same override, so a pasted line does what the button did", () => {
    expect(formatInstallCommand(CANDIDATE, "/out/x.lwpack", "/Users/nyx/.loreweaver/data")).toBe(
      "TRPG_DATA_DIR=/Users/nyx/.loreweaver/data python -m app --install /out/x.lwpack --yes",
    )
  })

  it("omits the override when the data dir is not known yet", () => {
    expect(formatInstallCommand(CANDIDATE, "/out/x.lwpack", "")).toBe(
      "python -m app --install /out/x.lwpack --yes",
    )
  })
})
