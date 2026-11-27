import { beforeEach, describe, expect, it, vi } from "vitest"
import BUILD_OK from "../features/studio/pack/fixtures/build-ok.json"

const INSTALLED = JSON.stringify({
  ok: true,
  installed: true,
  id: "corridor-apartment",
  version: "1.0.0",
  sha256: BUILD_OK.sha256,
  trust: BUILD_OK.trust,
  shadowed: { ruleSystems: [], skills: [] },
  replaced: null,
})
const LISTED = JSON.stringify({
  ok: true,
  packs: [{ id: "corridor-apartment", version: "1.0.0", name: {}, sha256: BUILD_OK.sha256, installedAt: 1 }],
})

const native = vi.hoisted(() => ({
  runEngineCli: vi.fn(),
  makeScratchDir: vi.fn(async () => "/tmp/lw-studio-verify-1-2"),
  removeScratchDir: vi.fn(async () => {}),
  formatCliCommand: (candidate: { program: string; args: string[] } | null, args: string[]): string =>
    [candidate?.program ?? "loreweaver", ...(candidate?.args ?? []), ...args].join(" "),
}))
vi.mock("./native", () => native)

import { formatInstallCommand, verifyPackInstall } from "./packInstall"

const CANDIDATE = {
  kind: "checkout" as const,
  program: "bun",
  args: ["/engine/server/src/cli/main.ts"],
  cwd: "/tmp",
  version: "3.0.0",
  problem: null,
}
const run = (stdout: string, code = 0, stderr = "") => ({ code, stdout, stderr, timedOut: false })

describe("verifyPackInstall", () => {
  beforeEach(() => vi.clearAllMocks())

  it("installs into a fresh scratch data directory, lists it, and removes the directory", async () => {
    native.runEngineCli.mockResolvedValueOnce(run(INSTALLED)).mockResolvedValueOnce(run(LISTED))
    const verification = await verifyPackInstall(CANDIDATE, "/out/pack.lwpack")
    expect(native.runEngineCli).toHaveBeenNthCalledWith(
      1,
      CANDIDATE,
      ["install", "/out/pack.lwpack", "--yes"],
      {
        TRPG_DATA_DIR: "/tmp/lw-studio-verify-1-2",
      },
    )
    expect(native.runEngineCli).toHaveBeenNthCalledWith(2, CANDIDATE, ["packs"], {
      TRPG_DATA_DIR: "/tmp/lw-studio-verify-1-2",
    })
    expect(verification.install?.ok).toBe(true)
    expect(verification.listed?.map((pack) => pack.id)).toEqual(["corridor-apartment"])
    expect(native.removeScratchDir).toHaveBeenCalledWith("/tmp/lw-studio-verify-1-2")
  })

  it("reports a refusal from stderr and lists nothing, still removing the directory", async () => {
    native.runEngineCli.mockResolvedValueOnce(
      run("", 1, '{"ok":false,"code":"engine_too_old","detail":"protocol 3.1"}'),
    )
    const verification = await verifyPackInstall(CANDIDATE, "/out/pack.lwpack")
    expect(verification.install).toEqual({
      ok: false,
      refusal: { code: "engine_too_old", detail: "protocol 3.1", problems: [] },
    })
    expect(verification.listed).toBeNull()
    expect(native.runEngineCli).toHaveBeenCalledTimes(1)
    expect(native.removeScratchDir).toHaveBeenCalled()
  })

  it("removes the directory even when the engine cannot be spawned", async () => {
    native.runEngineCli.mockRejectedValueOnce(new Error("spawning bun failed"))
    await expect(verifyPackInstall(CANDIDATE, "/out/pack.lwpack")).rejects.toThrow("spawning bun failed")
    expect(native.removeScratchDir).toHaveBeenCalled()
  })
})

describe("formatInstallCommand", () => {
  it("is the operator's own install line, never Studio's scratch directory", () => {
    expect(formatInstallCommand(null, "/out/pack.lwpack")).toBe("loreweaver install /out/pack.lwpack --yes")
    expect(formatInstallCommand(CANDIDATE, "/out/pack.lwpack")).toBe(
      "bun /engine/server/src/cli/main.ts install /out/pack.lwpack --yes",
    )
  })
})
