// The thing that actually makes sound, plus the listener's mixer.
//
// One `<audio>` element per layer, fed from the same verified cache the picture
// path uses: `audio_control` names a blob by hash, `assetFetch` pulls it over
// the media byte channel and stores it under its sha256, and `assetReadBase64`
// hands back only bytes that passed verification. Playback is a `blob:` URL
// built from those bytes — not a `data:` URL, which would keep a second 4/3
// copy of a 128 MiB track in the DOM. Nothing plays from a URL the server chose.
//
// Autoplay is handled, not hoped for. A webview may refuse sound before a user
// gesture, and the failure is silent in most engines — so every play is
// ATTEMPTED, and only a refusal marks the layer `waitingForUnlock`: the deck and
// a notice above the chronicle then offer one button, and a gesture anywhere in
// the window does the same job. A refusal is a NotAllowedError, a throw, or —
// in WebKit, which never rejects — a play() that stays unsettled with the
// element paused (`attemptPlay`). A staged BGM cue is something the author
// composed; losing it to a policy nobody surfaced is the bug this avoids — and
// so is withholding it behind a button of our own when the webview would have
// played it anyway. The retry on a gesture is a `play()` made INSIDE the
// gesture (`unlockFromGesture`), never left to an effect that runs after it.
//
// Fetch/read/decode failures are NOT silent. Each layer records its own
// `loadError`; a retry (or a new play / hash change) clears only that layer.
// What a layer records is a REASON (`fetch` / `decode`), because the mixer row
// shows it as a tooltip and a listener reading zh must not be handed an English
// cause string. The cause itself goes to the console, for whoever is debugging.

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { AudioLayer } from "@loreweaver/protocol"
import {
  attemptPlay,
  AUDIO_LAYERS,
  cancelPlay,
  effectiveVolume,
  registerLayerElement,
  unlockFromGesture,
  useAudioStore,
  type LayerState,
} from "../../store/audio"
import { isTauri, transportSend } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"
import { useMediaStore } from "../../store/media"
import { cachedAudioUrl } from "./audioPlayback"
import {
  importPackAudioCommand,
  LAYER_DEFAULT_LOOP,
  playCommand,
  transportCommand,
  volumeCommand,
} from "./audioCommands"

function LayerPlayer({ layer }: { layer: LayerState }) {
  const element = useRef<HTMLAudioElement | null>(null)
  /** Loads are numbered, and one mounted element belongs to exactly one of
   * them — that is what lets a verdict be attributed to the load it came from. */
  const loads = useRef(0)
  /** The URL the mounted element is pointing at right now. */
  const mountedUrl = useRef<string | null>(null)
  /** URLs the element has been pointed AWAY from. Revoked by the effect below,
   * i.e. after the commit that moved it — never while a live element still
   * names them. */
  const releasable = useRef<string[]>([])
  const [load, setLoad] = useState<{ url: string; token: number } | null>(null)
  const masterMuted = useAudioStore((s) => s.muted)
  const unlocked = useAudioStore((s) => s.unlocked)
  const setLayerLoadError = useAudioStore((s) => s.setLayerLoadError)
  const hash = layer.hash ?? ""
  const layerName = layer.layer

  // Stable on purpose. An inline ref callback is a new function every render, so
  // React ran the old one's cleanup — which pauses a playing element — each time
  // the deck re-rendered for ANOTHER layer's change, and nothing started it
  // again. This runs once per element: on attach, and on detach.
  const attach = useCallback(
    (node: HTMLAudioElement | null) => {
      element.current = node
      // React only passes null when a ref callback returns no cleanup, so
      // this is the type's shape rather than a case that happens here.
      if (node === null) return
      const forget = registerLayerElement(layerName, node)
      return () => {
        forget()
        // The element a newer load replaced is detached, and a detached media
        // element goes on playing. Silence it on the way out.
        if (!node.paused) node.pause()
        if (element.current === node) element.current = null
      }
    },
    [layerName],
  )

  // Let go of what the element has already moved off. Revoking a URL an
  // attached element is still pointing at makes that element raise `error` for
  // bytes nothing was ever wrong with — an error the layer then wore as a
  // decode failure. This runs after React has written the new `src`, so by the
  // time a URL is revoked nothing in the document names it.
  useEffect(() => {
    if (releasable.current.length === 0) return
    for (const url of releasable.current) URL.revokeObjectURL(url)
    releasable.current = []
  }, [load])

  // Unmount: nothing can be pointing at any of these any more.
  useEffect(
    () => () => {
      for (const url of releasable.current) URL.revokeObjectURL(url)
      releasable.current = []
      if (mountedUrl.current !== null) {
        URL.revokeObjectURL(mountedUrl.current)
        mountedUrl.current = null
      }
    },
    [],
  )

  useEffect(() => {
    const token = (loads.current += 1)
    const release = () => {
      if (mountedUrl.current !== null) {
        releasable.current.push(mountedUrl.current)
        mountedUrl.current = null
      }
    }
    if (!hash || !isTauri()) {
      release()
      setLoad(null)
      return
    }
    let live = true
    void cachedAudioUrl(hash, layer.mime ?? "")
      .then((url) => {
        if (!live) {
          URL.revokeObjectURL(url)
          return
        }
        release()
        mountedUrl.current = url
        setLoad({ url, token })
        setLayerLoadError(layer.layer, null)
      })
      .catch((cause: unknown) => {
        if (!live) return
        release()
        setLoad(null)
        console.warn(`audio ${layer.layer}: ${cause instanceof Error ? cause.message : String(cause)}`)
        setLayerLoadError(layer.layer, "fetch")
      })
    return () => {
      live = false
    }
  }, [hash, layer.layer, layer.mime, layer.loadEpoch, setLayerLoadError])

  useEffect(() => {
    const audio = element.current
    if (audio === null) return
    audio.volume = effectiveVolume(layer, masterMuted)
    audio.loop = layer.loop === true
    if (layer.playing && !layer.waitingForUnlock && load !== null) {
      // Attempt regardless of `unlocked`: that flag only records that a gesture
      // happened, and the webview may allow sound without one. A layer already
      // waiting is not asked again; the unlock that clears it is what asks.
      attemptPlay(layer.layer, audio)
    } else {
      cancelPlay(audio)
      audio.pause()
    }
  }, [layer, masterMuted, unlocked, load])

  if (load === null) return null
  // Not `controls`: the keeper drives playback, and the listener's own controls
  // are the mixer rows below.
  return (
    <audio
      // One element per LOAD. A `<audio>` that outlives its own source cannot
      // say which load its late `error` belongs to, and this one is the only
      // place that answer exists.
      key={load.token}
      ref={attach}
      src={load.url}
      preload="auto"
      onError={() => {
        // Load-scoped, both ways: this element belongs to one load, and only
        // the load that is still the current one may write a verdict. An error
        // queued for a load that has since been replaced would otherwise bury
        // the load that replaced it — a hash change, or a Retry that had just
        // succeeded, silenced by the failure of the source it replaced.
        if (load.token !== loads.current) return
        setLayerLoadError(layer.layer, "decode")
        if (mountedUrl.current !== null) {
          releasable.current.push(mountedUrl.current)
          mountedUrl.current = null
        }
        setLoad(null)
      }}
    />
  )
}

function LayerRow({ layer }: { layer: LayerState }) {
  const { t } = useTranslation()
  const setLayerMuted = useAudioStore((s) => s.setLayerMuted)
  const setLayerGain = useAudioStore((s) => s.setLayerGain)
  const retryLayer = useAudioStore((s) => s.retryLayer)
  const label = t(`play.audio.layers.${layer.layer}`)

  return (
    <div className="audio-row" data-layer={layer.layer}>
      <span className="audio-layer-name">{label}</span>
      <span className="audio-now">
        {layer.playing || layer.waitingForUnlock
          ? (layer.title ?? layer.name ?? t("play.audio.untitled"))
          : t("play.audio.silent")}
      </span>
      {layer.loadError !== null ? (
        <>
          <span
            className="audio-load-error"
            role="alert"
            title={t(`play.audio.loadError.${layer.loadError}`)}
          >
            {t("play.audio.loadFailed")}
          </span>
          <button type="button" className="ghost-button" onClick={() => retryLayer(layer.layer)}>
            {t("play.audio.retry")}
          </button>
        </>
      ) : null}
      <label className="audio-mute">
        <input
          type="checkbox"
          checked={layer.muted}
          aria-label={t("play.audio.muteLayer", { layer: label })}
          onChange={(e) => setLayerMuted(layer.layer, e.target.checked)}
        />
        {t("play.audio.mute")}
      </label>
      <input
        className="audio-gain"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={layer.gain}
        aria-label={t("play.audio.gainLayer", { layer: label })}
        onChange={(e) => setLayerGain(layer.layer, Number(e.target.value))}
      />
    </div>
  )
}

/** The keeper's control surface. `audio_control` is a server→client frame, so
 * a keeper does not send one — they send a command and the server broadcasts.
 * The picker offers the room's own audio library, because that is what the
 * server's resolver matches a query against. */
function KeeperControls() {
  const { t } = useTranslation()
  const library = useMediaStore((s) => s.audio)
  const [layer, setLayer] = useState<AudioLayer>("bgm")
  const [choice, setChoice] = useState("")
  // `null` = the keeper has not touched the box for this layer, so the layer's
  // own default stands and the command omits the token entirely — the server
  // then applies the same default the checkbox is showing. One shared `true`
  // here is how an sfx one-shot became an endless loop.
  const [loopOverride, setLoopOverride] = useState<boolean | null>(null)
  const loop = loopOverride ?? LAYER_DEFAULT_LOOP[layer]
  const [packId, setPackId] = useState("")

  const run = (command: string) => {
    void transportSend({ type: "input", text: command }).catch(() => {
      // The transport surfaces failures through status events.
    })
  }

  return (
    <div className="audio-keeper">
      <div className="dialog-row">
        <label className="field field-narrow">
          {t("play.audio.keeperLayer")}
          <select
            value={layer}
            onChange={(e) => {
              setLayer(e.target.value as AudioLayer)
              // A new layer brings its own default; a tick made for the music
              // must not follow the keeper over to the sound effects.
              setLoopOverride(null)
            }}
          >
            {AUDIO_LAYERS.map((name) => (
              <option key={name} value={name}>
                {t(`play.audio.layers.${name}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("play.audio.keeperTrack")}
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">{t("play.audio.keeperPick")}</option>
            {library.map((item) => (
              <option key={item.id} value={item.title || item.name}>
                {item.title || item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="audio-mute">
          <input type="checkbox" checked={loop} onChange={(e) => setLoopOverride(e.target.checked)} />
          {t("play.audio.keeperLoop")}
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={choice === ""}
          onClick={() => run(playCommand(layer, choice, { loop: loopOverride ?? undefined }))}
        >
          {t("play.audio.keeperPlay")}
        </button>
      </div>
      <div className="dialog-row">
        <button type="button" className="ghost-button" onClick={() => run(transportCommand(layer, "pause"))}>
          {t("play.audio.keeperPause")}
        </button>
        <button type="button" className="ghost-button" onClick={() => run(transportCommand(layer, "resume"))}>
          {t("play.audio.keeperResume")}
        </button>
        <button type="button" className="ghost-button" onClick={() => run(transportCommand(layer, "stop"))}>
          {t("play.audio.keeperStop")}
        </button>
        <input
          className="audio-gain"
          type="range"
          min={0}
          max={1}
          step={0.05}
          defaultValue={1}
          aria-label={t("play.audio.keeperVolume")}
          onChange={(e) => run(volumeCommand(layer, Number(e.target.value)))}
        />
      </div>
      <div className="dialog-row">
        <label className="field field-narrow">
          {t("play.audio.keeperImport")}
          <input
            value={packId}
            onChange={(e) => setPackId(e.target.value)}
            placeholder="deep-pier"
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={packId.trim() === ""}
          onClick={() => run(importPackAudioCommand(packId))}
        >
          {t("play.audio.keeperImportRun")}
        </button>
      </div>
      <p className="studio-hint">{t("play.audio.keeperHint")}</p>
    </div>
  )
}

/** The same one-click unlock where the player is already looking. The deck
 * above sits at the foot of the sidebar, below the fold, so a hint kept only
 * there goes unseen — and "why is there no sound" stays unanswered. Shown only
 * while a layer is actually waiting, i.e. after the webview refused. */
export function AudioUnlockNotice() {
  const { t } = useTranslation()
  const waiting = useAudioStore((s) => AUDIO_LAYERS.some((name) => s.layers[name].waitingForUnlock))
  if (!waiting) return null
  return (
    <div className="panel-notice" role="status">
      <span className="panel-notice-text">{t("play.audio.unlockNotice")}</span>
      <button type="button" className="primary-button" onClick={() => unlockFromGesture()}>
        {t("play.audio.unlock")}
      </button>
    </div>
  )
}

export default function AudioDeck() {
  const { t } = useTranslation()
  const layers = useAudioStore((s) => s.layers)
  const muted = useAudioStore((s) => s.muted)
  const setMuted = useAudioStore((s) => s.setMuted)

  const isKeeper = useConnectionStore((s) => s.welcome?.you.role === "keeper")
  const anyKnown = AUDIO_LAYERS.some(
    (name) => layers[name].playing || layers[name].waitingForUnlock || layers[name].hash,
  )
  const waiting = AUDIO_LAYERS.some((name) => layers[name].waitingForUnlock)
  // A keeper always gets the deck — the controls are the point. A player sees
  // it only once there is sound to hear or a mixer row worth touching.
  if (!anyKnown && !isKeeper) return null

  return (
    <section className="desk-card audio-deck" aria-label={t("play.audio.title")}>
      <header className="desk-title">
        {t("play.audio.title")}
        <label className="audio-mute">
          <input
            type="checkbox"
            checked={muted}
            aria-label={t("play.audio.muteAll")}
            onChange={(e) => setMuted(e.target.checked)}
          />
          {t("play.audio.muteAll")}
        </label>
      </header>
      {waiting ? (
        // The one gesture the webview needs. Said plainly, because "why is
        // there no sound" is otherwise unanswerable from inside the app.
        <p className="studio-notice" role="status">
          {t("play.audio.unlockHint")}{" "}
          <button type="button" className="primary-button" onClick={() => unlockFromGesture()}>
            {t("play.audio.unlock")}
          </button>
        </p>
      ) : null}
      {AUDIO_LAYERS.map((name) => (
        <LayerRow key={name} layer={layers[name]} />
      ))}
      {isKeeper ? <KeeperControls /> : null}
      {AUDIO_LAYERS.map((name) => (
        <LayerPlayer key={name} layer={layers[name]} />
      ))}
    </section>
  )
}

export type { AudioLayer }
