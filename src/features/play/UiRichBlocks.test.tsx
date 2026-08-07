import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UiFrame } from "@loreweaver/protocol"
import "../../i18n"
import UiBlocks from "./UiBlocks"
import { ImageBlockView, MapPinBlockView } from "./UiRichBlocks"

// The native asset cache is mocked: pull-then-read returns a tiny base64
// payload per hash. Hashes are unique per test — the module-level data-URL
// cache is (correctly) shared across mounts.
vi.mock("./panels/assets", () => ({
  assetFetch: vi.fn(),
  assetReadBase64: vi.fn(),
}))

import { assetFetch, assetReadBase64 } from "./panels/assets"

const HASH_IMG = "1".repeat(64)
const HASH_MAP = "2".repeat(64)
const HASH_BROKEN = "3".repeat(64)

beforeEach(() => {
  vi.mocked(assetFetch).mockReset().mockResolvedValue(4)
  vi.mocked(assetReadBase64)
    .mockReset()
    .mockImplementation((hash: string) => {
      if (hash === HASH_BROKEN) return Promise.reject(new Error("not cached"))
      return Promise.resolve("aGVsbG8=")
    })
})

describe("ImageBlockView", () => {
  it("shows the caption/alt line while loading, then the picture with its caption", async () => {
    render(
      <ImageBlockView
        block={{
          kind: "image",
          hash: HASH_IMG,
          mime: "image/png",
          caption: "Torn page",
          alt: "Nine lanterns",
        }}
      />,
    )
    // The text-first degradation IS the loading state.
    expect(screen.getByText("Nine lanterns")).toBeInTheDocument()
    const img = await screen.findByRole("img", { name: "Nine lanterns" })
    expect(img).toHaveAttribute("src", "data:image/png;base64,aGVsbG8=")
    expect(screen.getByText("Torn page")).toBeInTheDocument()
    expect(assetFetch).toHaveBeenCalledWith(HASH_IMG)
  })

  it("falls back to the alt/caption line when the pull fails", async () => {
    render(<ImageBlockView block={{ kind: "image", hash: HASH_BROKEN, alt: "Old photo" }} />)
    expect(await screen.findByText(/Old photo — image unavailable/)).toHaveClass("is-failed")
    expect(screen.queryByRole("img")).toBeNull()
  })
})

describe("MapPinBlockView", () => {
  it("pins the marker at the fractional coordinates over the map", async () => {
    const { container } = render(
      <MapPinBlockView
        block={{
          kind: "map_pin",
          hash: HASH_MAP,
          label: "Tide mark",
          x: 0.25,
          y: 0.75,
          note: "it went out here",
        }}
      />,
    )
    expect(screen.getByText("Loading image…")).toBeInTheDocument()
    await screen.findByRole("img", { name: "Tide mark" })
    const marker = container.querySelector(".ui-map-marker") as HTMLElement
    expect(marker.style.left).toBe("25%")
    expect(marker.style.top).toBe("75%")
    expect(marker).toHaveAttribute("title", "it went out here")
    expect(screen.getByText("Tide mark")).toBeInTheDocument()
    expect(screen.getByText("it went out here")).toBeInTheDocument()
  })
})

describe("performance templates via the ui-frame renderer", () => {
  const FRAME: UiFrame = {
    type: "ui",
    panel: "inline",
    blocks: [
      { kind: "letter", body: "Meet at the pier.", from: "K.", to: "Inspector", date: "March 3" },
      {
        kind: "clipping",
        headline: "Nine lanterns vanish",
        body: "The tide took them.",
        source: "Gazette",
        date: "3/3",
      },
      { kind: "title_card", title: "The Send-Off", subtitle: "what the tide keeps", act: "Act III" },
    ],
  }

  it("styles a letter as stationery with its attribution line", () => {
    const { container } = render(<UiBlocks frame={FRAME} />)
    const letter = container.querySelector(".ui-letter") as HTMLElement
    expect(letter.querySelector(".ui-letter-to")).toHaveTextContent("Inspector")
    expect(letter.querySelector(".ui-letter-body")).toHaveTextContent("Meet at the pier.")
    expect(letter.querySelector(".ui-letter-attribution")).toHaveTextContent("— K. · March 3")
  })

  it("styles a clipping as a newspaper cut-out", () => {
    const { container } = render(<UiBlocks frame={FRAME} />)
    const clipping = container.querySelector(".ui-clipping") as HTMLElement
    expect(clipping.querySelector(".ui-clipping-headline")).toHaveTextContent("Nine lanterns vanish")
    expect(clipping.querySelector(".ui-clipping-body")).toHaveTextContent("The tide took them.")
    expect(clipping.querySelector(".ui-clipping-attribution")).toHaveTextContent("— Gazette · 3/3")
  })

  it("styles a title_card as a ruled act break", () => {
    const { container } = render(<UiBlocks frame={FRAME} />)
    const card = container.querySelector(".ui-title-card") as HTMLElement
    expect(card.querySelectorAll(".ui-title-card-rule")).toHaveLength(2)
    expect(card.querySelector(".ui-title-card-act")).toHaveTextContent("Act III")
    expect(card.querySelector(".ui-title-card-title")).toHaveTextContent("The Send-Off")
    expect(card.querySelector(".ui-title-card-subtitle")).toHaveTextContent("what the tide keeps")
  })
})
