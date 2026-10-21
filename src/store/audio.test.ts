import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AudioControlFrame } from "@loreweaver/protocol"
import {
  applyControl,
  armGestureUnlock,
  attemptPlay,
  cancelPlay,
  effectiveVolume,
  PLAY_GRACE_MS,
  registerLayerElement,
  useAudioStore,
} from "./audio"

function control(patch: Partial<AudioControlFrame>): AudioControlFrame {
  return { type: "audio_control", id: "c1", action: "play", layer: "bgm", ...patch }
}

describe("audio store", () => {
  beforeEach(() => {
    useAudioStore.getState().reset()
    useAudioStore.setState({ unlocked: false })
  })

  it("starts a layer on the blob the control names", () => {
    useAudioStore.getState().unlock()
    useAudioStore
      .getState()
      .ingest(control({ hash: "abc", mime: "audio/mpeg", title: "潮涌", loop: true, volume: 0.4 }))
    const bgm = useAudioStore.getState().layers.bgm
    expect(bgm).toMatchObject({ hash: "abc", title: "潮涌", playing: true, loop: true, volume: 0.4 })
    expect(bgm.waitingForUnlock).toBe(false)
  })

  it("does not hold a cue back on its own flag, and remembers one the webview refused", () => {
    // A webview may allow sound with no gesture at all, so the cue is not
    // parked here: the player tries, and only a refusal marks the layer.
    useAudioStore.getState().ingest(control({ hash: "abc" }))
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(false)

    // Dropping a refused cue would lose a beat the author staged; the unlock
    // (a gesture, or the notice's button) then starts everything waiting.
    useAudioStore.getState().markBlocked("bgm")
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(true)

    useAudioStore.getState().unlock()
    const bgm = useAudioStore.getState().layers.bgm
    expect(bgm.waitingForUnlock).toBe(false)
    expect(bgm.playing).toBe(true)
  })

  it("marks a refusal only on a layer that is playing, and only once", () => {
    // A refusal that lands after a stop must not resurrect a hint, and a
    // second one must not write a new object (the player's effect re-runs on
    // every layer change; a no-op write that looked like a change would loop).
    useAudioStore.getState().markBlocked("bgm")
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(false)

    useAudioStore.getState().ingest(control({ hash: "abc" }))
    useAudioStore.getState().markBlocked("bgm")
    const marked = useAudioStore.getState().layers.bgm
    useAudioStore.getState().markBlocked("bgm")
    expect(useAudioStore.getState().layers.bgm).toBe(marked)

    useAudioStore.getState().ingest(control({ action: "stop" }))
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(false)
  })

  it("keeps the transport actions distinct", () => {
    const base = { ...useAudioStore.getState().layers.bgm, hash: "abc", playing: true }
    expect(applyControl(base, control({ action: "pause" }))).toMatchObject({
      playing: false,
      hash: "abc",
    })
    expect(applyControl(base, control({ action: "resume" })).playing).toBe(true)
    // Stop clears the blob; pause does not — resuming after a pause must not
    // need the server to re-send the hash.
    expect(applyControl(base, control({ action: "stop" }))).toMatchObject({
      playing: false,
      hash: undefined,
    })
  })

  it("treats volume as an adjustment, never as a transport action", () => {
    const stopped = { ...useAudioStore.getState().layers.bgm, playing: false }
    expect(applyControl(stopped, control({ action: "volume", volume: 0.2 }))).toMatchObject({
      playing: false,
      volume: 0.2,
    })
    const playing = { ...stopped, playing: true }
    expect(applyControl(playing, control({ action: "volume", volume: 0.9 })).playing).toBe(true)
  })

  it("adopts a replayed audio_state without discarding the listener's mixer", () => {
    useAudioStore.getState().setLayerMuted("bgm", true)
    useAudioStore.getState().setLayerGain("bgm", 0.25)
    useAudioStore.getState().unlock()
    useAudioStore.getState().ingest({
      type: "audio_state",
      layers: [{ layer: "bgm", hash: "abc", title: "潮涌", playing: true, volume: 0.8 }],
    })
    const bgm = useAudioStore.getState().layers.bgm
    expect(bgm).toMatchObject({ hash: "abc", playing: true, volume: 0.8 })
    // Mute and gain are this listener's, and never left this client.
    expect(bgm.muted).toBe(true)
    expect(bgm.gain).toBe(0.25)
  })

  it("clears layers a replayed state no longer mentions", () => {
    useAudioStore.getState().unlock()
    useAudioStore.getState().ingest(control({ layer: "ambience", hash: "old" }))
    useAudioStore.getState().ingest({
      type: "audio_state",
      layers: [{ layer: "bgm", hash: "abc", playing: true }],
    })
    expect(useAudioStore.getState().layers.ambience.playing).toBe(false)
    expect(useAudioStore.getState().layers.ambience.hash).toBeUndefined()
  })

  it("ignores frames from the other families", () => {
    expect(useAudioStore.getState().ingest({ type: "system", level: "info", text: "x" })).toBe(false)
  })

  it("keeps a load error on the layer that failed, and a play clears only that layer", () => {
    useAudioStore.getState().unlock()
    useAudioStore.getState().ingest(control({ layer: "bgm", hash: "abc", title: "Tide" }))
    useAudioStore.getState().ingest(control({ layer: "ambience", hash: "def", title: "Rain" }))
    useAudioStore.getState().setLayerLoadError("bgm", "fetch")
    expect(useAudioStore.getState().layers.bgm.loadError).toBe("fetch")
    expect(useAudioStore.getState().layers.ambience.loadError).toBeNull()

    // A new play of the same hash is a natural retry: error gone, epoch up.
    const epoch = useAudioStore.getState().layers.bgm.loadEpoch
    useAudioStore.getState().ingest(control({ layer: "bgm", hash: "abc" }))
    expect(useAudioStore.getState().layers.bgm.loadError).toBeNull()
    expect(useAudioStore.getState().layers.bgm.loadEpoch).toBe(epoch + 1)
    expect(useAudioStore.getState().layers.ambience.loadError).toBeNull()
  })

  it("retries one layer without touching the others", () => {
    useAudioStore.getState().setLayerLoadError("sfx", "decode")
    useAudioStore.getState().setLayerLoadError("bgm", "fetch")
    const sfxEpoch = useAudioStore.getState().layers.sfx.loadEpoch
    useAudioStore.getState().retryLayer("sfx")
    expect(useAudioStore.getState().layers.sfx.loadError).toBeNull()
    expect(useAudioStore.getState().layers.sfx.loadEpoch).toBe(sfxEpoch + 1)
    expect(useAudioStore.getState().layers.bgm.loadError).toBe("fetch")
  })

  it("drops a load error when the hash changes, including on a replayed state", () => {
    useAudioStore.getState().unlock()
    useAudioStore.getState().ingest(control({ layer: "bgm", hash: "old" }))
    useAudioStore.getState().setLayerLoadError("bgm", "fetch")
    useAudioStore.getState().ingest({
      type: "audio_state",
      layers: [{ layer: "bgm", hash: "new", playing: true }],
    })
    expect(useAudioStore.getState().layers.bgm.loadError).toBeNull()
    expect(useAudioStore.getState().layers.bgm.hash).toBe("new")
  })
})

/** An <audio> element whose paused/ended state the test controls (jsdom has no
 * media pipeline) and whose play() is a spy. */
function fakeAudio(play: () => Promise<void> | undefined = () => Promise.resolve()) {
  const audio = document.createElement("audio")
  let paused = true
  Object.defineProperty(audio, "paused", { get: () => paused, configurable: true })
  Object.defineProperty(audio, "ended", { value: false, writable: true, configurable: true })
  const spy = vi.fn(() => {
    paused = false
    return play()
  })
  audio.play = spy as unknown as typeof audio.play
  return { audio, spy, setPaused: (value: boolean) => (paused = value) }
}

describe("armGestureUnlock", () => {
  let disarm: () => void = () => undefined
  const click = () => document.body.dispatchEvent(new Event("click", { bubbles: true }))

  beforeEach(() => {
    useAudioStore.getState().reset()
    useAudioStore.setState({ unlocked: false })
  })

  afterEach(() => disarm())

  it("unlocks on a click anywhere, and starts what was waiting", () => {
    useAudioStore.getState().ingest(control({ hash: "abc" }))
    useAudioStore.getState().markBlocked("bgm")
    disarm = armGestureUnlock()

    // Not on our button, not even on a focusable element: anywhere in the window.
    click()

    expect(useAudioStore.getState().unlocked).toBe(true)
    expect(useAudioStore.getState().layers.bgm).toMatchObject({ waitingForUnlock: false, playing: true })
  })

  it("counts the events a webview treats as activation, and not pointerdown", () => {
    disarm = armGestureUnlock()
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    expect(useAudioStore.getState().unlocked).toBe(false)

    for (const type of ["keydown", "pointerup", "touchend"]) {
      useAudioStore.setState({ unlocked: false })
      document.body.dispatchEvent(new Event(type, { bubbles: true }))
      expect(useAudioStore.getState().unlocked, type).toBe(true)
    }
  })

  it("stays armed: a cue refused after an earlier gesture starts on the next one", () => {
    // WebKit grants the permission per element, and a later cue is a new element.
    disarm = armGestureUnlock()
    click()
    expect(useAudioStore.getState().unlocked).toBe(true)

    useAudioStore.getState().ingest(control({ hash: "abc" }))
    useAudioStore.getState().markBlocked("bgm")
    click()
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(false)
  })

  it("is installed once, and the disposer takes it away", () => {
    disarm = armGestureUnlock()
    expect(armGestureUnlock()).toBe(disarm)
    disarm()
    click()
    expect(useAudioStore.getState().unlocked).toBe(false)
  })

  it("does not re-render anything for a gesture that changes nothing", () => {
    useAudioStore.getState().unlock()
    const before = useAudioStore.getState()
    useAudioStore.getState().unlock()
    expect(useAudioStore.getState()).toBe(before)
  })

  it("calls play() on a live element synchronously, inside the gesture", () => {
    // A React effect runs after the event, where WebKit blocks the same call.
    const { audio, spy } = fakeAudio()
    const forget = registerLayerElement("bgm", audio)
    useAudioStore.getState().ingest(control({ hash: "abc" }))
    useAudioStore.getState().markBlocked("bgm")
    disarm = armGestureUnlock()

    click()

    expect(spy).toHaveBeenCalledTimes(1)
    forget()
  })

  it("asks only the layers that should be sounding and are paused", () => {
    const stopped = fakeAudio()
    const playingNow = fakeAudio()
    playingNow.setPaused(false)
    const playedOut = fakeAudio()
    Object.defineProperty(playedOut.audio, "ended", { value: true })
    const forgets = [
      registerLayerElement("bgm", stopped.audio),
      registerLayerElement("ambience", playingNow.audio),
      registerLayerElement("sfx", playedOut.audio),
    ]
    // bgm never started; ambience is already audible; sfx played out (a replay
    // would restart a one-shot on every keystroke).
    useAudioStore.getState().ingest(control({ layer: "ambience", hash: "b" }))
    useAudioStore.getState().ingest(control({ layer: "sfx", hash: "c" }))
    disarm = armGestureUnlock()

    click()

    expect(stopped.spy).not.toHaveBeenCalled()
    expect(playingNow.spy).not.toHaveBeenCalled()
    expect(playedOut.spy).not.toHaveBeenCalled()
    forgets.forEach((forget) => forget())
  })
})

describe("attemptPlay", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAudioStore.getState().reset()
    useAudioStore.getState().ingest(control({ hash: "abc" }))
  })

  afterEach(() => vi.useRealTimers())

  const waiting = () => useAudioStore.getState().layers.bgm.waitingForUnlock

  it("counts a play() that never settles on a paused element as refused, after the grace", () => {
    // WebKit's answer to a blocked play: a promise that never settles, no
    // NotAllowedError, and the element left paused.
    const { audio, setPaused } = fakeAudio(() => new Promise(() => undefined))
    const forget = registerLayerElement("bgm", audio)
    attemptPlay("bgm", audio)
    setPaused(true)

    vi.advanceTimersByTime(PLAY_GRACE_MS - 1)
    expect(waiting()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(waiting()).toBe(true)
    forget()
  })

  it("does not call a play() refused when the element is audible or still loading", () => {
    const { audio } = fakeAudio(() => new Promise(() => undefined))
    const forget = registerLayerElement("bgm", audio)
    attemptPlay("bgm", audio)

    vi.advanceTimersByTime(PLAY_GRACE_MS * 2)
    expect(waiting()).toBe(false)
    forget()
  })

  it("does not call a one-shot that already played out refused", () => {
    const { audio, setPaused } = fakeAudio(() => new Promise(() => undefined))
    const forget = registerLayerElement("bgm", audio)
    attemptPlay("bgm", audio)
    setPaused(true)
    Object.defineProperty(audio, "ended", { value: true })

    vi.advanceTimersByTime(PLAY_GRACE_MS * 2)
    expect(waiting()).toBe(false)
    forget()
  })

  it("stops watching once the play resolves, is cancelled, or the element goes", async () => {
    const resolved = fakeAudio()
    const cancelled = fakeAudio(() => new Promise(() => undefined))
    const gone = fakeAudio(() => new Promise(() => undefined))
    registerLayerElement("bgm", resolved.audio)
    attemptPlay("bgm", resolved.audio)
    await Promise.resolve()
    resolved.setPaused(true)
    vi.advanceTimersByTime(PLAY_GRACE_MS * 2)
    expect(waiting()).toBe(false)

    registerLayerElement("bgm", cancelled.audio)
    attemptPlay("bgm", cancelled.audio)
    cancelled.setPaused(true)
    cancelPlay(cancelled.audio)
    vi.advanceTimersByTime(PLAY_GRACE_MS * 2)
    expect(waiting()).toBe(false)

    const forget = registerLayerElement("bgm", gone.audio)
    attemptPlay("bgm", gone.audio)
    gone.setPaused(true)
    forget()
    vi.advanceTimersByTime(PLAY_GRACE_MS * 2)
    expect(waiting()).toBe(false)
  })

  it("treats a NotAllowedError rejection and a throw as refused at once, an AbortError as not", async () => {
    const denied = fakeAudio(() => Promise.reject(new DOMException("no", "NotAllowedError")))
    const forget = registerLayerElement("bgm", denied.audio)
    attemptPlay("bgm", denied.audio)
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting()).toBe(true)
    forget()

    useAudioStore.getState().unlock()
    const aborted = fakeAudio(() => Promise.reject(new DOMException("interrupted", "AbortError")))
    const forgetAborted = registerLayerElement("bgm", aborted.audio)
    attemptPlay("bgm", aborted.audio)
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting()).toBe(false)
    forgetAborted()

    const thrower = fakeAudio(() => {
      throw new DOMException("no", "NotAllowedError")
    })
    const forgetThrower = registerLayerElement("bgm", thrower.audio)
    attemptPlay("bgm", thrower.audio)
    expect(waiting()).toBe(true)
    forgetThrower()
  })

  it("lets a play that goes through after all clear the waiting mark", async () => {
    const { audio } = fakeAudio()
    const forget = registerLayerElement("bgm", audio)
    useAudioStore.getState().markBlocked("bgm")
    attemptPlay("bgm", audio)
    await vi.advanceTimersByTimeAsync(0)
    expect(waiting()).toBe(false)
    forget()
  })
})

describe("effectiveVolume", () => {
  const layer = {
    layer: "bgm" as const,
    playing: true,
    muted: false,
    gain: 1,
    waitingForUnlock: false,
    loadError: null,
    loadEpoch: 0,
  }

  it("multiplies the server's level by the listener's own", () => {
    expect(effectiveVolume({ ...layer, volume: 0.5, gain: 0.5 }, false)).toBe(0.25)
    // No server level means "as authored" — the listener still decides.
    expect(effectiveVolume({ ...layer, gain: 0.4 }, false)).toBe(0.4)
  })

  it("silences on either mute, and clamps a hostile level", () => {
    expect(effectiveVolume({ ...layer, muted: true, volume: 1 }, false)).toBe(0)
    expect(effectiveVolume({ ...layer, volume: 1 }, true)).toBe(0)
    expect(effectiveVolume({ ...layer, volume: 9 }, false)).toBe(1)
    expect(effectiveVolume({ ...layer, volume: -3 }, false)).toBe(0)
  })
})
