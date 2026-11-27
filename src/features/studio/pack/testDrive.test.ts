import { describe, expect, it } from "vitest"
import BUILD_OK from "./fixtures/build-ok.json"
import { parseTrust } from "./buildResult"
import { nextSteps } from "./testDrive"

describe("nextSteps", () => {
  it("says the commands a room admin and the players type, from the engine's trust card", () => {
    const trust = parseTrust(BUILD_OK.trust)!
    expect(nextSteps(trust)).toEqual({
      admin: [
        ".pack enable corridor-apartment",
        ".rule system corridor-rules",
        ".skill enable corridor-procedures",
        ".import world corridor-apartment cards/corridor-apartment.lorecard.json",
        ".import world corridor-apartment cards/administrator.st.json",
      ],
      players: [
        ".import character corridor-apartment cards/lin-wan.st.json",
        ".import character corridor-apartment cards/lin-wan.png",
      ],
    })
  })

  it("asks for no more than enabling a pack that ships nothing to import", () => {
    const trust = { ...parseTrust(BUILD_OK.trust)!, ruleSystems: [], skills: [], cards: [] }
    expect(nextSteps(trust)).toEqual({ admin: [".pack enable corridor-apartment"], players: [] })
  })
})
