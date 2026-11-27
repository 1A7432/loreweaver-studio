import { beforeEach, describe, expect, it, vi } from "vitest"

const install = vi.hoisted(() => ({ verifyPackInstall: vi.fn() }))
const transport = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }))
vi.mock("../lib/packInstall", () => install)
vi.mock("../lib/transport", () => transport)

import { isTestDriveErrorKey, useTestDriveStore } from "./testDrive"

const CANDIDATE = {
  kind: "binary" as const,
  program: "loreweaver",
  args: [],
  cwd: null,
  version: "3.0.0",
  problem: null,
}
const REQUEST = { candidate: CANDIDATE, packPath: "/out/pack.lwpack" }
const run = { code: 0, stdout: "", stderr: "", timedOut: false }

describe("useTestDriveStore", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transport.isTauri.mockReturnValue(true)
    useTestDriveStore.getState().reset()
  })

  it("verifies with the real installer and lands on verified", async () => {
    install.verifyPackInstall.mockResolvedValueOnce({
      install: { ok: true, result: { installed: true } },
      installRun: run,
      listed: [],
      listRun: run,
    })
    await useTestDriveStore.getState().run(REQUEST)
    expect(install.verifyPackInstall).toHaveBeenCalledWith(CANDIDATE, "/out/pack.lwpack")
    expect(useTestDriveStore.getState().phase).toBe("verified")
  })

  it("lands on refused when the installer refuses", async () => {
    install.verifyPackInstall.mockResolvedValueOnce({
      install: { ok: false, refusal: { code: "invalid_pack", problems: [] } },
      installRun: { ...run, code: 1 },
      listed: null,
      listRun: null,
    })
    await useTestDriveStore.getState().run(REQUEST)
    expect(useTestDriveStore.getState().phase).toBe("refused")
  })

  it("shows the engine's own words when it printed no JSON", async () => {
    install.verifyPackInstall.mockResolvedValueOnce({
      install: null,
      installRun: { ...run, code: 2, stderr: "error: unknown command\n" },
      listed: null,
      listRun: null,
    })
    await useTestDriveStore.getState().run(REQUEST)
    const state = useTestDriveStore.getState()
    expect(state.phase).toBe("error")
    expect(state.error).toBe("error: unknown command")
    expect(isTestDriveErrorKey(state.error!)).toBe(false)
  })

  it("needs the desktop app", async () => {
    transport.isTauri.mockReturnValue(false)
    await useTestDriveStore.getState().run(REQUEST)
    expect(useTestDriveStore.getState().error).toBe("testDrive.err.desktopOnly")
    expect(install.verifyPackInstall).not.toHaveBeenCalled()
  })
})
