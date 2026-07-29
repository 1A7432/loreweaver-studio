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

describe("StatePanel — module variables (v1.6)", () => {
  beforeEach(() => useSessionStore.getState().clear())

  it("renders each variable kind as its widget", () => {
    useSessionStore.getState().ingest({
      type: "state",
      party: [],
      initiative: [],
      online: 1,
      variables: [
        { id: "suspicion", label: "Suspicion", kind: "number", value: 7, min: 0, max: 10 },
        { id: "doom", label: "Doom", kind: "number", value: 42 },
        { id: "alerted", label: "Alerted", kind: "bool", value: true },
        { id: "calm", label: "Calm", kind: "bool", value: false },
        { id: "phase", label: "Phase", kind: "enum", value: "night" },
        { id: "motto", label: "Motto", kind: "text", value: "trust no one" },
      ],
    })
    const { container } = render(<StatePanel />)
    expect(screen.getByText("7/10")).toBeInTheDocument()
    expect(screen.getByText("42")).toBeInTheDocument()
    expect(container.querySelector('[data-kind="bool"] .chip-on')).not.toBeNull()
    expect(container.querySelectorAll('[data-kind="bool"] .chip-off')).toHaveLength(1)
    expect(screen.getByText("night")).toBeInTheDocument()
    expect(screen.getByText("trust no one")).toBeInTheDocument()
  })

  it("renders hook-emitted sidebar ui panels", () => {
    useSessionStore.getState().ingest({
      type: "ui",
      panel: "sidebar",
      id: "hud",
      blocks: [{ kind: "badge", label: "omen", tone: "warn" }],
    })
    render(<StatePanel />)
    expect(screen.getByText("omen")).toHaveClass("badge-warn")
  })
})
