// The Keeper's activity, from the `turn` signal the session holds; the badge of the two
// ends' versions; the out-of-band notices. Frames are protocol.md §9's examples.
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import "../../i18n"
import NoticeLines, { MAX_NOTICES } from "./NoticeLines"
import { TestRoom } from "./room.testkit"
import TurnStatus from "./TurnStatus"
import VersionBadge from "./VersionBadge"

const BUSY = { type: "signal", kind: "turn", data: { status: "busy", actor: "Ada" } }
const IDLE = { type: "signal", kind: "turn", data: { status: "idle" } }
// protocol.md §9.3.
const NOTICE = {
  type: "signal",
  kind: "notice",
  data: {
    level: "warn",
    code: "provider_transient",
    text: "The AI provider is still temporarily unavailable after retrying. Please try again shortly.",
  },
}

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
})

async function open(patch = {}) {
  room = new TestRoom()
  await room.welcome("player", patch)
  return room
}

describe("TurnStatus", () => {
  it("renders nothing until a turn is busy, an animated spinner while it is, nothing once idle", async () => {
    const r = await open()
    const { container } = render(<TurnStatus />)
    expect(container).toBeEmptyDOMElement()
    await r.feed(BUSY)
    expect(screen.getByRole("status")).toHaveTextContent("Resolving Ada's action…")
    expect(container.querySelector(".spinner")).not.toBeNull()
    await r.feed(IDLE)
    expect(container).toBeEmptyDOMElement()
  })

  it("names the optional activity and round when a server sends them", async () => {
    const r = await open()
    render(<TurnStatus />)
    await r.feed({ ...BUSY, data: { status: "busy", actor: "Ada", activity: "dice", round: 3 } })
    expect(screen.getByRole("status")).toHaveTextContent("rolling dice · round 3")
  })

  it("forgets a busy turn when the link drops", async () => {
    const r = await open()
    const { container } = render(<TurnStatus />)
    await r.feed(BUSY)
    await r.drop()
    expect(container).toBeEmptyDOMElement()
  })
})

describe("VersionBadge", () => {
  it("shows nothing before a welcome", () => {
    room = new TestRoom()
    const { container } = render(<VersionBadge />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names both ends, and stays quiet while both speak the same protocol", async () => {
    await open()
    const { container } = render(<VersionBadge />)
    expect(screen.getByText(/server 3\.0\.0-alpha\.0 · studio/)).toBeInTheDocument()
    expect(container.querySelector(".has-drift")).toBeNull()
  })

  it("flags a MINOR protocol drift softly — the connection still plays", async () => {
    await open({ protocol: "3.1" })
    const { container } = render(<VersionBadge />)
    expect(container.querySelector(".version-badge")).toHaveClass("has-drift")
    expect(container.querySelector(".version-badge")).toHaveAttribute("title", expect.stringContaining("3.1"))
  })

  it("says so when the server does not report its version", async () => {
    await open({ server: { name: "loreweaver", version: "" } })
    render(<VersionBadge />)
    expect(screen.getByText(/\(unreported\)/)).toBeInTheDocument()
  })
})

describe("NoticeLines", () => {
  it("shows a notice the session does not keep, and dismisses it", async () => {
    const r = await open()
    const user = userEvent.setup()
    const { container } = render(<NoticeLines />)
    await r.feed(NOTICE)
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument()
    expect(container.querySelector(".level-warn")).not.toBeNull()
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull()
  })

  it("keeps only the newest few", async () => {
    const r = await open()
    render(<NoticeLines />)
    const notices = Array.from({ length: MAX_NOTICES + 2 }, (_, index) => ({
      type: "signal",
      kind: "notice",
      data: { level: "info", text: `Notice ${index}` },
    }))
    await r.feed(...notices)
    expect(screen.queryByText("Notice 0")).toBeNull()
    expect(screen.queryByText("Notice 1")).toBeNull()
    expect(screen.getByText(`Notice ${MAX_NOTICES + 1}`)).toBeInTheDocument()
  })

  it("animates a notice about a long operation until the turn goes idle", async () => {
    const r = await open()
    const { container } = render(<NoticeLines />)
    await r.feed({
      type: "signal",
      kind: "notice",
      data: { level: "info", text: "Installing…", spinner: true },
    })
    expect(container.querySelector(".spinner")).not.toBeNull()
    await r.feed(IDLE)
    expect(screen.queryByText("Installing…")).toBeNull()
  })
})
