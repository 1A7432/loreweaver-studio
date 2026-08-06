import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import "../../i18n"
import { useSessionStore } from "../../store/session"
import NarrativeLog from "./NarrativeLog"

const ingest = useSessionStore.getState().ingest

describe("NarrativeLog", () => {
  beforeEach(() => useSessionStore.getState().clear())

  it("renders markdown narrative as rich text", () => {
    ingest({
      type: "narrative",
      id: "n1",
      speaker: "kp",
      text: "The **lantern** dies.",
      format: "markdown",
    })
    render(<NarrativeLog />)
    expect(screen.getByText("lantern")).toBeInstanceOf(HTMLElement)
    expect(screen.getByText("lantern").tagName).toBe("STRONG")
  })

  it("labels NPC lines with the NPC name and players with theirs", () => {
    ingest({
      type: "narrative",
      id: "n2",
      speaker: "npc",
      name: "沈墨",
      text: "别碰那口井。",
      format: "markdown",
    })
    ingest({
      type: "narrative",
      id: "n3",
      speaker: "player",
      name: "Ash",
      text: "I step back.",
      format: "plain",
    })
    render(<NarrativeLog />)
    expect(screen.getByText("沈墨")).toBeInTheDocument()
    expect(screen.getByText("Ash")).toBeInTheDocument()
  })

  it("shows a blinking cursor only while a stream is unfinished", () => {
    ingest({
      type: "narrative",
      id: "s1",
      speaker: "kp",
      text: "The fog",
      format: "markdown",
      stream: true,
    })
    const { container, rerender } = render(<NarrativeLog />)
    expect(container.querySelector(".stream-cursor")).not.toBeNull()

    ingest({
      type: "narrative",
      id: "s1",
      speaker: "kp",
      text: " settles.",
      format: "markdown",
      stream: true,
      done: true,
    })
    rerender(<NarrativeLog />)
    expect(container.querySelector(".stream-cursor")).toBeNull()
  })

  it("follows a stream only while the reader is pinned near the bottom", () => {
    const delta = (text: string) =>
      act(() =>
        ingest({ type: "narrative", id: "s1", speaker: "kp", text, format: "markdown", stream: true }),
      )
    delta("The fog ")
    const { container } = render(<NarrativeLog />)
    const log = container.querySelector(".narrative-log") as HTMLDivElement
    Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(log, "clientHeight", { value: 200, configurable: true })

    // Scrolled up to reread history: a new delta must not yank the view down.
    log.scrollTop = 100
    fireEvent.scroll(log)
    delta("thickens ")
    expect(log.scrollTop).toBe(100)

    // Back at the bottom: following resumes.
    log.scrollTop = 780
    fireEvent.scroll(log)
    delta("over the pier.")
    expect(log.scrollTop).toBe(1000)
  })

  it("renders system spinner notices with an animated spinner element", () => {
    ingest({ type: "system", level: "info", text: "Summoning the Keeper…", spinner: true })
    const { container } = render(<NarrativeLog />)
    expect(container.querySelector(".spinner")).not.toBeNull()
  })
})
