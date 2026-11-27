import { describe, expect, it } from "vitest"
import { asHostFailure } from "./hostLocal"

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
