import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import "../../i18n"
import { useSessionStore } from "../../store/session"
import StatePanel from "./StatePanel"

describe("StatePanel", () => {
  beforeEach(() => useSessionStore.getState().clear())

  it("renders character meters, party, scene, initiative, and presence", () => {
    useSessionStore.getState().ingest({
      type: "state",
      character: {
        name: "Ash",
        system: "coc7",
        hp: 9,
        hpmax: 12,
        mp: 3,
        mpmax: 8,
        san: 44,
        sanmax: 60,
        attributes: {},
        status_effects: ["bleeding"],
      },
      party: [
        { name: "Ash", online: true, active: true },
        { name: "Bo", online: false, active: false, ai: true, hp: 5, hpMax: 10 },
      ],
      scene: { name: "Old Pier", focus: "fog" },
      clock: { time: "23:40", round: 2 },
      initiative: [
        { name: "Ash", value: 8, current: true },
        { name: "Bo", value: 5, current: false },
      ],
      online: 2,
    })
    useSessionStore.getState().ingest({
      type: "presence",
      players: [{ id: "u1", name: "Nyx", online: true }],
      online: 1,
    })

    const { container } = render(<StatePanel />)
    expect(screen.getByText("Ash", { selector: ".desk-title" })).toBeInTheDocument()
    expect(screen.getByText("9/12")).toBeInTheDocument()
    expect(screen.getByText("44/60")).toBeInTheDocument()
    expect(screen.getByText("bleeding")).toBeInTheDocument()
    expect(screen.getByText("AI")).toBeInTheDocument()
    expect(screen.getByText("5/10")).toBeInTheDocument()
    expect(screen.getByText(/Old Pier/)).toBeInTheDocument()
    expect(screen.getByText(/23:40/)).toBeInTheDocument()
    expect(screen.getByText("Nyx")).toBeInTheDocument()
    expect(container.querySelector(".initiative-list .is-current")).toHaveTextContent("Ash")
    const bo = screen.getByText("Bo", { selector: ".party-name" }).closest(".party-row")
    expect(bo).toHaveClass("is-offline")
  })

  it("renders nothing without state or presence", () => {
    const { container } = render(<StatePanel />)
    expect(container.querySelectorAll(".desk-card")).toHaveLength(0)
  })
})
