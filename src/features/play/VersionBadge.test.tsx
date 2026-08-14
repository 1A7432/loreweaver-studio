import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { PROTOCOL_VERSION } from "@loreweaver/protocol"
import "../../i18n"
import { useConnectionStore } from "../../store/connection"
import { STUDIO_VERSION } from "../../version"
import VersionBadge from "./VersionBadge"

const WELCOME = {
  type: "welcome" as const,
  protocol: PROTOCOL_VERSION,
  room: "table",
  you: { id: "u1", name: "Nyx", role: "player" as const },
  locale: "en",
  server: "loreweaver/1",
  version: "2.1.dev141+ge03d66c",
}

describe("VersionBadge", () => {
  beforeEach(() => useConnectionStore.setState({ welcome: null }))

  it("shows nothing before a welcome arrives", () => {
    const { container } = render(<VersionBadge />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names both ends", () => {
    useConnectionStore.setState({ welcome: WELCOME })
    render(<VersionBadge />)
    expect(screen.getByText(/2\.1\.dev141/)).toBeInTheDocument()
    expect(screen.getByText(new RegExp(STUDIO_VERSION.replace(/\./g, "\\.")))).toBeInTheDocument()
  })

  it("says so when the server does not report its version", () => {
    useConnectionStore.setState({ welcome: { ...WELCOME, version: undefined } })
    render(<VersionBadge />)
    expect(screen.getByText(/\(unreported\)/)).toBeInTheDocument()
  })

  it("stays quiet while both ends speak the same protocol", () => {
    useConnectionStore.setState({ welcome: WELCOME })
    const { container } = render(<VersionBadge />)
    expect(container.querySelector(".version-badge")).not.toHaveClass("has-drift")
  })

  it("flags a MINOR protocol drift softly — the connection still plays", () => {
    // The store refuses a different MAJOR outright; a different minor is real
    // drift (one side knows frames the other does not) but not a failure.
    const major = PROTOCOL_VERSION.split(".")[0]
    useConnectionStore.setState({ welcome: { ...WELCOME, protocol: `${major}.999` } })
    const { container } = render(<VersionBadge />)
    const badge = container.querySelector(".version-badge")
    expect(badge).toHaveClass("has-drift")
    expect(badge?.getAttribute("title")).toContain(`${major}.999`)
    expect(badge?.getAttribute("title")).toContain(PROTOCOL_VERSION)
  })

  it("compares protocols, not the two products' own versions", () => {
    // The studio is 0.1.0 and the engine is 2.1.x — comparing those would flag
    // every healthy connection there has ever been.
    useConnectionStore.setState({ welcome: { ...WELCOME, version: "99.0.0" } })
    const { container } = render(<VersionBadge />)
    expect(container.querySelector(".version-badge")).not.toHaveClass("has-drift")
  })
})
