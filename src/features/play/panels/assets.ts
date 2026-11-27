// The typed face of the native asset machinery: the sha256 disk cache (`asset_fetch` pulls a
// miss over the live connection's byte channel, protocol 3.0 §11.3) and the `panel://` serve
// registry a page panel's frame loads from. A page's bytes never enter the WebView: the scheme
// handler serves them from the verified cache.

import { convertFileSrc, invoke } from "@tauri-apps/api/core"
import type { PanelEntry } from "loreweaver-protocol/v3"

export function assetCacheStatus(hashes: string[]): Promise<boolean[]> {
  return invoke<boolean[]>("asset_cache_status", { hashes })
}

export function assetFetch(hash: string): Promise<number> {
  return invoke<number>("asset_fetch", { hash })
}

/** Read a CACHED blob back as base64 — the read half of {@link assetFetch}, for inert
 * pictures and sounds (never for a page: a page is served to its frame by the scheme). */
export function assetReadBase64(hash: string): Promise<string> {
  return invoke<string>("asset_read_base64", { hash })
}

/** Mount one page: its frame's token names the page's hash, with the host's head. */
export function panelServeRegister(args: {
  token: string
  hash: string
  bootstrapJs: string
  themeCss: string
}): Promise<void> {
  return invoke<void>("panel_serve_register", { ...args })
}

export function panelServeUnregister(token: string): Promise<void> {
  return invoke<void>("panel_serve_unregister", { token })
}

/** Mirrors `panel_serve::ENTRY_PATH`: the one file a registration serves. */
export const PANEL_ENTRY_FILE = "page.html"

/** The frame `src` for a mounted page.
 *
 * `convertFileSrc` runs `encodeURIComponent` over the WHOLE path it is given, so handing it
 * `<token>/<file>` yields one `%2F`-joined segment — which the scheme handler reads as a
 * single bogus token and 404s. Build the base from the token alone (32 hex chars,
 * encoding-invariant) and append the file as a real path segment. */
export function panelEntryUrl(token: string): string {
  return `${convertFileSrc(token, "panel")}/${PANEL_ENTRY_FILE}`
}

// Pages are content-addressed; two mounts of one page share one pull.
const inflight = new Map<string, Promise<void>>()

/** Pull a page's HTML into the verified cache by its hash (a hit costs nothing). */
export function ensurePage(hash: string): Promise<void> {
  const existing = inflight.get(hash)
  if (existing) return existing
  const pull = assetFetch(hash)
    .then(() => undefined)
    .finally(() => inflight.delete(hash))
  inflight.set(hash, pull)
  return pull
}

/** Total bytes of page HTML the `panels` view names (for the consent notice). */
export function pageFootprintBytes(panels: readonly PanelEntry[]): number {
  let total = 0
  for (const panel of panels) if (panel.kind === "page") total += panel.page?.size ?? 0
  return total
}
