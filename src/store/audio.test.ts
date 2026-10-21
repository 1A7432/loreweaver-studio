import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AudioControlFrame } from "@loreweaver/protocol"
import { applyControl, armGestureUnlock, effectiveVolume, useAudioStore } from "./audio"

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

describe("armGestureUnlock", () => {
  let disarm: () => void = () => undefined

  beforeEach(() => {
    useAudioStore.getState().reset()
    useAudioStore.setState({ unlocked: false })
  })

  afterEach(() => disarm())

  it("unlocks on the first pointer gesture anywhere, and starts what was waiting", () => {
    useAudioStore.getState().ingest(control({ hash: "abc" }))
    useAudioStore.getState().markBlocked("bgm")
    disarm = armGestureUnlock()

    // Not on our button, not even on a focusable element: anywhere in the window.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))

    expect(useAudioStore.getState().unlocked).toBe(true)
    expect(useAudioStore.getState().layers.bgm).toMatchObject({ waitingForUnlock: false, playing: true })
  })

  it("unlocks on a key press too, and is spent after one gesture", () => {
    disarm = armGestureUnlock()
    window.dispatchEvent(new Event("keydown"))
    expect(useAudioStore.getState().unlocked).toBe(true)

    // Removed after firing: a later refusal is not wiped by the next click.
    useAudioStore.getState().ingest(control({ hash: "abc" }))
    useAudioStore.getState().markBlocked("bgm")
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(true)
  })

  it("is installed once, and the disposer takes it away", () => {
    disarm = armGestureUnlock()
    expect(armGestureUnlock()).toBe(disarm)
    disarm()
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    expect(useAudioStore.getState().unlocked).toBe(false)
  })

  it("arms nothing once a gesture has already been seen", () => {
    useAudioStore.getState().unlock()
    disarm = armGestureUnlock()
    useAudioStore.getState().ingest(control({ hash: "abc" }))
    useAudioStore.getState().markBlocked("bgm")
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }))
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(true)
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
