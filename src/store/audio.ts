// The audio family: what is playing on each layer, and the mixer over it.
//
// The wire half is three frames (`docs/protocol.md`):
//   - `audio_library_item` — a room library entry (the media store keeps those);
//   - `audio_control` — playback INTENT for local clients: play/stop/pause/
//     resume/volume on one of three layers, with `hash` naming the blob to
//     fetch over the media byte channel;
//   - `audio_state` — the best-effort persisted BGM/ambience state, replayed on
//     join, so a client that arrives mid-scene starts in the right place.
//
// This store owns the STATE. The element that actually makes sound lives in the
// player component: browsers tie playback to a user gesture, so an autoplay
// attempt before the first interaction fails — silently, in most engines. That
// is handled rather than ignored: `unlocked` starts false, the UI offers the
// one click that flips it, and everything queued until then starts on that
// click instead of being lost.

import { create } from "zustand"
import type { AudioControlFrame, AudioLayer, AudioLayerState, ServerFrame } from "@loreweaver/protocol"

export const AUDIO_LAYERS: AudioLayer[] = ["bgm", "ambience", "sfx"]

/** One layer's live state — the wire's `AudioLayerState` plus what the local
 * mixer decides (mute is a listener's choice and never leaves this client). */
export interface LayerState extends AudioLayerState {
  /** Local mute. Independent of `volume`, so unmuting restores the level. */
  muted: boolean
  /** Local volume 0..1, applied on top of the server's. */
  gain: number
  /** Set when a play arrived before the webview would allow sound. */
  waitingForUnlock: boolean
}

function emptyLayer(layer: AudioLayer): LayerState {
  return { layer, playing: false, muted: false, gain: 1, waitingForUnlock: false }
}

interface AudioState {
  layers: Record<AudioLayer, LayerState>
  /** False until a user gesture has let this webview make sound. */
  unlocked: boolean
  /** Master mute, over every layer. */
  muted: boolean

  ingest: (frame: ServerFrame) => boolean
  /** Record the first user gesture: everything that was waiting starts. */
  unlock: () => void
  setMuted: (muted: boolean) => void
  setLayerMuted: (layer: AudioLayer, muted: boolean) => void
  setLayerGain: (layer: AudioLayer, gain: number) => void
  reset: () => void
}

function initialLayers(): Record<AudioLayer, LayerState> {
  return { bgm: emptyLayer("bgm"), ambience: emptyLayer("ambience"), sfx: emptyLayer("sfx") }
}

/** Apply one `audio_control` to a layer.
 *
 * `volume` is an adjustment, not a transport action: it must not start or stop
 * anything. Everything else moves `playing`, and `play` additionally replaces
 * which blob the layer is on. */
export function applyControl(current: LayerState, frame: AudioControlFrame, unlocked: boolean): LayerState {
  const next: LayerState = { ...current, layer: frame.layer }
  if (frame.volume !== undefined) next.volume = frame.volume
  if (frame.loop !== undefined) next.loop = frame.loop
  switch (frame.action) {
    case "play":
      return {
        ...next,
        hash: frame.hash ?? next.hash,
        mime: frame.mime ?? next.mime,
        name: frame.name ?? next.name,
        title: frame.title ?? next.title,
        playing: true,
        started_at: frame.server_ts ?? next.started_at,
        // Remember the intent rather than dropping it: the browser will let us
        // start after the first gesture, and a lost BGM cue is a scene the
        // author staged that nobody heard.
        waitingForUnlock: !unlocked,
      }
    case "stop":
      return { ...next, playing: false, hash: undefined, waitingForUnlock: false }
    case "pause":
      return { ...next, playing: false, waitingForUnlock: false }
    case "resume":
      return { ...next, playing: true, waitingForUnlock: !unlocked }
    case "volume":
      return next
  }
}

export const useAudioStore = create<AudioState>()((set) => ({
  layers: initialLayers(),
  unlocked: false,
  muted: false,

  ingest: (frame) => {
    switch (frame.type) {
      case "audio_control":
        set((state) => ({
          layers: {
            ...state.layers,
            [frame.layer]: applyControl(state.layers[frame.layer], frame, state.unlocked),
          },
        }))
        return true
      case "audio_state":
        // The replayed snapshot is authoritative about the SERVER's half and
        // silent about the local mixer, so local choices survive a reconnect.
        set((state) => {
          const layers = initialLayers()
          for (const layer of AUDIO_LAYERS) {
            layers[layer] = {
              ...layers[layer],
              muted: state.layers[layer].muted,
              gain: state.layers[layer].gain,
            }
          }
          for (const wire of frame.layers) {
            const local = layers[wire.layer] ?? emptyLayer(wire.layer)
            layers[wire.layer] = {
              ...local,
              ...wire,
              waitingForUnlock: wire.playing && !state.unlocked,
            }
          }
          return { layers }
        })
        return true
      default:
        return false
    }
  },

  unlock: () =>
    set((state) => {
      const layers = { ...state.layers }
      for (const layer of AUDIO_LAYERS) {
        layers[layer] = { ...layers[layer], waitingForUnlock: false }
      }
      return { unlocked: true, layers }
    }),

  setMuted: (muted) => set({ muted }),

  setLayerMuted: (layer, muted) =>
    set((state) => ({ layers: { ...state.layers, [layer]: { ...state.layers[layer], muted } } })),

  setLayerGain: (layer, gain) =>
    set((state) => ({
      layers: {
        ...state.layers,
        [layer]: { ...state.layers[layer], gain: Math.max(0, Math.min(1, gain)) },
      },
    })),

  reset: () => set({ layers: initialLayers(), muted: false }),
}))

/** The effective volume for a layer: the server's level, the listener's own,
 * and both mutes. Kept out of the component so it is testable. */
export function effectiveVolume(layer: LayerState, masterMuted: boolean): number {
  if (masterMuted || layer.muted) return 0
  const wire = typeof layer.volume === "number" ? Math.max(0, Math.min(1, layer.volume)) : 1
  return wire * layer.gain
}
