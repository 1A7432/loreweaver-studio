// The thing that actually makes sound, plus the listener's mixer.
//
// One `<audio>` element per layer, fed from the same verified cache the picture
// path uses: `audio_control` names a blob by hash, `assetFetch` pulls it over
// the media byte channel and stores it under its sha256, and `assetReadBase64`
// hands back only bytes that passed verification. Nothing plays from a URL the
// server chose.
//
// Autoplay is handled, not hoped for. A webview refuses sound before a user
// gesture, and the failure is silent in most engines — so a play that arrives
// early is REMEMBERED (`waitingForUnlock`) and the deck shows one button that
// starts everything still waiting. A staged BGM cue is something the author
// composed; losing it to a policy nobody surfaced is the bug this avoids.

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { AudioLayer } from "@loreweaver/protocol"
import { assetFetch, assetReadBase64 } from "./panels/assets"
import { AUDIO_LAYERS, effectiveVolume, useAudioStore, type LayerState } from "../../store/audio"
import { isTauri, transportSend } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"
import { useMediaStore } from "../../store/media"
import { importPackAudioCommand, playCommand, transportCommand, volumeCommand } from "./audioCommands"

/** Pull one blob into the verified cache and hand back a `data:` URL.
 *
 * Audio is inert content, like a tier-1 `image` block — the CSP already allows
 * `data:` media, and the alternative (a blob URL fed from the WebView) would
 * mean moving the bytes through JS twice. */
async function cachedAudioUrl(hash: string, mime: string): Promise<string> {
  await assetFetch(hash)
  const base64 = await assetReadBase64(hash)
  return `data:${mime || "audio/mpeg"};base64,${base64}`
}

function LayerPlayer({ layer }: { layer: LayerState }) {
  const element = useRef<HTMLAudioElement | null>(null)
  const [src, setSrc] = useState<string | null>(null)
  const masterMuted = useAudioStore((s) => s.muted)
  const unlocked = useAudioStore((s) => s.unlocked)
  const hash = layer.hash ?? ""

  useEffect(() => {
    if (!hash || !isTauri()) {
      setSrc(null)
      return
    }
    let live = true
    void cachedAudioUrl(hash, layer.mime ?? "")
      .then((url) => {
        if (live) setSrc(url)
      })
      .catch(() => {
        // A cue whose bytes will not come is silence, not a crash; the deck
        // still shows what the server asked for.
        if (live) setSrc(null)
      })
    return () => {
      live = false
    }
  }, [hash, layer.mime])

  useEffect(() => {
    const audio = element.current
    if (audio === null) return
    audio.volume = effectiveVolume(layer, masterMuted)
    audio.loop = layer.loop === true
    if (layer.playing && unlocked && src !== null) {
      void audio.play().catch(() => {
        // Still refused: keep the element paused rather than pretending.
      })
    } else {
      audio.pause()
    }
  }, [layer, masterMuted, unlocked, src])

  if (src === null) return null
  // Not `controls`: the keeper drives playback, and the listener's own controls
  // are the mixer rows below.
  return <audio ref={element} src={src} preload="auto" />
}

function LayerRow({ layer }: { layer: LayerState }) {
  const { t } = useTranslation()
  const setLayerMuted = useAudioStore((s) => s.setLayerMuted)
  const setLayerGain = useAudioStore((s) => s.setLayerGain)
  const label = t(`play.audio.layers.${layer.layer}`)

  return (
    <div className="audio-row" data-layer={layer.layer}>
      <span className="audio-layer-name">{label}</span>
      <span className="audio-now">
        {layer.playing || layer.waitingForUnlock
          ? (layer.title ?? layer.name ?? t("play.audio.untitled"))
          : t("play.audio.silent")}
      </span>
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
  const [loop, setLoop] = useState(true)
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
          <select value={layer} onChange={(e) => setLayer(e.target.value as AudioLayer)}>
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
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
          {t("play.audio.keeperLoop")}
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={choice === ""}
          onClick={() => run(playCommand(layer, choice, { loop }))}
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

export default function AudioDeck() {
  const { t } = useTranslation()
  const layers = useAudioStore((s) => s.layers)
  const unlocked = useAudioStore((s) => s.unlocked)
  const unlock = useAudioStore((s) => s.unlock)
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
      {waiting && !unlocked ? (
        // The one gesture the webview needs. Said plainly, because "why is
        // there no sound" is otherwise unanswerable from inside the app.
        <p className="studio-notice" role="status">
          {t("play.audio.unlockHint")}{" "}
          <button type="button" className="primary-button" onClick={() => unlock()}>
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
