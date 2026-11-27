// The typed face of the native panel-asset machinery: the sha256 disk cache
// (`asset_fetch` pulls misses over the live connection's media byte channel)
// and the `panel://` serve registry Tier-2 iframes load from. Bytes never
// enter the WebView — the scheme handler streams them from the verified cache.

import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import type { UiManifestPanel } from "@loreweaver/protocol"
import type { PanelEntry } from "loreweaver-protocol/v3"

export interface ServeAsset {
  path: string
  hash: string
  mime: string
}

export function assetCacheStatus(hashes: string[]): Promise<boolean[]> {
  return invoke<boolean[]>("asset_cache_status", { hashes })
}

export function assetFetch(hash: string): Promise<number> {
  return invoke<number>("asset_fetch", { hash })
}

/** Read a CACHED blob back as base64 — the read half of {@link assetFetch},
 * for tier-1 `image`/`map_pin` blocks (inert pictures, unlike tier-2 code). */
export function assetReadBase64(hash: string): Promise<string> {
  return invoke<string>("asset_read_base64", { hash })
}

export function panelServeRegister(args: {
  token: string
  entryHash: string
  assets: ServeAsset[]
  bootstrapJs: string
  themeCss: string
}): Promise<void> {
  return invoke<void>("panel_serve_register", { ...args })
}

export function panelServeUnregister(token: string): Promise<void> {
  return invoke<void>("panel_serve_unregister", { token })
}

/** Mirrors `panel_serve::ENTRY_PATH`. */
export const PANEL_ENTRY_FILE = "__entry__.html"

/** The iframe src for a mounted panel's entry document.
 *
 * `convertFileSrc` runs `encodeURIComponent` over the WHOLE path it is given,
 * so handing it `<token>/<file>` yields one `%2F`-joined segment — which the
 * scheme handler (segment-wise decode, traversal-safe) reads as a single
 * bogus token and 404s, and which would also break every relative subresource
 * inside the document. Build the base from the token alone (32 hex chars,
 * encoding-invariant) and append real path segments. */
export function panelEntryUrl(token: string): string {
  return `${convertFileSrc(token, "panel")}/${PANEL_ENTRY_FILE}`
}

// Concurrent mounts often share hashes (immutable, content-addressed);
// dedupe the in-flight pulls.
const inflight = new Map<string, Promise<void>>()

function ensureAsset(hash: string): Promise<void> {
  const existing = inflight.get(hash)
  if (existing) return existing
  const pull = assetFetch(hash)
    .then(() => undefined)
    .finally(() => inflight.delete(hash))
  inflight.set(hash, pull)
  return pull
}

/** Pull every hash a 2.x tier-2 panel names into the verified cache (the parked
 * `Tier2Frame`'s; a 3.0 page is one HTML file, `entry.page`). */
export async function ensurePanelAssets(panel: UiManifestPanel): Promise<void> {
  if (!panel.entry?.hash) throw new Error("tier-2 panel has no entry hash")
  const hashes = [panel.entry.hash, ...(panel.assets ?? []).map((asset) => asset.hash)]
  await Promise.all(hashes.map(ensureAsset))
}

/** Total bytes of page HTML the `panels` view names (for the consent notice). */
export function pageFootprintBytes(panels: readonly PanelEntry[]): number {
  let total = 0
  for (const panel of panels) if (panel.kind === "page") total += panel.page?.size ?? 0
  return total
}
