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
// attempt before the first interaction can fail — silently, in most engines.
// That is handled rather than ignored, and without guessing: the player ALWAYS
// tries to play, and only when the webview refuses does the layer wait
// (`waitingForUnlock`) and the UI say so. The first gesture anywhere in the
// window (`armGestureUnlock`), or the one click on the notice, retries
// everything that was waiting — nothing queued is lost. Gating on our own
// "has the player clicked our button" flag instead left the sound off for
// players whose webview would have allowed it all along.

import { create } from "zustand"
import type { AudioControlFrame, AudioLayer, AudioLayerState, ServerFrame } from "@loreweaver/protocol"

export const AUDIO_LAYERS: AudioLayer[] = ["bgm", "ambience", "sfx"]

/** Why one layer failed to load — a REASON the UI translates, never a message.
 * `fetch` covers everything before the bytes are playable (not cached, over the
 * client cap, verification refused); `decode` is the element rejecting bytes it
 * did receive. An English cause string stored here would reach the listener
 * untranslated, so the raw cause goes to the console and only the reason is
 * kept. */
export type LayerLoadError = "fetch" | "decode"

/** One layer's live state — the wire's `AudioLayerState` plus what the local
 * mixer decides (mute is a listener's choice and never leaves this client). */
export interface LayerState extends AudioLayerState {
  /** Local mute. Independent of `volume`, so unmuting restores the level. */
  muted: boolean
  /** Local volume 0..1, applied on top of the server's. */
  gain: number
  /** Set when the webview refused to start this layer's sound. */
  waitingForUnlock: boolean
  /** Fetch/read/decode failure for THIS layer only. Null when the layer is
   * silent or the last load succeeded. A failure on one layer never writes
   * the others. */
  loadError: LayerLoadError | null
  /** Bumped to retrigger the player effect (explicit retry, or a play of
   * the same hash). Not a wire field. */
  loadEpoch: number
}

function emptyLayer(layer: AudioLayer): LayerState {
  return {
    layer,
    playing: false,
    muted: false,
    gain: 1,
    waitingForUnlock: false,
    loadError: null,
    loadEpoch: 0,
  }
}

interface AudioState {
  layers: Record<AudioLayer, LayerState>
  /** False until a user gesture has been seen in this window. It does not gate
   * playback — the player tries regardless; it only re-runs that attempt. */
  unlocked: boolean
  /** Master mute, over every layer. */
  muted: boolean

  ingest: (frame: ServerFrame) => boolean
  /** Record a user gesture: everything that was waiting is retried. */
  unlock: () => void
  /** The webview refused to start this layer: remember the cue and say so. */
  markBlocked: (layer: AudioLayer) => void
  setMuted: (muted: boolean) => void
  setLayerMuted: (layer: AudioLayer, muted: boolean) => void
  setLayerGain: (layer: AudioLayer, gain: number) => void
  /** Record a fetch/read/decode failure on one layer. */
  setLayerLoadError: (layer: AudioLayer, error: LayerLoadError | null) => void
  /** Clear that layer's error and bump `loadEpoch` so the player retries. */
  retryLayer: (layer: AudioLayer) => void
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
export function applyControl(current: LayerState, frame: AudioControlFrame): LayerState {
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
        // Optimistic: the player tries, and marks the layer waiting only if
        // the webview refuses. A refused cue is remembered rather than dropped
        // (a lost BGM cue is a scene the author staged that nobody heard).
        waitingForUnlock: false,
        // A new play is a natural retry: drop a stale error on THIS layer
        // (only) and bump the epoch so the player refetches even when the
        // hash did not change.
        loadError: null,
        loadEpoch: next.loadEpoch + 1,
      }
    case "stop":
      return { ...next, playing: false, hash: undefined, waitingForUnlock: false, loadError: null }
    case "pause":
      return { ...next, playing: false, waitingForUnlock: false }
    case "resume":
      return { ...next, playing: true, waitingForUnlock: false }
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
            [frame.layer]: applyControl(state.layers[frame.layer], frame),
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
            const previous = state.layers[wire.layer]
            const sameHash = previous?.hash === wire.hash
            layers[wire.layer] = {
              ...local,
              ...wire,
              waitingForUnlock: false,
              // A new blob is a fresh load; the same blob keeps a transient
              // error so a reconnect does not hide a failure the listener
              // has not retried. Other layers stay on emptyLayer (no error).
              loadError: sameHash && previous ? previous.loadError : null,
              loadEpoch: sameHash && previous ? previous.loadEpoch : 0,
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

  markBlocked: (layer) =>
    set((state) => {
      const current = state.layers[layer]
      // Already waiting (or stopped since): nothing to say, and no new object —
      // the player's effect re-runs on every layer change, so a write here that
      // changed nothing would feed straight back into another refused attempt.
      if (!current.playing || current.waitingForUnlock) return state
      return { layers: { ...state.layers, [layer]: { ...current, waitingForUnlock: true } } }
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

  setLayerLoadError: (layer, error) =>
    set((state) => ({
      layers: { ...state.layers, [layer]: { ...state.layers[layer], loadError: error } },
    })),

  retryLayer: (layer) =>
    set((state) => ({
      layers: {
        ...state.layers,
        [layer]: {
          ...state.layers[layer],
          loadError: null,
          loadEpoch: state.layers[layer].loadEpoch + 1,
        },
      },
    })),

  reset: () => set({ layers: initialLayers(), muted: false }),
}))

const GESTURE_EVENTS = ["pointerdown", "keydown"] as const

let disarmGesture: (() => void) | null = null

/** Unlock on the first real user gesture anywhere in the window.
 *
 * Capture phase, so nothing in the app can swallow it; once, so it removes
 * itself after firing. A webview treats ANY gesture as user activation, which
 * is why the audio card's own button is not the only way in. Idempotent while
 * armed, and a no-op once a gesture has already been seen. Returns the
 * disposer. */
export function armGestureUnlock(): () => void {
  if (disarmGesture !== null) return disarmGesture
  if (useAudioStore.getState().unlocked) return () => undefined
  const fire = () => {
    disarm()
    useAudioStore.getState().unlock()
  }
  const disarm = () => {
    for (const type of GESTURE_EVENTS) window.removeEventListener(type, fire, true)
    disarmGesture = null
  }
  for (const type of GESTURE_EVENTS) window.addEventListener(type, fire, true)
  disarmGesture = disarm
  return disarm
}

/** The effective volume for a layer: the server's level, the listener's own,
 * and both mutes. Kept out of the component so it is testable. */
export function effectiveVolume(layer: LayerState, masterMuted: boolean): number {
  if (masterMuted || layer.muted) return 0
  const wire = typeof layer.volume === "number" ? Math.max(0, Math.min(1, layer.volume)) : 1
  return wire * layer.gain
}
