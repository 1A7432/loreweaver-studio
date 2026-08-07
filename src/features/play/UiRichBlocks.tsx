// The protocol-2.1 rich blocks: `image` plus the four M19 performance
// templates (`letter`, `clipping`, `map_pin`, `title_card`). They are
// DECLARATIVE, not markup — the studio is the rich client, so a letter draws
// as stationery and a title card as an act break, while a text-first client
// prints the same fields as lines (that degradation is the semantic floor:
// every field also appears as text here).
//
// `image`/`map_pin` name their picture by content hash; the native asset
// cache answers it (pulling over the live connection's media byte channel on
// a miss, sha256-verified). Tier-1 pictures are INERT data — unlike tier-2
// code they may enter the WebView, wrapped in a `data:` URL the CSP already
// allows. The caption/alt line doubles as the loading and failure state.

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import {
  stripControlChars,
  type UiClippingBlock,
  type UiImageBlock,
  type UiLetterBlock,
  type UiMapPinBlock,
  type UiTitleCardBlock,
} from "@loreweaver/protocol"
import { assetFetch, assetReadBase64 } from "./panels/assets"

// The server stamps the authoritative mime; anything outside the image
// whitelist is dropped from the data URL (the browser then sniffs instead).
const IMAGE_MIME_RE = /^image\/(png|jpeg|webp|gif|svg\+xml)$/

// Resolved data URLs are immutable per hash — share them across mounts.
const dataUrlCache = new Map<string, Promise<string>>()

function loadDataUrl(hash: string, mime: string | undefined): Promise<string> {
  const cached = dataUrlCache.get(hash)
  if (cached) return cached
  const pending = assetFetch(hash)
    .then(() => assetReadBase64(hash))
    .then((base64) => `data:${mime && IMAGE_MIME_RE.test(mime) ? mime : ""};base64,${base64}`)
    .catch((error: unknown) => {
      // A failed pull must not poison the cache — the next mount retries.
      dataUrlCache.delete(hash)
      throw error
    })
  dataUrlCache.set(hash, pending)
  return pending
}

type LoadPhase = "loading" | "ready" | "failed"

function useAssetDataUrl(hash: string, mime: string | undefined): { phase: LoadPhase; url: string | null } {
  const [phase, setPhase] = useState<LoadPhase>("loading")
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setPhase("loading")
    setUrl(null)
    loadDataUrl(hash, mime).then(
      (resolved) => {
        if (cancelled) return
        setUrl(resolved)
        setPhase("ready")
      },
      () => {
        if (!cancelled) setPhase("failed")
      },
    )
    return () => {
      cancelled = true
    }
  }, [hash, mime])
  return { phase, url }
}

export function ImageBlockView({ block }: { block: UiImageBlock }) {
  const { t } = useTranslation()
  const { phase, url } = useAssetDataUrl(block.hash, block.mime)
  const caption = block.caption ? stripControlChars(block.caption) : undefined
  const alt = block.alt ? stripControlChars(block.alt) : undefined
  const fallback =
    [alt ?? caption, phase === "failed" ? t("panels.imageUnavailable") : null].filter(Boolean).join(" — ") ||
    t("panels.imageLoading")
  return (
    <figure className="ui-image">
      {phase === "ready" && url ? (
        <img className="ui-image-img" src={url} alt={alt ?? caption ?? ""} />
      ) : (
        <p className={`ui-image-fallback${phase === "failed" ? " is-failed" : ""}`}>{fallback}</p>
      )}
      {caption ? <figcaption className="ui-image-caption">{caption}</figcaption> : null}
    </figure>
  )
}

export function MapPinBlockView({ block }: { block: UiMapPinBlock }) {
  const { t } = useTranslation()
  const { phase, url } = useAssetDataUrl(block.hash, block.mime)
  const label = stripControlChars(block.label)
  const note = block.note ? stripControlChars(block.note) : undefined
  return (
    <figure className="ui-map-pin">
      {phase === "ready" && url ? (
        <div className="ui-map-canvas">
          <img className="ui-map-img" src={url} alt={label} />
          <span
            className="ui-map-marker"
            // x/y are FRACTIONS of the map's own box — the marker scales to
            // whatever size the map draws at.
            style={{ left: `${block.x * 100}%`, top: `${block.y * 100}%` }}
            title={note ?? label}
          >
            <span className="ui-map-marker-dot" aria-hidden="true" />
            <span className="ui-map-marker-label">{label}</span>
          </span>
        </div>
      ) : (
        <p className={`ui-map-fallback${phase === "failed" ? " is-failed" : ""}`}>
          {phase === "failed" ? `${label} — ${t("panels.imageUnavailable")}` : t("panels.imageLoading")}
        </p>
      )}
      {note ? <figcaption className="ui-map-note">{note}</figcaption> : null}
    </figure>
  )
}

/** One "— from · date" / "— source · date" attribution line. */
function attribution(parts: (string | undefined)[]): string | null {
  const joined = parts.filter(Boolean).join(" · ")
  return joined ? `— ${joined}` : null
}

export function LetterBlockView({ block }: { block: UiLetterBlock }) {
  const meta = attribution([
    block.from ? stripControlChars(block.from) : undefined,
    block.date ? stripControlChars(block.date) : undefined,
  ])
  return (
    <blockquote className="ui-letter">
      {block.to ? <p className="ui-letter-to">{stripControlChars(block.to)}</p> : null}
      <p className="ui-letter-body">{stripControlChars(block.body)}</p>
      {meta ? <footer className="ui-letter-attribution">{meta}</footer> : null}
    </blockquote>
  )
}

export function ClippingBlockView({ block }: { block: UiClippingBlock }) {
  const meta = attribution([
    block.source ? stripControlChars(block.source) : undefined,
    block.date ? stripControlChars(block.date) : undefined,
  ])
  return (
    <article className="ui-clipping">
      <p className="ui-clipping-headline">
        <span className="ui-clipping-tick" aria-hidden="true">
          ▬▬{" "}
        </span>
        {stripControlChars(block.headline)}
      </p>
      <p className="ui-clipping-body">{stripControlChars(block.body)}</p>
      {meta ? <footer className="ui-clipping-attribution">{meta}</footer> : null}
    </article>
  )
}

export function TitleCardBlockView({ block }: { block: UiTitleCardBlock }) {
  return (
    <div className="ui-title-card">
      <div className="ui-title-card-rule" aria-hidden="true" />
      <p className="ui-title-card-head">
        {block.act ? <span className="ui-title-card-act">{stripControlChars(block.act)}</span> : null}
        <span className="ui-title-card-title">{stripControlChars(block.title)}</span>
      </p>
      {block.subtitle ? <p className="ui-title-card-subtitle">{stripControlChars(block.subtitle)}</p> : null}
      <div className="ui-title-card-rule" aria-hidden="true" />
    </div>
  )
}
