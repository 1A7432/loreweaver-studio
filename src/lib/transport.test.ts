import { describe, expect, it } from "vitest"
import { createConnectionId } from "./transport"

describe("createConnectionId", () => {
  it("mints a unique id per explicit connect", () => {
    const a = createConnectionId()
    const b = createConnectionId()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
  })
})
