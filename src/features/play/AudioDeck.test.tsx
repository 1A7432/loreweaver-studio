import { act, fireEvent, render, screen, within } from "@testing-library/react"
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
import { armGestureUnlock, useAudioStore } from "../../store/audio"
import { useConnectionStore } from "../../store/connection"
import AudioDeck, { AudioUnlockNotice } from "./AudioDeck"

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
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
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
    // The tooltip is a translated sentence, never the raw cause: this row is
    // read by a listener whose locale may not be English.
    expect(within(bgm).getByRole("alert")).toHaveAttribute(
      "title",
      "The track never arrived — the room's media store handed back no usable bytes for it.",
    )
    // The cause is not thrown away, it just does not go on screen.
    expect(console.warn).toHaveBeenCalledWith("audio bgm: blob exceeds the client cap")
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

  it("does not let the error of a replaced load bury the load that replaced it", async () => {
    // Cleanup revoked the blob URL while the mounted element was still pointing
    // at it, so the element raised `error` for a source pulled out from under
    // it. That callback is asynchronous: by the time it ran, the NEXT load had
    // already succeeded — and the handler, which asks no questions about which
    // load it belongs to, wrote `decode` over it and dropped the src. A hash
    // change or a Retry click could therefore silence a layer that had just
    // loaded perfectly well.
    let minted = 0
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:audio-${++minted}`)
    vi.mocked(assetFetch).mockResolvedValue(5)
    act(() => play("bgm", HASH_BGM, "Tide"))
    const { container } = render(<AudioDeck />)

    const replaced = await vi.waitFor(() => {
      const element = container.querySelector("audio")
      if (element?.getAttribute("src") !== "blob:audio-1") throw new Error("first load not mounted")
      return element
    })

    act(() => play("bgm", HASH_AMB, "New tide"))
    await vi.waitFor(() => {
      const element = container.querySelector("audio")
      if (element?.getAttribute("src") !== "blob:audio-2") throw new Error("second load not mounted")
    })

    // The first load's element finally reports the source it lost.
    act(() => {
      fireEvent.error(replaced)
    })

    const bgm = screen.getByText("Music").closest(".audio-row") as HTMLElement
    expect(within(bgm).queryByRole("alert")).toBeNull()
    expect(useAudioStore.getState().layers.bgm.loadError).toBeNull()
    expect(container.querySelector("audio")?.getAttribute("src")).toBe("blob:audio-2")
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:audio-2")
  })

  it("never revokes a URL the mounted element is still pointing at", async () => {
    // The other half: the element must never be left naming a URL that has
    // already been revoked. Revocation waits until the DOM has moved on.
    let mounted: HTMLElement | null = null
    const revokedWhileShown: string[] = []
    let minted = 0
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:audio-${++minted}`)
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      if (mounted?.querySelector("audio")?.getAttribute("src") === url) revokedWhileShown.push(url)
    })
    vi.mocked(assetFetch).mockResolvedValue(5)
    act(() => play("bgm", HASH_BGM, "Tide"))
    const { container } = render(<AudioDeck />)
    mounted = container

    await vi.waitFor(() => {
      if (container.querySelector("audio")?.getAttribute("src") !== "blob:audio-1") {
        throw new Error("first load not mounted")
      }
    })
    act(() => play("bgm", HASH_AMB, "New tide"))
    await vi.waitFor(() => {
      if (container.querySelector("audio")?.getAttribute("src") !== "blob:audio-2") {
        throw new Error("second load not mounted")
      }
    })

    expect(revokedWhileShown).toEqual([])
    // …and the URL nothing points at any more is still let go.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:audio-1")
  })

  it("translates a decode failure instead of showing the reason code", async () => {
    vi.mocked(assetFetch).mockResolvedValue(5)
    act(() => play("bgm", HASH_BGM, "Tide"))
    const { container } = render(<AudioDeck />)

    const audio = await vi.waitFor(() => {
      const element = container.querySelector("audio")
      if (element === null) throw new Error("the player has not mounted yet")
      return element
    })
    act(() => {
      fireEvent.error(audio)
    })

    const bgm = screen.getByText("Music").closest(".audio-row") as HTMLElement
    expect(await within(bgm).findByRole("alert")).toHaveAttribute(
      "title",
      "The bytes arrived, but this window could not decode them as playable audio.",
    )
  })
})

describe("AudioDeck autoplay", () => {
  let playSpy: ReturnType<typeof vi.spyOn>
  let disarm: () => void = () => undefined

  const refused = () => new DOMException("play() failed: no user gesture", "NotAllowedError")
  const unlockButton = () => screen.queryAllByRole("button", { name: "Turn sound on" })

  beforeEach(() => {
    useAudioStore.getState().reset()
    // The state of a window nobody has clicked yet.
    useAudioStore.setState({ unlocked: false })
    useConnectionStore.setState({
      status: "online",
      attempt: 0,
      lastError: null,
      welcome: {
        type: "welcome",
        protocol: "2.4",
        room: "r1",
        you: { id: "u1", name: "Nyx", role: "player" },
        locale: "en",
        server: "loreweaver/1",
      },
    })
    vi.mocked(assetFetch).mockReset().mockResolvedValue(5)
    vi.mocked(assetReadBase64).mockReset().mockResolvedValue("aGVsbG8=")
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test/audio")
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
    playSpy = vi.spyOn(HTMLMediaElement.prototype, "play")
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    disarm()
    vi.restoreAllMocks()
  })

  it("plays a cue with no gesture at all when the webview allows it, and never shows the hint", async () => {
    playSpy.mockResolvedValue(undefined)
    act(() => play("bgm", HASH_BGM, "Tide"))
    render(
      <>
        <AudioUnlockNotice />
        <AudioDeck />
      </>,
    )

    await vi.waitFor(() => expect(playSpy).toHaveBeenCalled())
    // Let the (resolved) attempt settle before looking for a hint that must not be there.
    await act(async () => undefined)
    expect(unlockButton()).toHaveLength(0)
    expect(screen.queryByRole("status")).toBeNull()
    expect(useAudioStore.getState().unlocked).toBe(false)
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(false)
  })

  it("shows the hint, in the deck and above the chronicle, when the webview refuses", async () => {
    playSpy.mockRejectedValue(refused())
    act(() => play("bgm", HASH_BGM, "Tide"))
    render(
      <>
        <AudioUnlockNotice />
        <AudioDeck />
      </>,
    )

    await vi.waitFor(() => expect(unlockButton()).toHaveLength(2))
    // The cue is remembered, not dropped, and the row still names it.
    expect(useAudioStore.getState().layers.bgm).toMatchObject({ playing: true, waitingForUnlock: true })
    const bgm = screen.getByText("Music").closest(".audio-row") as HTMLElement
    expect(within(bgm).getByText("Tide")).toBeInTheDocument()
  })

  it("starts a refused layer on the first gesture anywhere in the window", async () => {
    playSpy.mockRejectedValueOnce(refused()).mockResolvedValue(undefined)
    disarm = armGestureUnlock()
    act(() => play("bgm", HASH_BGM, "Tide"))
    render(<AudioDeck />)
    await vi.waitFor(() => expect(unlockButton()).toHaveLength(1))
    expect(playSpy).toHaveBeenCalledTimes(1)

    // Not the deck's button — a click on the page body.
    act(() => {
      fireEvent.pointerDown(document.body)
    })

    await vi.waitFor(() => expect(playSpy).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(unlockButton()).toHaveLength(0))
    expect(useAudioStore.getState().unlocked).toBe(true)
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(false)
  })

  it("starts it from the notice's own button too", async () => {
    const user = userEvent.setup()
    playSpy.mockRejectedValue(refused())
    act(() => play("bgm", HASH_BGM, "Tide"))
    // The player lives in the deck, so it is mounted beside the notice.
    render(
      <>
        <AudioUnlockNotice />
        <AudioDeck />
      </>,
    )
    await vi.waitFor(() => expect(screen.getAllByRole("button", { name: "Turn sound on" })).toHaveLength(2))

    playSpy.mockResolvedValue(undefined)
    await user.click(screen.getAllByRole("button", { name: "Turn sound on" })[0])
    await vi.waitFor(() => expect(unlockButton()).toHaveLength(0))
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(false)
  })

  it("does not call an interrupted play a refusal", async () => {
    // An AbortError is a pause or a newer source cutting the attempt short,
    // not the webview's policy — no hint for it.
    playSpy.mockRejectedValue(new DOMException("interrupted by pause()", "AbortError"))
    act(() => play("bgm", HASH_BGM, "Tide"))
    render(<AudioDeck />)

    await vi.waitFor(() => expect(playSpy).toHaveBeenCalled())
    await act(async () => undefined)
    expect(unlockButton()).toHaveLength(0)
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(false)
  })

  it("treats a synchronous throw from play() as a refusal", async () => {
    playSpy.mockImplementation(() => {
      throw refused()
    })
    act(() => play("bgm", HASH_BGM, "Tide"))
    render(<AudioDeck />)

    await vi.waitFor(() => expect(unlockButton()).toHaveLength(1))
  })

  it("shows no notice when nothing is waiting", () => {
    const { container } = render(<AudioUnlockNotice />)
    expect(container).toBeEmptyDOMElement()
  })
})
