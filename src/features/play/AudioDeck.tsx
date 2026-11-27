// The room's sound on the desk: what plays (from the `audio` view — titles are named for
// everyone there), the listener's own mix (mute, a volume per layer, local and persisted), and
// the unlock a WebView may need before it plays anything. The sound itself is made by the
// connection's `AudioController` (`audio.ts`), outside React.
//
// The room admin also gets the library — its titles, layers, tags and pack cues, which the view
// gives admins alone (a sound's name may tell the story before the table hears it) — and
// controls that run `bgm` / `ambience` / `sfx` (play, pause, resume, stop, volume) and `audio`
// (set a sound's title, layer and tags; remove it). Adding a sound is an upload with purpose
// `audio`. Every control is offered only when the `commands` view offers its command.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars, type ViewAudioSound } from "loreweaver-protocol/v3"
import { pickUploadPath } from "../../lib/native"
import { uploadFile } from "../../lib/media"
import { useConnection, useSessionSnapshot } from "../../store/connection"
import { unlockFromGesture, useAudioLocal, useAudioMixStore, useAudioSlot } from "../../store/audio"
import { AUDIO_LAYERS, LOOP_LAYERS, type AudioLayer, type LoopLayer } from "./audio"
import CommandFeedback from "./CommandFeedback"
import { useCommand, useCommandRunner, useOnline, useRole, useView, useViews } from "./room"
import { transferErrorText, uploadBlocked } from "./transfer"

const PLAY_ARGS = ["op", "query"]
const SET_ARGS = ["op", "query", "title", "layer", "tags"]

/** Shown above the story while the WebView refuses to start sound. */
export function AudioUnlockNotice() {
  const { t } = useTranslation()
  const { blocked } = useAudioLocal()
  if (!blocked) return null
  return (
    <div className="panel-notice" role="status">
      <span className="panel-notice-text">{t("play.audio.unlockNotice")}</span>
      <button type="button" className="primary-button" onClick={() => unlockFromGesture()}>
        {t("play.audio.unlock")}
      </button>
    </div>
  )
}

/** A volume slider that sends once, when the hand lets go — not once per pixel. */
function VolumeSlider({
  value,
  label,
  disabled,
  onCommit,
}: {
  value: number
  label: string
  disabled?: boolean
  onCommit: (volume: number) => void
}) {
  const [draft, setDraft] = useState<number | null>(null)
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  return (
    <input
      className="audio-gain"
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={draft ?? value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => setDraft(Number(e.target.value))}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  )
}

/** The listener's own row for a layer: what plays (loop layers), and the local volume. */
function LayerRow({ layer }: { layer: AudioLayer }) {
  const { t } = useTranslation()
  const playing = useView("audio")?.playing
  const gain = useAudioMixStore((s) => s.gain[layer])
  const setGain = useAudioMixStore((s) => s.setGain)
  const local = useAudioLocal()
  const controller = useAudioSlot((s) => s.controller)
  const label = t(`play.audio.layers.${layer}`)
  const now = layer === "sfx" ? undefined : playing?.[layer]
  const failed = layer !== "sfx" && local.failed.includes(layer)
  return (
    <div className="audio-row" data-layer={layer}>
      <span className="audio-layer-name">{label}</span>
      <span className="audio-now">
        {layer === "sfx"
          ? ""
          : now === undefined
            ? t("play.audio.silent")
            : `${stripControlChars(now.title) || t("play.audio.untitled")}${now.paused ? ` ${t("play.audio.paused")}` : ""}`}
      </span>
      {failed ? (
        <>
          <span className="audio-load-error" role="alert">
            {t("play.audio.loadFailed")}
          </span>
          <button
            type="button"
            className="ghost-button"
            onClick={() => controller?.retry(layer as LoopLayer)}
          >
            {t("play.audio.retry")}
          </button>
        </>
      ) : null}
      <input
        className="audio-gain"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={gain}
        aria-label={t("play.audio.gainLayer", { layer: label })}
        onChange={(e) => setGain(layer, Number(e.target.value))}
      />
    </div>
  )
}

/** The admin's controls over one looping layer that plays something. */
function PlayingControls({
  layer,
  run,
}: {
  layer: LoopLayer
  run: ReturnType<typeof useCommandRunner>["run"]
}) {
  const { t } = useTranslation()
  const now = useView("audio")?.playing[layer]
  const usable = useCommand(layer, ["op", "volume"]) !== null
  const online = useOnline()
  if (now === undefined || !usable) return null
  const label = t(`play.audio.layers.${layer}`)
  return (
    <div className="dialog-row" data-controls={layer}>
      <span className="audio-layer-name">{label}</span>
      <button
        type="button"
        className="ghost-button"
        disabled={!online}
        onClick={() => void run(layer, { op: now.paused ? "resume" : "pause" })}
      >
        {now.paused ? t("play.audio.resume") : t("play.audio.pause")}
      </button>
      <button
        type="button"
        className="ghost-button"
        disabled={!online}
        onClick={() => void run(layer, { op: "stop" })}
      >
        {t("play.audio.stop")}
      </button>
      <VolumeSlider
        value={now.volume}
        label={t("play.audio.roomVolume", { layer: label })}
        disabled={!online}
        onCommit={(volume) => void run(layer, { op: "volume", volume })}
      />
    </div>
  )
}

/** One sound of the library as the admin sees it, with play, edit and remove. */
function SoundRow({
  sound,
  run,
}: {
  sound: ViewAudioSound
  run: ReturnType<typeof useCommandRunner>["run"]
}) {
  const { t } = useTranslation()
  const online = useOnline()
  const canSet = useCommand("audio", SET_ARGS) !== null
  const [layer, setLayer] = useState<AudioLayer>(sound.layer ?? "bgm")
  const canPlay = useCommand(layer, PLAY_ARGS) !== null
  const [editing, setEditing] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [title, setTitle] = useState(sound.title ?? "")
  const [tagLayer, setTagLayer] = useState<string>(sound.layer ?? "")
  const [tags, setTags] = useState((sound.tags ?? []).join(", "))
  const id = sound.id
  if (id === undefined) return null
  const upload = sound.source?.kind === "upload"
  const name = stripControlChars(sound.title ?? "") || id

  const save = () => {
    const words = tags
      .split(/[,，]/u)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "")
    const args: Record<string, unknown> = {
      op: "set",
      query: id,
      layer: tagLayer === "" ? null : tagLayer,
      tags: words,
    }
    if (title.trim() !== "") args.title = title.trim()
    void run("audio", args)
    setEditing(false)
  }

  return (
    <li className="audio-sound">
      <div className="dialog-row">
        <span className="audio-now" title={id}>
          {name}
        </span>
        {sound.layer ? <span className="desk-tag">{t(`play.audio.layers.${sound.layer}`)}</span> : null}
        {sound.source?.kind === "pack" && sound.source.id ? (
          <span className="desk-tag">{stripControlChars(sound.source.id)}</span>
        ) : null}
        {(sound.tags ?? []).map((tag) => (
          <span key={tag} className="chip">
            {stripControlChars(tag)}
          </span>
        ))}
      </div>
      <div className="dialog-row">
        <select
          value={layer}
          aria-label={t("play.audio.playOn", { sound: name })}
          onChange={(e) => setLayer(e.target.value as AudioLayer)}
        >
          {AUDIO_LAYERS.map((entry) => (
            <option key={entry} value={entry}>
              {t(`play.audio.layers.${entry}`)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="primary-button"
          disabled={!online || !canPlay}
          onClick={() => void run(layer, { op: "play", query: id })}
        >
          {t("play.audio.play")}
        </button>
        {upload && canSet ? (
          <>
            <button
              type="button"
              className="ghost-button"
              disabled={!online}
              onClick={() => setEditing(!editing)}
            >
              {t("play.audio.edit")}
            </button>
            {confirmRemove ? (
              <>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!online}
                  onClick={() => {
                    void run("audio", { op: "remove", query: id })
                    setConfirmRemove(false)
                  }}
                >
                  {t("play.audio.removeConfirm")}
                </button>
                <button type="button" className="ghost-button" onClick={() => setConfirmRemove(false)}>
                  {t("play.audio.keep")}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ghost-button"
                disabled={!online}
                onClick={() => setConfirmRemove(true)}
              >
                {t("play.audio.remove")}
              </button>
            )}
          </>
        ) : null}
      </div>
      {editing ? (
        <div className="play-form">
          <label className="field">
            {t("play.audio.soundTitle")}
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            {t("play.audio.soundLayer")}
            <select value={tagLayer} onChange={(e) => setTagLayer(e.target.value)}>
              <option value="">{t("play.audio.noLayer")}</option>
              {AUDIO_LAYERS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`play.audio.layers.${entry}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t("play.audio.soundTags")}
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t("play.audio.tagsHint")}
            />
          </label>
          <button type="button" className="primary-button" disabled={!online} onClick={save}>
            {t("play.audio.save")}
          </button>
        </div>
      ) : null}
    </li>
  )
}

/** Add a sound to the library: an upload with purpose `audio`. */
function AddSound() {
  const { t } = useTranslation()
  const connection = useConnection()
  const online = useOnline()
  const blocked = uploadBlocked(useSessionSnapshot())
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  if (blocked !== null) return <p className="studio-hint">{t(`play.transfer.blocked.${blocked}`)}</p>
  const add = async () => {
    if (connection === null) return
    const path = await pickUploadPath("sound", t("play.audio.fileFilter"))
    if (path === null) return
    setBusy(true)
    setOutcome(null)
    try {
      const stored = await uploadFile(connection, path, "audio")
      setOutcome({ ok: true, text: t("play.audio.added", { name: stripControlChars(stored.name) }) })
    } catch (error) {
      setOutcome({ ok: false, text: transferErrorText(error, t) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dialog-row">
      <button type="button" className="ghost-button" disabled={!online || busy} onClick={() => void add()}>
        {busy ? t("play.audio.adding") : t("play.audio.add")}
      </button>
      {outcome ? (
        <span
          className={outcome.ok ? "studio-hint" : "audio-load-error"}
          role={outcome.ok ? "status" : "alert"}
        >
          {outcome.text}
        </span>
      ) : null}
    </div>
  )
}

function AdminAudio() {
  const { t } = useTranslation()
  const library = useView("audio")?.library ?? []
  const canSet = useCommand("audio", SET_ARGS) !== null
  const { run, feedback, dismiss } = useCommandRunner()
  return (
    <div className="audio-admin">
      {LOOP_LAYERS.map((layer) => (
        <PlayingControls key={layer} layer={layer} run={run} />
      ))}
      <h4 className="play-form-title">{t("play.audio.library")}</h4>
      {library.length === 0 ? <p className="studio-hint">{t("play.audio.libraryEmpty")}</p> : null}
      <ul className="media-list">
        {library.map((sound) => (
          <SoundRow key={sound.id ?? sound.hash} sound={sound} run={run} />
        ))}
      </ul>
      {canSet ? <AddSound /> : null}
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </div>
  )
}

export default function AudioDeck() {
  const { t } = useTranslation()
  useViews(["audio"])
  const view = useView("audio")
  const admin = useRole() === "admin"
  const muted = useAudioMixStore((s) => s.muted)
  const setMuted = useAudioMixStore((s) => s.setMuted)
  const { blocked } = useAudioLocal()
  const anything = view !== null && (view.library.length > 0 || Object.keys(view.playing).length > 0)
  if (!admin && !anything) return null

  return (
    <section className="desk-card audio-deck" aria-label={t("play.audio.title")}>
      <header className="desk-title">
        {t("play.audio.title")}
        <label className="audio-mute">
          <input type="checkbox" checked={muted} onChange={(e) => setMuted(e.target.checked)} />
          {t("play.audio.muteAll")}
        </label>
      </header>
      {blocked ? (
        <p className="studio-notice" role="status">
          {t("play.audio.unlockHint")}{" "}
          <button type="button" className="primary-button" onClick={() => unlockFromGesture()}>
            {t("play.audio.unlock")}
          </button>
        </p>
      ) : null}
      {AUDIO_LAYERS.map((layer) => (
        <LayerRow key={layer} layer={layer} />
      ))}
      {admin ? <AdminAudio /> : null}
    </section>
  )
}
