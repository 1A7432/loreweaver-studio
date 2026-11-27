// Where the sound lives in the app: the listener's mix (local, persisted, clamped), one
// controller per connection, and the window-wide gesture that unlocks a refused sound.

import { afterEach, describe, expect, it, vi } from "vitest"
import type { AudioElement } from "../features/play/audio"
import { TestRoom } from "../features/play/room.testkit"
import { armGestureUnlock, startAudio, useAudioMixStore, useAudioSlot } from "./audio"

const silent = (): AudioElement => ({
  src: "",
  loop: false,
  volume: 1,
  paused: true,
  ended: false,
  error: null,
  play: () => Promise.resolve(),
  pause: () => undefined,
  load: () => undefined,
  removeAttribute: () => undefined,
  addEventListener: () => undefined,
})

let room: TestRoom | null = null
afterEach(() => {
  useAudioSlot.getState().controller?.dispose()
  useAudioSlot.setState({ controller: null })
  room?.close()
  room = null
})

describe("the listener's mix", () => {
  it("keeps a volume per layer within 0..1", () => {
    useAudioMixStore.getState().setGain("ambience", 3)
    expect(useAudioMixStore.getState().gain.ambience).toBe(1)
    useAudioMixStore.getState().setGain("ambience", -1)
    expect(useAudioMixStore.getState().gain.ambience).toBe(0)
    useAudioMixStore.getState().setGain("ambience", 1)
  })
})

describe("startAudio", () => {
  it("runs one controller per connection, holding the audio view, and ends the last one's", async () => {
    room = await TestRoom.open("player")
    const first = startAudio(room.connection, silent)
    const dispose = vi.spyOn(first, "dispose")
    const second = startAudio(room.connection, silent)
    expect(dispose).toHaveBeenCalled()
    expect(useAudioSlot.getState().controller).toBe(second)
    await room.feed()
    expect(
      room
        .requests()
        .some(
          (frame) =>
            frame.type === "call" &&
            frame.method === "view.subscribe" &&
            JSON.stringify(frame).includes('"audio"'),
        ),
    ).toBe(true)
  })

  it("asks for sound on a gesture only while the WebView refuses it", async () => {
    room = await TestRoom.open("player")
    const controller = startAudio(room.connection, silent)
    const unlock = vi.spyOn(controller, "unlock")
    const disarm = armGestureUnlock()
    window.dispatchEvent(new Event("click"))
    expect(unlock).not.toHaveBeenCalled()
    vi.spyOn(controller, "getState").mockReturnValue({ blocked: true, failed: [] })
    window.dispatchEvent(new Event("click"))
    expect(unlock).toHaveBeenCalledTimes(1)
    disarm()
  })
})
