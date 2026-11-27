import { beforeEach, describe, expect, it, vi } from "vitest"

const core = vi.hoisted(() => ({ invoke: vi.fn(async () => ({})) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: core.invoke }))

import { asHostFailure, hostLocalStart } from "./hostLocal"

describe("hostLocalStart", () => {
  beforeEach(() => core.invoke.mockClear())

  it("asks for a server and says nothing about how it is reached: the product path has no switch for loopback", async () => {
    await hostLocalStart({ engineRepoDir: "/engine", homeOverride: "/srv/lw", locale: "zh" })
    expect(core.invoke).toHaveBeenCalledWith("host_local_start", {
      engineRepoDir: "/engine",
      homeOverride: "/srv/lw",
      locale: "zh",
    })
  })
})

describe("asHostFailure", () => {
  it("passes a failure Rust answered with through as it is", () => {
    const refused = { code: "refused", refusal: "bad_settings", problems: [] }
    expect(asHostFailure(refused)).toBe(refused)
    expect(asHostFailure({ code: "cancelled" })).toEqual({ code: "cancelled" })
  })

  it("turns anything else into an io failure with its words", () => {
    expect(asHostFailure("command host_local_start not found")).toEqual({
      code: "io",
      detail: "command host_local_start not found",
    })
    expect(asHostFailure(new Error("boom"))).toEqual({ code: "io", detail: "boom" })
    expect(asHostFailure({ code: "made_up" })).toEqual({ code: "io", detail: "[object Object]" })
  })
})
