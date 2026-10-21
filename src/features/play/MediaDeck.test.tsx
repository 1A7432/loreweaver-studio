import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { useMediaStore } from "../../store/media"
import MediaDeck from "./MediaDeck"

const picture = (id: string, hash: string, name: string) => ({
  type: "media" as const,
  id,
  hash,
  mime: "image/png",
  size: 1024,
  name,
  from: "Nyx",
  ts: 1,
})

describe("MediaDeck", () => {
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    useMediaStore.getState().reset()
    errors = vi.spyOn(console, "error").mockImplementation(() => {})
  })
  afterEach(() => errors.mockRestore())

  it("shows a picture once after the join replay sends it again", () => {
    const ingest = useMediaStore.getState().ingest
    act(() => {
      ingest(picture("m1", "h1", "handout.png"))
      // Reconnect: the same blob, in a fresh frame.
      ingest(picture("m-replay", "h1", "handout.png"))
    })
    const { container } = render(<MediaDeck />)
    expect(container.querySelectorAll(".media-item")).toHaveLength(1)
    expect(screen.getAllByText("handout.png")).toHaveLength(1)
  })

  it("renders two different pictures that share a frame id without a key clash", () => {
    const ingest = useMediaStore.getState().ingest
    act(() => {
      ingest(picture("same", "h1", "handout.png"))
      ingest(picture("same", "h2", "map.png"))
    })
    const { container } = render(<MediaDeck />)
    expect(container.querySelectorAll(".media-item")).toHaveLength(2)
    expect(errors).not.toHaveBeenCalled()
  })
})
