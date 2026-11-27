// The room's sound (protocol 3.0 §9.4 `audio` signal, §10.4 `audio` view), played through the
// WebView's own audio elements. Modelled on the terminal client's controller.
//
// The view is the state, the signal is the transition. The controller starts what the `audio`
// view says plays whenever a new value of it arrives (every connect and reconnect brings one),
// follows the `audio` signals in between, and takes the view as the truth again after a `reset`
// of scope `all` (which stops every layer). Starting from a view is idempotent: a layer already
// playing the sound the view names keeps playing, so a reconnect does not restart the music. A
// session that ends (left, refused, given up on) stops everything.
//
// It lives outside React and holds only what this client owns: the elements it started, the
// fades under way, the local mix (mute and a volume per layer, applied on top of the room's),
// and whether the WebView refused to start sound before a gesture. What plays is read from the
// session. `fadeMs` is done for real here: the element's volume is stepped to its target.
//
// Autoplay is handled, not hoped for. A WebView may refuse `play()` before the person has
// interacted with the window: a `NotAllowedError`, a throw, or — in WebKit, which never rejects
// — a play that stays unsettled with the element still paused. Any of these marks the
// controller `blocked`; `unlock()`, called from INSIDE a gesture (a React effect would run too
// late), calls `play()` again on every element that should be sounding.

import type {
  AudioView,
  HeldView,
  Session,
  SignalFrame,
  SignalPayloads,
  Timers,
} from "loreweaver-protocol/v3"
import { builtInView } from "loreweaver-protocol/v3"

export type AudioLayer = SignalPayloads["audio"]["layer"]
/** The layers that hold one sound each; `sfx` is one-shot. */
export type LoopLayer = Exclude<AudioLayer, "sfx">
export const AUDIO_LAYERS: readonly AudioLayer[] = ["bgm", "ambience", "sfx"]
export const LOOP_LAYERS: readonly LoopLayer[] = ["bgm", "ambience"]

/** The part of an `HTMLAudioElement` the controller drives; a fake in tests. */
export interface AudioElement {
  src: string
  loop: boolean
  volume: number
  readonly paused: boolean
  readonly ended: boolean
  readonly error: unknown
  play(): Promise<void> | void
  pause(): void
  load(): void
  removeAttribute(name: string): void
  addEventListener(type: "ended" | "error", listener: () => void): void
}

/** The listener's own mix, kept in UI state and never sent anywhere. */
export interface AudioMix {
  readonly muted: boolean
  /** 0..1 per layer, applied on top of the room's volume. */
  readonly gain: Readonly<Record<AudioLayer, number>>
}

export const FULL_MIX: AudioMix = { muted: false, gain: { bgm: 1, ambience: 1, sfx: 1 } }

/** What the UI reads of the controller. */
export interface AudioLocalState {
  /** The WebView refused to start a sound: a gesture (or the unlock button) is needed. */
  readonly blocked: boolean
  /** Layers whose sound could not be fetched or played; `retry` tries again. */
  readonly failed: readonly LoopLayer[]
}

/** What the controller reads of the session. */
export type AudioSession = Pick<Session, "subscribe" | "getSnapshot" | "onSignal">

export interface AudioControllerOptions {
  readonly session: AudioSession
  /** A playable URL for the sound `hash` (verified against its hash on the way). */
  readonly load: (hash: string, mime: string) => Promise<string>
  /** Let go of a URL `load` made. */
  readonly release?: (url: string) => void
  readonly createElement: () => AudioElement
  readonly timers?: Timers
  readonly now?: () => number
  readonly mix?: AudioMix
  /** Hold the `audio` view subscribed for the controller's life; answers the release. */
  readonly want?: (names: readonly string[]) => () => void
}

/** How long a `play()` may stay unsettled with its element still paused before it counts as
 * refused. WebKit never rejects a blocked play. */
export const PLAY_GRACE_MS = 800
/** One step of a fade. */
export const FADE_STEP_MS = 50

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

interface Fade {
  timer: unknown
}

interface Track {
  readonly layer: AudioLayer
  readonly hash: string
  readonly mime: string
  loop: boolean
  /** The room's volume, 0..1. */
  volume: number
  paused: boolean
  /** A fade's own multiplier, 0..1 (1 when no fade is under way). */
  level: number
  failed: boolean
  url?: string
  element?: AudioElement
  fade?: Fade
  grace?: unknown
  /** Torn down: late callbacks for it do nothing. */
  gone: boolean
}

interface Wanted {
  readonly hash: string
  readonly mime: string
  readonly loop: boolean
  readonly volume: number
  readonly paused: boolean
}

const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

export class AudioController {
  readonly #session: AudioSession
  readonly #load: (hash: string, mime: string) => Promise<string>
  readonly #release: (url: string) => void
  readonly #create: () => AudioElement
  readonly #timers: Timers
  readonly #now: () => number
  readonly #layers = new Map<LoopLayer, Track>()
  readonly #sfx = new Set<Track>()
  readonly #listeners = new Set<() => void>()
  readonly #off: Array<() => void> = []
  #mix: AudioMix
  #state: AudioLocalState = { blocked: false, failed: [] }
  #lastView: HeldView<AudioView> | null = null
  #lastResetSeq = 0
  /** A view older than the last reset of `all` is not the truth any more. */
  #resetAt = 0
  #disposed = false

  constructor(options: AudioControllerOptions) {
    this.#session = options.session
    this.#load = options.load
    this.#release = options.release ?? (() => undefined)
    this.#create = options.createElement
    this.#timers = options.timers ?? GLOBAL_TIMERS
    this.#now = options.now ?? Date.now
    this.#mix = options.mix ?? FULL_MIX
    if (options.want) this.#off.push(options.want(["audio"]))
    this.#off.push(this.#session.subscribe(this.#onSnapshot))
    this.#off.push(this.#session.onSignal(this.#onSignal))
    this.#onSnapshot()
  }

  // --- the local store -------------------------------------------------------------------------

  getState = (): AudioLocalState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #set(patch: Partial<AudioLocalState>): void {
    const next = { ...this.#state, ...patch }
    if (next.blocked === this.#state.blocked && sameLayers(next.failed, this.#state.failed)) return
    this.#state = next
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        // a listener's failure is its own
      }
    }
  }

  #markFailed(layer: LoopLayer, failed: boolean): void {
    const others = this.#state.failed.filter((entry) => entry !== layer)
    this.#set({ failed: failed ? [...others, layer] : others })
  }

  // --- controls --------------------------------------------------------------------------------

  /** The listener's mix changed: every element follows at once. */
  setMix(mix: AudioMix): void {
    this.#mix = mix
    for (const track of this.#tracks()) this.#applyVolume(track)
  }

  /**
   * Call from inside a user gesture: start every element that should be sounding and is not.
   * That is the one place a WebView that refused sound will say yes.
   */
  unlock(): void {
    if (this.#disposed) return
    this.#set({ blocked: false })
    for (const track of this.#layers.values()) {
      const element = track.element
      if (element === undefined || track.paused) continue
      if (element.paused && !element.ended) this.#attempt(track)
    }
  }

  /** Fetch and start a layer again after it failed. */
  retry(layer: LoopLayer): void {
    const track = this.#layers.get(layer)
    if (track === undefined || !track.failed || this.#disposed) return
    track.failed = false
    this.#markFailed(layer, false)
    void this.#prepare(track)
  }

  /** Stop everything and stop listening. Also what an ended session does by itself. */
  dispose(): void {
    if (this.#disposed) return
    this.#stopAll()
    this.#disposed = true
    for (const off of this.#off.splice(0)) off()
  }

  /** Elements sounding or loading now (for tests and diagnostics). */
  get active(): number {
    return this.#layers.size + this.#sfx.size
  }

  // --- the session -----------------------------------------------------------------------------

  #onSnapshot = (): void => {
    if (this.#disposed) return
    const snapshot = this.#session.getSnapshot()
    if (snapshot.status === "ended") {
      this.dispose()
      return
    }
    // A reset of `all` clears what the room plays; the views that follow say what plays now.
    for (const event of snapshot.events) {
      if (event.kind !== "reset" || event.seq <= this.#lastResetSeq) continue
      this.#lastResetSeq = event.seq
      if (event.data.scope === "all") {
        this.#resetAt = event.seq
        this.#stopAll()
      }
    }
    const held = builtInView(snapshot, "audio")
    if (held !== this.#lastView) {
      this.#lastView = held
      if (held !== null && held.at >= this.#resetAt) this.#reconcile(held.data)
    }
  }

  #onSignal = (frame: SignalFrame): void => {
    if (frame.kind !== "audio" || this.#disposed) return
    const signal = frame.data
    const fadeMs = signal.fadeMs ?? 0
    if (signal.layer === "sfx") {
      if (signal.action === "play" && signal.hash && signal.mime) {
        this.#playSfx(signal.hash, signal.mime, clamp01(signal.volume ?? 1))
      } else if (signal.action === "stop") {
        for (const track of [...this.#sfx]) this.#stop(track, fadeMs)
      }
      return
    }
    const layer = signal.layer
    const current = this.#layers.get(layer)
    switch (signal.action) {
      case "play":
        if (signal.hash && signal.mime) {
          const wanted = {
            hash: signal.hash,
            mime: signal.mime,
            loop: signal.loop ?? true,
            volume: clamp01(signal.volume ?? 1),
            paused: false,
          }
          this.#apply(layer, wanted, true, fadeMs)
        }
        return
      case "stop":
        if (current) {
          this.#layers.delete(layer)
          this.#markFailed(layer, false)
          this.#stop(current, fadeMs)
        }
        return
      case "pause":
        if (current) this.#setPaused(current, true, fadeMs)
        return
      case "resume":
        if (current) this.#setPaused(current, false, fadeMs)
        return
      case "volume":
        if (current && typeof signal.volume === "number")
          this.#setVolume(current, clamp01(signal.volume), fadeMs)
        return
    }
  }

  #reconcile(view: AudioView): void {
    for (const layer of LOOP_LAYERS) {
      const wanted = view.playing[layer]
      if (wanted === undefined) {
        const current = this.#layers.get(layer)
        if (current) {
          this.#layers.delete(layer)
          this.#markFailed(layer, false)
          this.#stop(current, 0)
        }
      } else {
        this.#apply(
          layer,
          {
            hash: wanted.hash,
            mime: wanted.mime,
            loop: wanted.loop,
            volume: clamp01(wanted.volume),
            paused: wanted.paused,
          },
          false,
          0,
        )
      }
    }
  }

  // --- layers ----------------------------------------------------------------------------------

  /** Make `layer` play `wanted`. Unless `restart`, a layer already on the same sound is only adjusted. */
  #apply(layer: LoopLayer, wanted: Wanted, restart: boolean, fadeMs: number): void {
    const current = this.#layers.get(layer)
    if (!restart && current !== undefined && current.hash === wanted.hash && !current.failed) {
      current.loop = wanted.loop
      if (current.element) current.element.loop = wanted.loop
      if (current.volume !== wanted.volume) this.#setVolume(current, wanted.volume, 0)
      if (current.paused !== wanted.paused) this.#setPaused(current, wanted.paused, 0)
      return
    }
    if (current !== undefined) this.#stop(current, 0)
    this.#markFailed(layer, false)
    const track: Track = {
      layer,
      hash: wanted.hash,
      mime: wanted.mime,
      loop: wanted.loop,
      volume: wanted.volume,
      paused: wanted.paused,
      level: fadeMs > 0 ? 0 : 1,
      failed: false,
      gone: false,
    }
    this.#layers.set(layer, track)
    void this.#prepare(track, fadeMs)
  }

  async #prepare(track: Track, fadeMs = 0): Promise<void> {
    let url: string
    try {
      url = await this.#load(track.hash, track.mime)
    } catch {
      if (track.gone || this.#disposed) return
      track.failed = true
      if (track.layer !== "sfx") this.#markFailed(track.layer, true)
      else this.#sfx.delete(track)
      return
    }
    if (track.gone || this.#disposed) {
      this.#release(url)
      return
    }
    track.url = url
    const element = this.#create()
    element.loop = track.loop
    element.src = url
    element.addEventListener("error", () => {
      if (track.gone || track.element !== element) return
      track.failed = true
      if (track.layer === "sfx") this.#stop(track, 0)
      else this.#markFailed(track.layer, true)
    })
    if (track.layer === "sfx") {
      element.addEventListener("ended", () => this.#stop(track, 0))
    }
    track.element = element
    this.#applyVolume(track)
    if (track.paused) return
    this.#attempt(track)
    if (fadeMs > 0) this.#fade(track, "level", 1, fadeMs)
  }

  #attempt(track: Track): void {
    const element = track.element
    if (element === undefined) return
    this.#clearGrace(track)
    const refused = () => {
      this.#clearGrace(track)
      if (track.gone) return
      // A one-shot refused before a gesture is past its moment: it is not played later.
      if (track.layer === "sfx") this.#stop(track, 0)
      this.#set({ blocked: true })
    }
    track.grace = this.#timers.setTimeout(() => {
      track.grace = undefined
      if (!track.gone && element.paused && !element.ended && !element.error && !track.paused) refused()
    }, PLAY_GRACE_MS)
    try {
      const attempt = element.play()
      if (attempt !== undefined && typeof attempt.then === "function") {
        attempt.then(
          () => this.#clearGrace(track),
          (cause: unknown) => {
            if ((cause as { name?: unknown } | null)?.name === "NotAllowedError") refused()
            else this.#clearGrace(track)
          },
        )
      }
    } catch {
      refused()
    }
  }

  #clearGrace(track: Track): void {
    if (track.grace !== undefined) this.#timers.clearTimeout(track.grace)
    track.grace = undefined
  }

  #setPaused(track: Track, paused: boolean, fadeMs: number): void {
    track.paused = paused
    const element = track.element
    if (element === undefined) {
      // Not loaded yet: it starts (or not) when it is.
      return
    }
    if (paused) {
      this.#clearGrace(track)
      if (fadeMs > 0) this.#fade(track, "level", 0, fadeMs, () => element.pause())
      else {
        this.#cancelFade(track)
        element.pause()
      }
      return
    }
    if (fadeMs > 0) {
      track.level = 0
      this.#applyVolume(track)
      this.#attempt(track)
      this.#fade(track, "level", 1, fadeMs)
    } else {
      this.#cancelFade(track)
      track.level = 1
      this.#applyVolume(track)
      this.#attempt(track)
    }
  }

  #setVolume(track: Track, volume: number, fadeMs: number): void {
    if (fadeMs > 0) this.#fade(track, "volume", volume, fadeMs)
    else {
      this.#cancelFade(track)
      track.volume = volume
      this.#applyVolume(track)
    }
  }

  /** Stop a track: at once, or after fading it out. It is already out of the layer map. */
  #stop(track: Track, fadeMs: number): void {
    if (track.gone) return
    if (fadeMs > 0 && track.element !== undefined && !track.element.paused) {
      this.#fade(track, "level", 0, fadeMs, () => this.#teardown(track))
      return
    }
    this.#teardown(track)
  }

  #teardown(track: Track): void {
    if (track.gone) return
    track.gone = true
    this.#cancelFade(track)
    this.#clearGrace(track)
    this.#sfx.delete(track)
    const element = track.element
    if (element !== undefined) {
      element.pause()
      element.removeAttribute("src")
      element.load()
    }
    track.element = undefined
    if (track.url !== undefined) this.#release(track.url)
    track.url = undefined
  }

  #stopAll(): void {
    for (const layer of LOOP_LAYERS) {
      const track = this.#layers.get(layer)
      if (track === undefined) continue
      this.#layers.delete(layer)
      this.#teardown(track)
    }
    for (const track of [...this.#sfx]) this.#teardown(track)
    this.#set({ failed: [] })
  }

  #playSfx(hash: string, mime: string, volume: number): void {
    const track: Track = {
      layer: "sfx",
      hash,
      mime,
      loop: false,
      volume,
      paused: false,
      level: 1,
      failed: false,
      gone: false,
    }
    this.#sfx.add(track)
    void this.#prepare(track)
  }

  // --- volume and fades ------------------------------------------------------------------------

  #tracks(): Track[] {
    return [...this.#layers.values(), ...this.#sfx]
  }

  #applyVolume(track: Track): void {
    const element = track.element
    if (element === undefined) return
    const gain = this.#mix.muted ? 0 : clamp01(this.#mix.gain[track.layer])
    element.volume = clamp01(track.volume * track.level * gain)
  }

  /** Step `key` of the track to `to` over `ms`, then run `done`. A new fade replaces the old one. */
  #fade(track: Track, key: "level" | "volume", to: number, ms: number, done?: () => void): void {
    this.#cancelFade(track)
    const from = track[key]
    const start = this.#now()
    const fade: Fade = { timer: undefined }
    const step = () => {
      if (track.gone || track.fade !== fade) return
      const progress = Math.min(1, (this.#now() - start) / ms)
      track[key] = from + (to - from) * progress
      this.#applyVolume(track)
      if (progress >= 1) {
        track.fade = undefined
        done?.()
        return
      }
      fade.timer = this.#timers.setTimeout(step, FADE_STEP_MS)
    }
    track.fade = fade
    fade.timer = this.#timers.setTimeout(step, FADE_STEP_MS)
  }

  #cancelFade(track: Track): void {
    if (track.fade === undefined) return
    this.#timers.clearTimeout(track.fade.timer)
    track.fade = undefined
    // A fade cut short leaves its multiplier where it was heading.
    if (track.level !== 1 && !track.paused) {
      track.level = 1
      this.#applyVolume(track)
    }
  }
}

function sameLayers(a: readonly LoopLayer[], b: readonly LoopLayer[]): boolean {
  return a.length === b.length && a.every((layer) => b.includes(layer))
}
