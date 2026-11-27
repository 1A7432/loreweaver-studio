// The room's pictures on the desk: a gallery derived from the log the session holds (`gallery.ts`)
// — shared files and the pictures the story showed — each fetched by hash through the verified
// asset cache. Sharing a file is an upload with purpose `share`: the table then sees it arrive
// as a `media` event. The room's upload switch is read from the `room` view; the room admin
// turns it with the `uploads` command. Every refusal is shown in the server's words.

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars } from "loreweaver-protocol/v3"
import { uploadFile } from "../../lib/media"
import { pickUploadPath } from "../../lib/native"
import { useConnection, useSessionSnapshot } from "../../store/connection"
import { useAssetDataUrl } from "./assetUrl"
import CommandFeedback from "./CommandFeedback"
import { galleryOf, isPicture, type GalleryItem } from "./gallery"
import { useCommand, useCommandRunner, useOnline, useRole, useView } from "./room"
import { transferErrorText, uploadBlocked } from "./transfer"

function Thumb({ item, onOpen }: { item: GalleryItem; onOpen: () => void }) {
  const { t } = useTranslation()
  const { phase, url } = useAssetDataUrl(item.hash, item.mime)
  const label = stripControlChars(item.label)
  return (
    <li className="media-item">
      <button type="button" className="ghost-button media-open" onClick={onOpen} title={label || undefined}>
        {url !== null ? (
          <img className="media-thumb" src={url} alt={label} />
        ) : (
          <span className="media-thumb media-thumb-empty" aria-hidden="true">
            {phase === "failed" ? "×" : "…"}
          </span>
        )}
      </button>
      <span className="media-name">{label || t("play.media.untitled")}</span>
      {phase === "failed" ? <span className="media-from">{t("panels.imageUnavailable")}</span> : null}
    </li>
  )
}

function Preview({ item, onClose }: { item: GalleryItem; onClose: () => void }) {
  const { t } = useTranslation()
  const { phase, url } = useAssetDataUrl(item.hash, item.mime)
  const label = stripControlChars(item.label)
  return (
    <figure className="ui-image media-preview">
      {url !== null ? (
        <img className="ui-image-img" src={url} alt={label} />
      ) : (
        <p className="ui-image-fallback">
          {phase === "failed" ? t("panels.imageUnavailable") : t("panels.imageLoading")}
        </p>
      )}
      <figcaption className="ui-image-caption">
        {label}{" "}
        <button type="button" className="ghost-button" onClick={onClose}>
          {t("play.media.close")}
        </button>
      </figcaption>
    </figure>
  )
}

/** Share a file with the table. */
function ShareButton() {
  const { t } = useTranslation()
  const connection = useConnection()
  const online = useOnline()
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
  const share = async () => {
    if (connection === null) return
    const path = await pickUploadPath("share", t("play.media.fileFilter"))
    if (path === null) return
    setBusy(true)
    setOutcome(null)
    try {
      const stored = await uploadFile(connection, path, "share")
      setOutcome({ ok: true, text: t("play.media.shared", { name: stripControlChars(stored.name) }) })
    } catch (error) {
      setOutcome({ ok: false, text: transferErrorText(error, t) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" className="ghost-button" disabled={!online || busy} onClick={() => void share()}>
        {busy ? t("play.media.sharing") : t("play.media.share")}
      </button>
      {outcome ? (
        <p className={outcome.ok ? "studio-hint" : "connect-error"} role={outcome.ok ? "status" : "alert"}>
          {outcome.text}
        </p>
      ) : null}
    </>
  )
}

/** The room admin's upload switch. */
function UploadSwitch() {
  const { t } = useTranslation()
  const uploads = useView("room")?.uploads ?? false
  const online = useOnline()
  const usable = useCommand("uploads", ["on"]) !== null
  const { run, feedback, dismiss, pending } = useCommandRunner()
  if (!usable) return null
  return (
    <>
      <label className="audio-mute">
        <input
          type="checkbox"
          checked={uploads}
          disabled={!online || pending}
          onChange={(e) => void run("uploads", { on: e.target.checked })}
        />
        {t("play.media.allowUploads")}
      </label>
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </>
  )
}

export default function MediaDeck() {
  const { t } = useTranslation()
  const snapshot = useSessionSnapshot()
  const events = snapshot?.events
  const items = useMemo(() => galleryOf(events ?? []), [events])
  const admin = useRole() === "admin"
  const blocked = uploadBlocked(snapshot)
  const [open, setOpen] = useState<string | null>(null)
  const pictures = items.filter((item) => isPicture(item.mime))
  const sounds = items.filter((item) => !isPicture(item.mime))
  const opened = pictures.find((item) => item.hash === open) ?? null
  if (items.length === 0 && blocked === "observer") return null

  return (
    <section className="desk-card media-deck" aria-label={t("play.media.title")}>
      <header className="desk-title">{t("play.media.title")}</header>
      {opened !== null ? <Preview item={opened} onClose={() => setOpen(null)} /> : null}
      {items.length === 0 ? <p className="studio-hint">{t("play.media.empty")}</p> : null}
      {pictures.length > 0 ? (
        <ul className="media-list">
          {pictures.map((item) => (
            <Thumb key={item.hash} item={item} onOpen={() => setOpen(item.hash)} />
          ))}
        </ul>
      ) : null}
      {sounds.length > 0 ? (
        <ul className="media-list">
          {sounds.map((item) => (
            <li key={item.hash} className="media-item">
              <span className="media-thumb media-thumb-empty" aria-hidden="true">
                ♪
              </span>
              <span className="media-name">{stripControlChars(item.label) || t("play.media.untitled")}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {blocked === null ? <ShareButton /> : null}
      {blocked === "off" ? <p className="studio-hint">{t("play.transfer.blocked.off")}</p> : null}
      {admin ? <UploadSwitch /> : null}
    </section>
  )
}
