// One member's portrait, pulled through the verified cache.
//
// `state.character.avatar` and `state.party[].avatar` are `MediaRef`s —
// `{hash, mime, size, name?}` — because the protocol never puts bytes in a
// frame. The picture arrives the same way a panel asset does: fetched over the
// media byte channel, stored under its sha256, and read back only after the
// hash verified.

import { useEffect, useState } from "react"
import type { MediaRef } from "@loreweaver/protocol"
import { isTauri } from "../../lib/transport"
import { assetFetch, assetReadBase64 } from "./panels/assets"

export default function Avatar({ ref: media, name }: { ref: MediaRef | undefined; name: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const hash = media?.hash ?? ""
  const mime = media?.mime ?? ""

  useEffect(() => {
    if (!hash || !isTauri()) {
      setSrc(null)
      return
    }
    let live = true
    void assetFetch(hash)
      .then(() => assetReadBase64(hash))
      .then((base64) => {
        if (live) setSrc(`data:${mime || "image/png"};base64,${base64}`)
      })
      .catch(() => {
        // A portrait that will not come is simply absent — the name still
        // identifies the member.
        if (live) setSrc(null)
      })
    return () => {
      live = false
    }
  }, [hash, mime])

  if (src === null) return null
  return <img className="member-avatar" src={src} alt={name} />
}
