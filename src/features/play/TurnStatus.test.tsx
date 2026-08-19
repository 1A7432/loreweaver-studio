import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import "../../i18n"
import { useSessionStore } from "../../store/session"
import TurnStatus from "./TurnStatus"

describe("TurnStatus", () => {
  beforeEach(() => useSessionStore.getState().clear())

  it("renders nothing while idle", () => {
    const { container } = render(<TurnStatus />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders an animated spinner element (never static text alone) while busy", () => {
    useSessionStore.getState().ingest({ type: "turn_status", status: "busy", actor: "Nyx" }, 1_000)
    const { container } = render(<TurnStatus />)
    expect(screen.getByRole("status")).toHaveTextContent("Nyx")
    const spinner = container.querySelector(".spinner")
    expect(spinner).not.toBeNull()
  })

  it("names the activity and the round when the server sends them", () => {
    useSessionStore
      .getState()
      .ingest(
        { type: "turn_status", status: "busy", actor: "Nyx", activity: "dice", round: 3 } as never,
        1_000,
      )
    render(<TurnStatus />)
    expect(screen.getByRole("status")).toHaveTextContent("rolling dice · round 3")
  })

  it("says only what it was told: no round without one, nothing without an activity", () => {
    useSessionStore
      .getState()
      .ingest({ type: "turn_status", status: "busy", actor: "Nyx", activity: "cast" } as never, 1_000)
    const { rerender } = render(<TurnStatus />)
    expect(screen.getByRole("status")).toHaveTextContent("voicing the cast")
    expect(screen.getByRole("status").textContent).not.toContain("round")

    // An unknown activity or a bogus round is no hint at all — the 2.3.0 line.
    useSessionStore
      .getState()
      .ingest(
        { type: "turn_status", status: "busy", actor: "Nyx", activity: "vibing", round: 0 } as never,
        1_000,
      )
    rerender(<TurnStatus />)
    expect(screen.getByRole("status").textContent).toBe("Resolving Nyx's action…")
  })

  it("clears when the idle frame arrives", () => {
    useSessionStore.getState().ingest({ type: "turn_status", status: "busy", actor: "Nyx" }, 1_000)
    const { container, rerender } = render(<TurnStatus />)
    useSessionStore.getState().ingest({ type: "turn_status", status: "idle" })
    rerender(<TurnStatus />)
    expect(container).toBeEmptyDOMElement()
  })
})
