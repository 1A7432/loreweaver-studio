import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  transportSend: vi.fn(async () => undefined),
}))

vi.mock("../../lib/transport", () => ({
  ...transport,
  TRANSPORT_EVENT: "loreweaver://transport",
}))

vi.mock("./panels/assets", () => ({
  assetFetch: vi.fn(),
  assetReadBase64: vi.fn(),
}))

import "../../i18n"
import { assetFetch, assetReadBase64 } from "./panels/assets"
import { useAudioStore } from "../../store/audio"
import { useConnectionStore } from "../../store/connection"
import AudioDeck from "./AudioDeck"

const HASH_BGM = "a".repeat(64)
const HASH_AMB = "b".repeat(64)

function play(layer: "bgm" | "ambience" | "sfx", hash: string, title: string) {
  useAudioStore.getState().ingest({
    type: "audio_control",
    id: `c-${layer}`,
    action: "play",
    layer,
    hash,
    mime: "audio/mpeg",
    title,
  })
}

describe("AudioDeck load errors", () => {
  beforeEach(() => {
    useAudioStore.getState().reset()
    useAudioStore.setState({ unlocked: true })
    useConnectionStore.setState({
      status: "online",
      attempt: 0,
      lastError: null,
      welcome: {
        type: "welcome",
        protocol: "2.3",
        room: "r1",
        you: { id: "u1", name: "Nyx", role: "player" },
        locale: "en",
        server: "loreweaver/1",
      },
    })
    vi.mocked(assetFetch).mockReset()
    vi.mocked(assetReadBase64).mockReset().mockResolvedValue("aGVsbG8=")
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test/audio")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue()
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("shows a localized layer error instead of failing silently, and retry recovers", async () => {
    const user = userEvent.setup()
    vi.mocked(assetFetch).mockRejectedValueOnce(new Error("blob exceeds the client cap"))
    act(() => play("bgm", HASH_BGM, "Tide"))
    render(<AudioDeck />)

    const bgm = screen.getByText("Music").closest(".audio-row") as HTMLElement
    expect(await within(bgm).findByRole("alert")).toHaveTextContent("Could not load this layer.")
    expect(within(bgm).getByRole("alert")).toHaveAttribute("title", "blob exceeds the client cap")
    expect(screen.queryByText("Could not load this layer.")).toBe(within(bgm).getByRole("alert"))

    vi.mocked(assetFetch).mockResolvedValue(5)
    await user.click(within(bgm).getByRole("button", { name: "Retry" }))
    await vi.waitFor(() => {
      expect(within(bgm).queryByRole("alert")).toBeNull()
    })
    expect(assetFetch).toHaveBeenLastCalledWith(HASH_BGM)
  })

  it("does not paint a bgm failure onto ambience", async () => {
    vi.mocked(assetFetch).mockImplementation(async (hash: string) => {
      if (hash === HASH_BGM) throw new Error("not cached")
      return 5
    })
    act(() => {
      play("bgm", HASH_BGM, "Tide")
      play("ambience", HASH_AMB, "Rain")
    })
    render(<AudioDeck />)

    const bgm = screen.getByText("Music").closest(".audio-row") as HTMLElement
    const ambience = screen.getByText("Ambience").closest(".audio-row") as HTMLElement
    expect(await within(bgm).findByRole("alert")).toBeInTheDocument()
    expect(within(ambience).queryByRole("alert")).toBeNull()
    expect(within(ambience).getByText("Rain")).toBeInTheDocument()
  })

  it("clears the error when the hash changes and the next load succeeds", async () => {
    vi.mocked(assetFetch).mockRejectedValueOnce(new Error("transport offline"))
    act(() => play("bgm", HASH_BGM, "Tide"))
    render(<AudioDeck />)
    const bgm = screen.getByText("Music").closest(".audio-row") as HTMLElement
    expect(await within(bgm).findByRole("alert")).toBeInTheDocument()

    vi.mocked(assetFetch).mockResolvedValue(5)
    act(() => play("bgm", HASH_AMB, "New tide"))
    await vi.waitFor(() => {
      expect(within(bgm).queryByRole("alert")).toBeNull()
    })
    expect(within(bgm).getByText("New tide")).toBeInTheDocument()
  })
})
