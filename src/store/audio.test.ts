import { beforeEach, describe, expect, it } from "vitest"
import type { AudioControlFrame } from "@loreweaver/protocol"
import { applyControl, effectiveVolume, useAudioStore } from "./audio"

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

  it("remembers a cue that arrived before the webview would allow sound", () => {
    // Dropping it would lose a beat the author staged; the deck's unlock
    // button then starts everything that was waiting.
    useAudioStore.getState().ingest(control({ hash: "abc" }))
    expect(useAudioStore.getState().layers.bgm.waitingForUnlock).toBe(true)

    useAudioStore.getState().unlock()
    const bgm = useAudioStore.getState().layers.bgm
    expect(bgm.waitingForUnlock).toBe(false)
    expect(bgm.playing).toBe(true)
  })

  it("keeps the transport actions distinct", () => {
    const base = { ...useAudioStore.getState().layers.bgm, hash: "abc", playing: true }
    expect(applyControl(base, control({ action: "pause" }), true)).toMatchObject({
      playing: false,
      hash: "abc",
    })
    expect(applyControl(base, control({ action: "resume" }), true).playing).toBe(true)
    // Stop clears the blob; pause does not — resuming after a pause must not
    // need the server to re-send the hash.
    expect(applyControl(base, control({ action: "stop" }), true)).toMatchObject({
      playing: false,
      hash: undefined,
    })
  })

  it("treats volume as an adjustment, never as a transport action", () => {
    const stopped = { ...useAudioStore.getState().layers.bgm, playing: false }
    expect(applyControl(stopped, control({ action: "volume", volume: 0.2 }), true)).toMatchObject({
      playing: false,
      volume: 0.2,
    })
    const playing = { ...stopped, playing: true }
    expect(applyControl(playing, control({ action: "volume", volume: 0.9 }), true).playing).toBe(true)
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
    useAudioStore.getState().setLayerLoadError("bgm", "blob exceeds the client cap")
    expect(useAudioStore.getState().layers.bgm.loadError).toBe("blob exceeds the client cap")
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
    useAudioStore.getState().setLayerLoadError("bgm", "still failing")
    const sfxEpoch = useAudioStore.getState().layers.sfx.loadEpoch
    useAudioStore.getState().retryLayer("sfx")
    expect(useAudioStore.getState().layers.sfx.loadError).toBeNull()
    expect(useAudioStore.getState().layers.sfx.loadEpoch).toBe(sfxEpoch + 1)
    expect(useAudioStore.getState().layers.bgm.loadError).toBe("still failing")
  })

  it("drops a load error when the hash changes, including on a replayed state", () => {
    useAudioStore.getState().unlock()
    useAudioStore.getState().ingest(control({ layer: "bgm", hash: "old" }))
    useAudioStore.getState().setLayerLoadError("bgm", "not cached")
    useAudioStore.getState().ingest({
      type: "audio_state",
      layers: [{ layer: "bgm", hash: "new", playing: true }],
    })
    expect(useAudioStore.getState().layers.bgm.loadError).toBeNull()
    expect(useAudioStore.getState().layers.bgm.hash).toBe("new")
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
