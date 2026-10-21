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
// (`waitingForUnlock`) and the UI say so. Gating on our own "has the player
// clicked our button" flag instead left the sound off for players whose
// webview would have allowed it all along.
//
// "Refuses" is not always a rejection. WebKit (WKWebView, so Tauri on macOS)
// answers a blocked `play()` with a promise that NEVER settles — no
// NotAllowedError — and leaves the element paused. So a play still unsettled
// and still paused after a short grace counts as refused too.
//
// And the retry must happen INSIDE the gesture. A React effect runs after the
// event, where the same `play()` is blocked again, so the gesture handler
// (`unlockFromGesture`) calls `play()` itself on every live element that
// should be sounding, then records the unlock. Nothing queued is lost.

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
  /** This layer's play() went through after all: stop saying it is waiting. */
  markAudible: (layer: AudioLayer) => void
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
      // The gesture listener calls this on every click and key press for the
      // life of the window; with nothing to change it must not re-render the deck.
      if (state.unlocked && !AUDIO_LAYERS.some((layer) => state.layers[layer].waitingForUnlock)) return state
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

  markAudible: (layer) =>
    set((state) => {
      const current = state.layers[layer]
      if (!current.waitingForUnlock) return state
      return { layers: { ...state.layers, [layer]: { ...current, waitingForUnlock: false } } }
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

/** How long a `play()` may stay unsettled with its element still paused before
 * it counts as refused. WebKit never rejects a blocked play — see the header. */
export const PLAY_GRACE_MS = 800

/** The `<audio>` element each layer is playing through right now. The gesture
 * handler needs them to call `play()` synchronously, which a React effect
 * cannot do. */
const liveElements = new Map<AudioLayer, HTMLAudioElement>()
const graceTimers = new Map<HTMLAudioElement, ReturnType<typeof setTimeout>>()

function dropGrace(audio: HTMLAudioElement) {
  const timer = graceTimers.get(audio)
  if (timer === undefined) return
  clearTimeout(timer)
  graceTimers.delete(audio)
}

/** Record the element a layer plays through; the disposer forgets it (and its
 * pending grace timer) when the element goes. */
export function registerLayerElement(layer: AudioLayer, audio: HTMLAudioElement): () => void {
  liveElements.set(layer, audio)
  return () => {
    dropGrace(audio)
    if (liveElements.get(layer) === audio) liveElements.delete(layer)
  }
}

/** Stop waiting on an element's last play() — it was paused or replaced. */
export function cancelPlay(audio: HTMLAudioElement) {
  dropGrace(audio)
}

/** Call `play()` and watch for the webview saying no, in either of its voices:
 * a NotAllowedError rejection (or a throw), or no answer at all while the
 * element stays paused. An AbortError is a pause or a newer source interrupting
 * this attempt, not a policy. */
export function attemptPlay(layer: AudioLayer, audio: HTMLAudioElement): void {
  dropGrace(audio)
  const timer = setTimeout(() => {
    graceTimers.delete(audio)
    // `ended` also reads as paused: a short one-shot that already finished is
    // not a refusal.
    if (audio.paused && !audio.ended && !audio.error) blocked()
  }, PLAY_GRACE_MS)
  graceTimers.set(audio, timer)
  const settle = () => {
    clearTimeout(timer)
    if (graceTimers.get(audio) === timer) graceTimers.delete(audio)
  }
  const blocked = () => {
    settle()
    if (liveElements.get(layer) === audio) useAudioStore.getState().markBlocked(layer)
  }
  try {
    const attempt = audio.play()
    if (attempt !== undefined && typeof attempt.then === "function") {
      attempt.then(
        () => {
          settle()
          if (liveElements.get(layer) === audio) useAudioStore.getState().markAudible(layer)
        },
        (cause: unknown) => {
          if ((cause as { name?: unknown } | null)?.name === "NotAllowedError") blocked()
          else settle()
        },
      )
    }
  } catch {
    // jsdom (and some webviews) throw instead of returning a rejected promise.
    // Either way the element stays paused, and the player is told.
    blocked()
  }
}

/** Start every layer that should be sounding but is paused. Call it from inside
 * a user gesture: that is the only place the webview will say yes. */
export function playWaitingLayers(): void {
  const { layers } = useAudioStore.getState()
  for (const layer of AUDIO_LAYERS) {
    const audio = liveElements.get(layer)
    if (audio === undefined || !layers[layer].playing) continue
    // A one-shot that played out is paused too, and `play()` would restart it.
    if (audio.paused && !audio.ended && !audio.error) attemptPlay(layer, audio)
  }
}

/** What a gesture does for sound: ask for it right here, then record the unlock.
 * The same call serves the window listener and both "turn sound on" buttons. */
export function unlockFromGesture(): void {
  playWaitingLayers()
  useAudioStore.getState().unlock()
}

// The events a webview counts as user activation (WebKit: click, keydown,
// mouseup/pointerup, touchend). `pointerdown` is not one of them for a mouse.
const GESTURE_EVENTS = ["click", "keydown", "pointerup", "touchend"] as const

let disarmGesture: (() => void) | null = null

/** Let sound start on a user gesture anywhere in the window, not only on the
 * audio card's own button.
 *
 * Capture phase, so nothing in the app can swallow it. It stays armed rather
 * than firing once: WebKit grants the permission per element and a later cue
 * brings a new element, so a gesture that came before the cue must not be the
 * last one that counts. Idempotent while armed. Returns the disposer. */
export function armGestureUnlock(): () => void {
  if (disarmGesture !== null) return disarmGesture
  const fire = () => unlockFromGesture()
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
