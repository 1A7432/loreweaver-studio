// The typed face of the native panel-asset machinery: the sha256 disk cache
// (`asset_fetch` pulls misses over the live connection's media byte channel)
// and the `panel://` serve registry Tier-2 iframes load from. Bytes never
// enter the WebView — the scheme handler streams them from the verified cache.

import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import type { UiManifestPanel } from "@loreweaver/protocol"

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

/** The iframe src for a mounted panel's entry document. */
export function panelEntryUrl(token: string): string {
  return convertFileSrc(`${token}/__entry__.html`, "panel")
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

/** Pull every hash the panel's manifest names into the verified cache. */
export async function ensurePanelAssets(panel: UiManifestPanel): Promise<void> {
  if (!panel.entry?.hash) throw new Error("tier-2 panel has no entry hash")
  const hashes = [panel.entry.hash, ...(panel.assets ?? []).map((asset) => asset.hash)]
  await Promise.all(hashes.map(ensureAsset))
}

/** Total bytes of Tier-2 content the manifest names (for the consent notice). */
export function tier2FootprintBytes(panels: readonly UiManifestPanel[]): number {
  let total = 0
  for (const panel of panels) {
    if (panel.tier !== 2) continue
    total += panel.entry?.size ?? 0
    for (const asset of panel.assets ?? []) total += asset.size
  }
  return total
}
