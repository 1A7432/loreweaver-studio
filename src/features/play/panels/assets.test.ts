// The panel URL shape is a CONTRACT with the Rust scheme handler
// (`panel_serve::split_token_path`): real `/` separators, one segment per path
// element. It broke in the real WKWebView shell — `convertFileSrc` percent-
// encodes the whole path, so `<token>/__entry__.html` arrived as a single
// `%2F`-joined segment, the handler 404'd, and every Tier-2 panel silently
// stayed blank. This test pins the shape.

import { describe, expect, it, vi } from "vitest"

vi.mock("@tauri-apps/api/core", () => ({
  // The real implementation, verbatim in the part that matters: the whole
  // argument goes through encodeURIComponent.
  convertFileSrc: (path: string, protocol = "asset") => `${protocol}://localhost/${encodeURIComponent(path)}`,
  invoke: vi.fn(),
}))

const { PANEL_ENTRY_FILE, panelEntryUrl, tier2FootprintBytes } = await import("./assets")

const TOKEN = "579ec5a705780432add19ae72d312abe"

describe("panelEntryUrl", () => {
  it("keeps the token and the entry file in separate path segments", () => {
    const url = panelEntryUrl(TOKEN)
    expect(url).toBe(`panel://localhost/${TOKEN}/${PANEL_ENTRY_FILE}`)
    expect(url).not.toContain("%2F")
    // The handler splits on "/" and expects exactly [token, ...file segments].
    expect(new URL(url).pathname.split("/").slice(1)).toEqual([TOKEN, PANEL_ENTRY_FILE])
  })

  it("gives relative subresources the panel's own namespace as their base", () => {
    // `style.css` inside the document must resolve under the token, or the
    // per-panel CSP (`script-src <origin>/<token>/`) blocks it.
    const resolved = new URL("style.css", panelEntryUrl(TOKEN)).href
    expect(resolved).toBe(`panel://localhost/${TOKEN}/style.css`)
    const nested = new URL("__loreweaver__/bootstrap.js", panelEntryUrl(TOKEN)).href
    expect(nested).toBe(`panel://localhost/${TOKEN}/__loreweaver__/bootstrap.js`)
  })
})

describe("tier2FootprintBytes", () => {
  it("sums entry + declared assets across tier-2 panels only", () => {
    const bytes = tier2FootprintBytes([
      { id: "a/t1", title: { en: "t1" }, slot: "sidebar", tier: 1, blocks: [] },
      {
        id: "a/t2",
        title: { en: "t2" },
        slot: "modal",
        tier: 2,
        entry: { hash: "h", size: 100 },
        assets: [
          { path: "app.js", hash: "h2", size: 20, mime: "text/javascript" },
          { path: "style.css", hash: "h3", size: 5, mime: "text/css" },
        ],
        fallback: null,
      },
    ])
    expect(bytes).toBe(125)
  })
})
