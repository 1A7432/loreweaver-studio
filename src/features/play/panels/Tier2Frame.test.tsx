// The parked 2.x page host (not rendered: a 3.0 page panel shows its fallback). Its
// isolation contract stays pinned until the 3.0 page bridge replaces it.
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UiManifestPanel } from "@loreweaver/protocol"
import "../../../i18n"
import Tier2Frame from "./Tier2Frame"

vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>()
  return {
    ...actual,
    ensurePanelAssets: vi.fn().mockResolvedValue(undefined),
    panelServeRegister: vi.fn().mockResolvedValue(undefined),
    panelServeUnregister: vi.fn().mockResolvedValue(undefined),
    panelEntryUrl: vi.fn((token: string) => `panel://localhost/${token}/__entry__.html`),
  }
})

import { ensurePanelAssets, panelServeRegister } from "./assets"

const MANOR_MAP: UiManifestPanel = {
  id: "blackmoor/manor-map",
  title: { en: "Manor Map", zh: "庄园地图" },
  slot: "modal",
  tier: 2,
  entry: { hash: "c".repeat(64), size: 1024 * 1024 },
  assets: [{ path: "app.js", hash: "a".repeat(64), size: 1024 * 1024, mime: "text/javascript" }],
  fallback: [{ kind: "text", text: { en: "Map available in the rich client." } }],
}

const FALLBACK = <p>Map available in the rich client.</p>

beforeEach(() => {
  vi.mocked(ensurePanelAssets).mockClear().mockResolvedValue(undefined)
  vi.mocked(panelServeRegister).mockClear().mockResolvedValue(undefined)
})

describe("Tier2Frame", () => {
  it("mounts a strictly sandboxed iframe from the registered namespace", async () => {
    const { container } = render(<Tier2Frame panel={MANOR_MAP} fallback={FALLBACK} />)
    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe")
      if (!el) throw new Error("iframe not mounted yet")
      return el
    })
    // The isolation contract: allow-scripts alone — never allow-same-origin.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(iframe.getAttribute("src")).toMatch(/^panel:\/\/localhost\/[0-9a-f]{32}\/__entry__\.html$/)
    expect(iframe.getAttribute("title")).toBe("Manor Map")

    expect(ensurePanelAssets).toHaveBeenCalledWith(MANOR_MAP)
    const registration = vi.mocked(panelServeRegister).mock.calls[0][0]
    expect(registration.token).toMatch(/^[0-9a-f]{32}$/)
    expect(registration.entryHash).toBe(MANOR_MAP.entry?.hash)
    expect(registration.assets).toEqual([{ path: "app.js", hash: "a".repeat(64), mime: "text/javascript" }])
    expect(registration.bootstrapJs).toContain("window.loreweaver")
    expect(registration.themeCss).toContain(":root {")
  })

  it("shows the fallback the moment the panel reports a crash, with its own line", async () => {
    const { container } = render(<Tier2Frame panel={MANOR_MAP} fallback={FALLBACK} />)
    const iframe = await waitFor(() => {
      const el = container.querySelector("iframe")
      if (!el) throw new Error("iframe not mounted yet")
      return el
    })
    // The mount's nonce is only ever handed to the panel — read it back out of
    // the bootstrap the host registered, exactly as the iframe would.
    const registration = vi.mocked(panelServeRegister).mock.calls.at(-1)![0]
    const nonce = /var NONCE = "([0-9a-f]{32})"/.exec(registration.bootstrapJs)![1]

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { lw: "1", nonce, type: "panel_error", message: "TypeError: x is not a function" },
          source: iframe.contentWindow,
        }),
      )
    })

    // No waiting out the 6s handshake deadline: stalled, now.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The panel reported: TypeError: x is not a function",
    )
    expect(screen.getByText("Map available in the rich client.")).toBeInTheDocument()
  })

  it("ignores a crash forged with the wrong nonce", async () => {
    const { container } = render(<Tier2Frame panel={MANOR_MAP} fallback={FALLBACK} />)
    await waitFor(() => {
      const el = container.querySelector("iframe")
      if (!el) throw new Error("iframe not mounted yet")
      return el
    })
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { lw: "1", nonce: "0".repeat(32), type: "panel_error", message: "boom" },
          source: container.querySelector("iframe")!.contentWindow,
        }),
      )
    })
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("falls back with a retry line when assets fail", async () => {
    const user = userEvent.setup()
    vi.mocked(ensurePanelAssets).mockRejectedValueOnce(new Error("offline"))
    const { container } = render(<Tier2Frame panel={MANOR_MAP} fallback={FALLBACK} />)
    expect(await screen.findByText("Panel assets failed to load.")).toBeInTheDocument()
    expect(screen.getByText("Map available in the rich client.")).toBeInTheDocument()
    expect(container.querySelector("iframe")).toBeNull()

    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => {
      if (!container.querySelector("iframe")) throw new Error("iframe not mounted after retry")
    })
  })
})
