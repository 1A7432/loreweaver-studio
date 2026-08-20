import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import type { ServerFrame } from "@loreweaver/protocol"
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
      .ingest({ type: "turn_status", status: "busy", actor: "Nyx", activity: "dice", round: 3 }, 1_000)
    render(<TurnStatus />)
    expect(screen.getByRole("status")).toHaveTextContent("rolling dice · round 3")
  })

  it("says only what it was told: no round without one, nothing without an activity", () => {
    useSessionStore
      .getState()
      .ingest({ type: "turn_status", status: "busy", actor: "Nyx", activity: "cast" }, 1_000)
    const { rerender } = render(<TurnStatus />)
    expect(screen.getByRole("status")).toHaveTextContent("voicing the cast")
    expect(screen.getByRole("status").textContent).not.toContain("round")

    // A word this build has no label for — what a LATER protocol would send —
    // and a bogus round are no hint at all: the line falls back to the 2.3.0
    // one rather than printing a raw translation key. The cast is the point of
    // the case: 2.3.1's types deliberately cannot express either value.
    const fromTheFuture = {
      type: "turn_status",
      status: "busy",
      actor: "Nyx",
      activity: "planning",
      round: 0,
    } as unknown as ServerFrame
    useSessionStore.getState().ingest(fromTheFuture, 1_000)
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
