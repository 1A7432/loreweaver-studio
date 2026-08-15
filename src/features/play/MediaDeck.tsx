// Pictures shared with the room: what has been shared, sharing one, the
// keeper's upload switch, and binding one as your character's avatar.
//
// Bytes are fetched through the same content-addressed cache the panel assets
// use — `media` frames carry metadata only, by design ("bytes are fetched on
// demand"), and nothing renders from a URL the server chose.

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { MediaFrame } from "@loreweaver/protocol"
import { pickAnyFiles } from "../../lib/native"
import { isTauri } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"
import { useMediaStore } from "../../store/media"
import { assetFetch, assetReadBase64 } from "./panels/assets"

/** A pending upload's `error` is either an i18n key under `play.media.err.`
 * (a refusal the SERVER named, which we can say properly) or a verbatim message
 * from the native side (which we cannot). Translate the first, show the second
 * as it came. */
function uploadDetail(t: (key: string) => string, error: string | null): string {
  if (error === null) return ""
  if (!error.startsWith("play.media.err.")) return error
  const translated = t(error)
  return translated === error ? error : translated
}

function Thumb({ item }: { item: MediaFrame }) {
  const { t } = useTranslation()
  const setAvatar = useMediaStore((s) => s.setAvatar)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let live = true
    void assetFetch(item.hash)
      .then(() => assetReadBase64(item.hash))
      .then((base64) => {
        if (live) setSrc(`data:${item.mime};base64,${base64}`)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [item.hash, item.mime])

  return (
    <li className="media-item">
      {src !== null ? (
        <img className="media-thumb" src={src} alt={item.name ?? ""} />
      ) : (
        <span className="media-thumb media-thumb-empty" aria-hidden="true">
          {failed ? "!" : "…"}
        </span>
      )}
      <span className="media-name" title={item.name}>
        {item.name || item.hash.slice(0, 8)}
      </span>
      <span className="media-from">{item.from}</span>
      <button type="button" className="ghost-button" onClick={() => setAvatar(item.hash)}>
        {t("play.media.useAsAvatar")}
      </button>
    </li>
  )
}

export default function MediaDeck() {
  const { t } = useTranslation()
  const images = useMediaStore((s) => s.images)
  const uploads = useMediaStore((s) => s.uploads)
  const uploadsEnabled = useMediaStore((s) => s.uploadsEnabled)
  const upload = useMediaStore((s) => s.upload)
  const setUploadsEnabled = useMediaStore((s) => s.setUploadsEnabled)
  const clearUpload = useMediaStore((s) => s.clearUpload)
  const isKeeper = useConnectionStore((s) => s.welcome?.you.role === "keeper")
  const [error, setError] = useState<string | null>(null)

  const share = async () => {
    setError(null)
    const files = await pickAnyFiles()
    for (const file of files) {
      if (file.path === null) continue
      try {
        await upload(file.path)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }

  const blocked = uploadsEnabled === false && !isKeeper
  const pending = Object.entries(uploads)
  if (images.length === 0 && pending.length === 0 && !isKeeper) return null

  return (
    <section className="desk-card" aria-label={t("play.media.title")}>
      <header className="desk-title">
        {t("play.media.title")}
        {isKeeper ? (
          <label className="audio-mute">
            <input
              type="checkbox"
              checked={uploadsEnabled !== false}
              aria-label={t("play.media.allowUploads")}
              onChange={(e) => setUploadsEnabled(e.target.checked)}
            />
            {t("play.media.allowUploads")}
          </label>
        ) : null}
      </header>
      <div className="dialog-row">
        {/* A keeper is never blocked by their own switch — `_handle_media_offer`
            gates on the room flag for everyone, but a keeper who turned uploads
            off can turn them back on, so the button stays live for them. For a
            player it disables only once the SERVER has said so: `uploadsEnabled`
            is null until then, and guessing would hide a control that works. */}
        <button type="button" className="ghost-button" disabled={blocked} onClick={() => void share()}>
          {t("play.media.share")}
        </button>
        {blocked ? <span className="studio-hint">{t("play.media.uploadsOff")}</span> : null}
      </div>
      {error !== null ? (
        <p className="studio-notice split-error" role="alert">
          {error}
        </p>
      ) : null}
      {pending.map(([sha256, item]) => (
        <p key={sha256} className={item.phase === "error" ? "studio-hint split-error" : "studio-hint"}>
          {item.phase === "error"
            ? t("play.media.uploadFailed", { name: item.name, detail: uploadDetail(t, item.error) })
            : t(`play.media.phase.${item.phase}`, { name: item.name })}{" "}
          {item.phase === "done" || item.phase === "error" ? (
            <button type="button" className="ghost-button" onClick={() => clearUpload(sha256)}>
              {t("play.media.dismiss")}
            </button>
          ) : null}
        </p>
      ))}
      {images.length > 0 ? (
        <ul className="media-list">
          {images.map((item) => (
            <Thumb key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <p className="placeholder">{t("play.media.empty")}</p>
      )}
    </section>
  )
}
