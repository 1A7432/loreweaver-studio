import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const sent: unknown[] = []
vi.mock("../../lib/transport", () => ({
  TRANSPORT_EVENT: "loreweaver://transport",
  isTauri: () => true,
  transportSend: async (frame: unknown) => {
    sent.push(frame)
  },
}))

import "../../i18n"
import { useConnectionStore } from "../../store/connection"
import { useSessionStore } from "../../store/session"
import StatePanel, { PACK_CARDS_REPLY_TIMEOUT_MS } from "./StatePanel"

describe("StatePanel", () => {
  beforeEach(() => useSessionStore.getState().clear())

  it("renders character meters, party, scene, initiative, and presence", () => {
    useSessionStore.getState().ingest({
      type: "state",
      character: {
        name: "Ash",
        system: "coc7",
        resources: [
          { id: "hp", label: "HP", value: 9, max: 12 },
          { id: "mp", label: "MP", value: 3, max: 8 },
          { id: "san", label: "SAN", value: 44, max: 60 },
        ],
        attributes: {},
        status_effects: ["bleeding"],
      },
      party: [
        { name: "Ash", online: true, active: true },
        {
          name: "Bo",
          online: false,
          active: false,
          ai: true,
          resources: [{ id: "hp", label: "HP", value: 5, max: 10 }],
        },
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
    expect(screen.getByText(/5\/10/)).toBeInTheDocument()
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

  it("dims and locks keeper-view hidden variables (v1.7 additive hidden:true)", () => {
    useSessionStore.getState().ingest({
      type: "state",
      party: [],
      initiative: [],
      online: 1,
      variables: [
        { id: "public", label: "Public", kind: "number", value: 1 },
        { id: "plot", label: "Plot flag", kind: "bool", value: true, hidden: true },
      ],
    })
    const { container } = render(<StatePanel />)
    const hiddenRow = container.querySelector(".var-hidden-row")
    expect(hiddenRow).not.toBeNull()
    expect(hiddenRow?.textContent).toContain("Plot flag")
    expect(container.querySelectorAll(".var-hidden-row")).toHaveLength(1)
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

describe("PregenCard", () => {
  beforeEach(() => {
    sent.length = 0
    useSessionStore.getState().clear()
  })

  const BASE = {
    type: "state" as const,
    party: [],
    initiative: [],
    online: 1,
  }

  beforeEach(() => {
    useConnectionStore.setState({
      status: "online",
      welcome: {
        type: "welcome",
        protocol: "2.1",
        room: "table",
        you: { id: "u1", name: "Nyx", role: "player" },
        locale: "en",
        server: "loreweaver/1",
      },
    })
  })

  it("renders the module's cast and offers an unclaimed one", async () => {
    useSessionStore.setState({
      game: {
        ...BASE,
        pregens: [
          { name: "林晚", claimed_by: "" },
          { name: "陈九鲤", claimed_by: "Ash" },
          { name: "白榆生", claimed_by: "Nyx" },
        ],
      },
    })
    render(<StatePanel />)

    expect(screen.getByText("林晚")).toBeInTheDocument()
    expect(screen.getByText("claimed by Ash")).toBeInTheDocument()
    // Your own claim reads as yours, not as somebody else's name.
    expect(screen.getByText("yours")).toBeInTheDocument()

    // Claiming is a PLAYER action and goes down the ordinary command path.
    await userEvent.click(screen.getByRole("button", { name: "Claim" }))
    expect(sent).toContainEqual({ type: "input", text: ".pc claim 林晚" })
  })

  it("shows nothing when the module ships no cast", () => {
    useSessionStore.setState({ game: { ...BASE, pregens: [] } })
    render(<StatePanel />)
    expect(screen.queryByText("Pre-generated cast")).not.toBeInTheDocument()
  })
})

describe("PackImportCard (v2.2)", () => {
  beforeEach(() => {
    sent.length = 0
    useSessionStore.getState().clear()
    useConnectionStore.setState({
      status: "online",
      welcome: {
        type: "welcome",
        protocol: "2.1",
        room: "table",
        you: { id: "u1", name: "Nyx", role: "player" },
        locale: "en",
        server: "loreweaver/1",
      },
    })
  })

  it("requests the card list on open, renders entries, and imports through the chat lane", async () => {
    render(<StatePanel />)

    // Opening the picker is what asks the server — no request before that.
    expect(sent).toEqual([])
    await userEvent.click(screen.getByRole("button", { name: "Browse" }))
    expect(sent).toEqual([{ type: "list_pack_cards" }])
    expect(screen.getByText("Fetching the card list…")).toBeInTheDocument()

    // The unicast reply lands in the store; drive it directly (the installed
    // 2.1.x package validator would drop the frame on a real connection).
    act(() => {
      useSessionStore.getState().ingest({
        type: "pack_cards",
        cards: [
          { ref: "midnight-pier/cards/lin_wan.png", pack: "midnight-pier", name: "lin_wan" },
          { ref: "midnight-pier/cards/chen_jiuli.png", pack: "midnight-pier", name: "chen_jiuli" },
        ],
      })
    })

    expect(screen.getByText("lin_wan")).toBeInTheDocument()
    expect(screen.getAllByText("midnight-pier")).toHaveLength(2)
    // The raw ref rides along as the row tooltip.
    expect(screen.getByText("lin_wan").closest("li")).toHaveAttribute(
      "title",
      "midnight-pier/cards/lin_wan.png",
    )

    await userEvent.click(screen.getAllByRole("button", { name: "Import" })[0])
    expect(sent).toContainEqual({ type: "input", text: ".import midnight-pier/cards/lin_wan.png pc" })
  })

  it("stops claiming to load when the server never answers, and retry re-asks", () => {
    // An older (<2.2) server never sends `pack_cards`; without the timeout the
    // picker would spin forever on "Fetching the card list…". fireEvent (not
    // userEvent) on purpose: userEvent's own waiting deadlocks under fake timers.
    vi.useFakeTimers()
    try {
      render(<StatePanel />)
      fireEvent.click(screen.getByRole("button", { name: "Browse" }))
      expect(screen.getByText("Fetching the card list…")).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(PACK_CARDS_REPLY_TIMEOUT_MS)
      })
      expect(screen.getByText(/No reply from the server/)).toBeInTheDocument()

      sent.length = 0
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
      expect(sent).toEqual([{ type: "list_pack_cards" }])
      expect(screen.getByText("Fetching the card list…")).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("shows a friendly empty state when no installed pack ships cards", async () => {
    render(<StatePanel />)
    await userEvent.click(screen.getByRole("button", { name: "Browse" }))
    act(() => {
      useSessionStore.getState().ingest({ type: "pack_cards", cards: [] })
    })
    expect(screen.getByText("No installed pack ships character cards.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument()
  })

  it("stays hidden while offline", () => {
    useConnectionStore.setState({ status: "offline", welcome: null })
    render(<StatePanel />)
    expect(screen.queryByText("Import from pack")).not.toBeInTheDocument()
  })
})

describe("keeper variable writes", () => {
  const GAME = {
    type: "state" as const,
    party: [],
    initiative: [],
    online: 1,
    variables: [
      { id: "fear", label: "Fear", kind: "number" as const, value: 3, min: 0, max: 10 },
      { id: "seen", label: "Seen the fog", kind: "bool" as const, value: false },
      { id: "truth", label: "Truth", kind: "number" as const, value: 5, hidden: true },
    ],
  }

  function connect(role: "keeper" | "player") {
    useConnectionStore.setState({
      status: "online",
      welcome: {
        type: "welcome",
        protocol: "2.1",
        room: "table",
        you: { id: "u1", name: "Nyx", role },
        locale: "en",
        server: "loreweaver/1",
      },
    })
  }

  beforeEach(() => {
    sent.length = 0
    useSessionStore.getState().clear()
    useSessionStore.setState({ game: GAME })
  })

  it("offers nothing to a player", () => {
    connect("player")
    render(<StatePanel />)
    expect(screen.queryByRole("button", { name: "Write" })).not.toBeInTheDocument()
  })

  it("is off until the keeper asks for it", async () => {
    connect("keeper")
    render(<StatePanel />)
    // A keeper reads this panel far more often than they write it.
    expect(screen.queryByLabelText("Increase Fear")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Write" }))
    expect(screen.getByLabelText("Increase Fear")).toBeInTheDocument()
  })

  it("steps a number through .var add, and stops at a declared bound", async () => {
    connect("keeper")
    useSessionStore.setState({
      game: { ...GAME, variables: [{ ...GAME.variables[0], value: 10 }] },
    })
    render(<StatePanel />)
    await userEvent.click(screen.getByRole("button", { name: "Write" }))

    expect(screen.getByLabelText("Increase Fear")).toBeDisabled()
    await userEvent.click(screen.getByLabelText("Decrease Fear"))
    expect(sent).toEqual([{ type: "input", text: ".var add fear -1" }])
  })

  it("toggles a bool through .var set", async () => {
    connect("keeper")
    render(<StatePanel />)
    await userEvent.click(screen.getByRole("button", { name: "Write" }))
    await userEvent.click(screen.getByRole("button", { name: "Toggle" }))
    expect(sent).toContainEqual({ type: "input", text: ".var set seen true" })
  })

  it("writes a keeper-only variable — hiding governs who SEES it", async () => {
    connect("keeper")
    render(<StatePanel />)
    await userEvent.click(screen.getByRole("button", { name: "Write" }))
    await userEvent.click(screen.getByLabelText("Increase Truth"))
    expect(sent).toContainEqual({ type: "input", text: ".var add truth 1" })
  })

  it("sets a value from the field and clears it", async () => {
    connect("keeper")
    render(<StatePanel />)
    await userEvent.click(screen.getByRole("button", { name: "Write" }))
    const field = screen.getByLabelText("Set Fear")
    await userEvent.type(field, "8")
    await userEvent.click(screen.getAllByRole("button", { name: "Set" })[0])
    expect(sent).toContainEqual({ type: "input", text: ".var set fear 8" })
    expect(field).toHaveValue("")
  })
})
