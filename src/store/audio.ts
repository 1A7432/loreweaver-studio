// Where the room's sound lives in the app: the listener's own mix (mute, a volume per layer —
// persisted like the other UI preferences, never sent anywhere), the one `AudioController` of the
// current connection (`features/play/audio.ts`, outside React), and the window-wide gesture that
// lets a WebView that refused sound start it after all. What plays is the session's; nothing
// here keeps a copy of the `audio` view.

import { useSyncExternalStore } from "react"
import { create } from "zustand"
import { persist } from "zustand/middleware"
import { guardedLocalStorage } from "../lib/persistStorage"
import type { Connection } from "../lib/connection"
import { cachedAudioUrl } from "../features/play/audioPlayback"
import {
  AudioController,
  FULL_MIX,
  type AudioElement,
  type AudioLayer,
  type AudioLocalState,
  type AudioMix,
} from "../features/play/audio"

interface MixState extends AudioMix {
  setMuted: (muted: boolean) => void
  setGain: (layer: AudioLayer, gain: number) => void
}

export const useAudioMixStore = create<MixState>()(
  persist(
    (set) => ({
      ...FULL_MIX,
      setMuted: (muted) => set({ muted }),
      setGain: (layer, gain) =>
        set((state) => ({ gain: { ...state.gain, [layer]: Math.max(0, Math.min(1, gain)) } })),
    }),
    {
      name: "loreweaver-studio-audio",
      storage: guardedLocalStorage,
      partialize: (state) => ({ muted: state.muted, gain: state.gain }),
    },
  ),
)

interface AudioSlot {
  controller: AudioController | null
}

/** The controller of the current connection, or none. Holds the REFERENCE only. */
export const useAudioSlot = create<AudioSlot>(() => ({ controller: null }))

function mixOf(state: AudioMix): AudioMix {
  return { muted: state.muted, gain: state.gain }
}

useAudioMixStore.subscribe((state) => useAudioSlot.getState().controller?.setMix(mixOf(state)))

/** Start the sound of a new connection (stopping the last one's). */
export function startAudio(
  connection: Connection,
  createElement: () => AudioElement = () => new Audio(),
): AudioController {
  useAudioSlot.getState().controller?.dispose()
  const controller = new AudioController({
    session: connection.session,
    load: cachedAudioUrl,
    release: (url) => URL.revokeObjectURL(url),
    createElement,
    mix: mixOf(useAudioMixStore.getState()),
    want: (names) => connection.want(names),
  })
  useAudioSlot.setState({ controller })
  return controller
}

const QUIET: AudioLocalState = Object.freeze({ blocked: false, failed: [] })
const noSubscription = () => () => undefined
const quiet = () => QUIET

/** The current controller's own state (blocked, failed layers); quiet when there is none. */
export function useAudioLocal(): AudioLocalState {
  const controller = useAudioSlot((slot) => slot.controller)
  return useSyncExternalStore(
    controller ? controller.subscribe : noSubscription,
    controller ? controller.getState : quiet,
  )
}

/** What a gesture does for sound: ask for it right here. */
export function unlockFromGesture(): void {
  useAudioSlot.getState().controller?.unlock()
}

// The events a WebView counts as user activation (WebKit: click, keydown, mouseup/pointerup,
// touchend). `pointerdown` is not one of them for a mouse.
const GESTURE_EVENTS = ["click", "keydown", "pointerup", "touchend"] as const

let disarmGesture: (() => void) | null = null

/** Let sound start on a gesture anywhere in the window. Capture phase, so nothing in the app
 * can swallow it; it stays armed, because a later sound brings a new element. Idempotent while
 * armed. Returns the disposer. */
export function armGestureUnlock(): () => void {
  if (disarmGesture !== null) return disarmGesture
  const fire = () => {
    if (useAudioSlot.getState().controller?.getState().blocked) unlockFromGesture()
  }
  const disarm = () => {
    for (const type of GESTURE_EVENTS) window.removeEventListener(type, fire, true)
    disarmGesture = null
  }
  for (const type of GESTURE_EVENTS) window.addEventListener(type, fire, true)
  disarmGesture = disarm
  return disarm
}
