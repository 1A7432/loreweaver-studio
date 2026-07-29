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

  it("clears when the idle frame arrives", () => {
    useSessionStore.getState().ingest({ type: "turn_status", status: "busy", actor: "Nyx" }, 1_000)
    const { container, rerender } = render(<TurnStatus />)
    useSessionStore.getState().ingest({ type: "turn_status", status: "idle" })
    rerender(<TurnStatus />)
    expect(container).toBeEmptyDOMElement()
  })
})
