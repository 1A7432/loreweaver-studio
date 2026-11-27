// The sound card: what plays for everyone, the library for the room admin only, every control a
// command the `commands` view offers, and a sound added by an upload with purpose `audio`. View
// values, results and signals are the engine's own (`fixtures/actions.json`).

import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, convertFileSrc: (path: string) => path }))
vi.mock("../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/native")>()),
  pickUploadPath: vi.fn(async () => "/sounds/Harbor Bell.ogg"),
}))

import { flush } from "../../lib/connection.testkit"
import { useAudioMixStore, useAudioSlot } from "../../store/audio"
import { AudioController, type AudioElement } from "./audio"
import AudioDeck, { AudioUnlockNotice } from "./AudioDeck"
import { ACTION_FIXTURE, TestRoom, resultBody } from "./room.testkit"

const RAIN = ACTION_FIXTURE.audioPlaying.admin.library[0]
const TAVERN = ACTION_FIXTURE.audioPlaying.admin.library[1]

let room: TestRoom | null = null
beforeEach(() => {
  native.invoke.mockReset()
  useAudioMixStore.setState({ muted: false, gain: { bgm: 1, ambience: 1, sfx: 1 } })
})
afterEach(() => {
  useAudioSlot.getState().controller?.dispose()
  useAudioSlot.setState({ controller: null })
  room?.close()
  room = null
})

/** The room, the card rendered (it holds the `audio` view), then the view's value arriving. */
async function open(role: "player" | "admin") {
  room = await TestRoom.open(role)
  await room.actionViews(role)
  render(<AudioDeck />)
  await room.view("audio", structuredClone(ACTION_FIXTURE.audioPlaying[role]))
  return room
}

describe("AudioDeck — everyone", () => {
  it("shows a player what plays, and never the library's names", async () => {
    await open("player")
    const music = screen.getByText("Music").closest(".audio-row") as HTMLElement
    expect(music).toHaveTextContent("Rain Night")
    expect(screen.queryByText("Library")).toBeNull()
    expect(screen.queryByText("Tavern")).toBeNull()
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull()
  })

  it("keeps the listener's mute and per-layer volume in local state, sending nothing", async () => {
    const r = await open("player")
    const before = r.requests().length
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Mute" }))
    fireEvent.change(screen.getByRole("slider", { name: "Music volume (this computer)" }), {
      target: { value: "0.4" },
    })
    expect(useAudioMixStore.getState().muted).toBe(true)
    expect(useAudioMixStore.getState().gain.bgm).toBe(0.4)
    expect(r.requests()).toHaveLength(before)
  })

  it("offers the unlock while the WebView refuses to start sound, and asks again from the click", async () => {
    const r = await open("player")
    const elements: AudioElement[] = []
    let allow = false
    const controller = new AudioController({
      session: r.connection.session,
      load: async () => "blob:rain",
      createElement: () => {
        const element: AudioElement = {
          src: "",
          loop: false,
          volume: 1,
          paused: true,
          ended: false,
          error: null,
          play: vi.fn(() =>
            allow
              ? Promise.resolve()
              : Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
          ),
          pause: vi.fn(),
          load: vi.fn(),
          removeAttribute: vi.fn(),
          addEventListener: vi.fn(),
        }
        elements.push(element)
        return element
      },
      timers: r.timers,
      want: (names) => r.connection.want(names),
    })
    act(() => useAudioSlot.setState({ controller }))
    render(<AudioUnlockNotice />)
    // The controller arrives after the view did: a fresh value (a reconnect's) is what it starts from.
    await act(async () => {
      await r.view("audio", structuredClone(ACTION_FIXTURE.audioPlaying.player))
      await flush(10)
    })
    expect(screen.getByText(/this window has not allowed sound yet/)).toBeInTheDocument()
    allow = true
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Turn sound on" })[0])
    expect(elements[0].play).toHaveBeenCalledTimes(2)
    expect(screen.queryAllByRole("button", { name: "Turn sound on" })).toEqual([])
  })
})

describe("AudioDeck — the room admin", () => {
  it("lists the library by its titles and plays a sound on the chosen layer by its id", async () => {
    const r = await open("admin")
    const user = userEvent.setup()
    const tavern = screen.getByText("Tavern").closest("li") as HTMLElement
    await user.selectOptions(within(tavern).getByRole("combobox"), "ambience")
    await user.click(within(tavern).getByRole("button", { name: "Play" }))
    expect(r.commands().at(-1)).toEqual({ id: "ambience", args: { op: "play", query: TAVERN.id } })
    await r.answer(resultBody("audioNotFound"))
    expect(screen.getByRole("alert")).toHaveTextContent(
      "No sound in the audio library matches nothing-like-it.",
    )
  })

  it("pauses, stops and sets the table's volume of what plays (the volume once, on release)", async () => {
    const r = await open("admin")
    const user = userEvent.setup()
    const controls = document.querySelector('[data-controls="bgm"]') as HTMLElement
    await user.click(within(controls).getByRole("button", { name: "Pause" }))
    expect(r.commands().at(-1)).toEqual({ id: "bgm", args: { op: "pause" } })
    await r.answer(resultBody("bgmPause"))
    const slider = within(controls).getByRole("slider", { name: "Music volume for the table" })
    fireEvent.change(slider, { target: { value: "0.3" } })
    fireEvent.change(slider, { target: { value: "0.2" } })
    fireEvent.pointerUp(slider)
    await r.feed()
    expect(r.commands().filter((command) => command.id === "bgm")).toEqual([
      { id: "bgm", args: { op: "pause" } },
      { id: "bgm", args: { op: "volume", volume: 0.2 } },
    ])
    await user.click(within(controls).getByRole("button", { name: "Stop" }))
    expect(r.commands().at(-1)).toEqual({ id: "bgm", args: { op: "stop" } })
  })

  it("sets an upload's title, layer and tags, and removes it only after asking", async () => {
    const r = await open("admin")
    const user = userEvent.setup()
    const tavern = screen.getByText("Tavern").closest("li") as HTMLElement
    await user.click(within(tavern).getByRole("button", { name: "Edit" }))
    const title = within(tavern).getByLabelText("Title")
    await user.clear(title)
    await user.type(title, "Tavern Night")
    await user.selectOptions(within(tavern).getByLabelText("Meant for"), "ambience")
    await user.type(within(tavern).getByLabelText("Tags"), "inn")
    await user.click(within(tavern).getByRole("button", { name: "Save" }))
    expect(r.commands().at(-1)).toEqual({
      id: "audio",
      args: { op: "set", query: TAVERN.id, title: "Tavern Night", layer: "ambience", tags: ["inn"] },
    })
    await r.answer(resultBody("audioSet"))
    expect(screen.getByRole("status")).toHaveTextContent("Updated: Tavern Night.")

    const rain = screen.getByText("Rain Night", { selector: "li *" }).closest("li") as HTMLElement
    await user.click(within(rain).getByRole("button", { name: "Remove" }))
    expect(r.commands().at(-1)?.id).toBe("audio")
    await user.click(within(rain).getByRole("button", { name: "Remove for good" }))
    expect(r.commands().at(-1)).toEqual({ id: "audio", args: { op: "remove", query: RAIN.id } })
  })

  it("adds a sound by uploading it with purpose audio, and says so", async () => {
    const r = await open("admin")
    const offer = { name: "Harbor Bell.ogg", mime: "audio/ogg", size: 4, sha256: "b".repeat(64) }
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "media_prepare") return offer
      if (command === "media_upload")
        return { hash: offer.sha256, size: 4, mime: "audio/ogg", name: offer.name }
      throw new Error(`unexpected ${command}`)
    })
    await userEvent.setup().click(screen.getByRole("button", { name: "Add a sound…" }))
    await r.feed()
    expect(native.invoke).toHaveBeenCalledWith("media_prepare", {
      path: "/sounds/Harbor Bell.ogg",
      purpose: "audio",
    })
    expect(r.lastRequest()).toMatchObject({ method: "media.offer", params: { ...offer, purpose: "audio" } })
    await r.answer({ ok: true, data: { upload_id: "u-1" } })
    await act(async () => flush(10))
    expect(native.invoke).toHaveBeenCalledWith("media_upload", {
      path: "/sounds/Harbor Bell.ogg",
      uploadId: "u-1",
      expectedSha256: offer.sha256,
    })
    expect(screen.getByText("Added Harbor Bell.ogg to the library.")).toBeInTheDocument()
  })

  it("shows a byte-channel refusal in the server's words", async () => {
    const r = await open("admin")
    native.invoke.mockImplementation(async (command: string) => {
      if (command === "media_prepare")
        return { name: "a.ogg", mime: "audio/ogg", size: 4, sha256: "c".repeat(64) }
      throw { code: "audio_library_full", message: "The audio library is full.", server: true }
    })
    await userEvent.setup().click(screen.getByRole("button", { name: "Add a sound…" }))
    await r.feed()
    await r.answer({ ok: true, data: { upload_id: "u-2" } })
    await act(async () => flush(10))
    expect(screen.getByRole("alert")).toHaveTextContent("The audio library is full.")
  })
})
