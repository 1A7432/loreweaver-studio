// A picture named by content hash, as a `data:` URL: the native asset cache answers it (pulling
// over the live connection's byte channel on a miss, sha256-verified), and the decoded URL is
// shared through `lib/dataUrlCache`. Pictures are INERT data — unlike page code they may enter
// the WebView, wrapped in a `data:` URL the CSP already allows.

import { useEffect, useState } from "react"
import { loadDataUrl as loadCachedDataUrl } from "../../lib/dataUrlCache"
import { assetFetch, assetReadBase64 } from "./panels/assets"

// The server stamps the authoritative mime; anything outside the image
// whitelist is dropped from the data URL (the browser then sniffs instead).
const IMAGE_MIME_RE = /^image\/(png|jpeg|webp|gif|svg\+xml)$/

function loadDataUrl(hash: string, mime: string | undefined): Promise<string> {
  return loadCachedDataUrl(hash, () =>
    assetFetch(hash)
      .then(() => assetReadBase64(hash))
      .then((base64) => `data:${mime && IMAGE_MIME_RE.test(mime) ? mime : ""};base64,${base64}`),
  )
}

export type LoadPhase = "loading" | "ready" | "failed"

export function useAssetDataUrl(
  hash: string,
  mime: string | undefined,
): { phase: LoadPhase; url: string | null } {
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
