import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReportFrame } from "@loreweaver/protocol"

const native = vi.hoisted(() => ({
  reportFetch: vi.fn(async (hash: string): Promise<number> => (hash ? 2048 : 0)),
  reportSave: vi.fn(async (hash: string, path: string) => (hash && path ? 2048 : 0)),
  reportOpen: vi.fn(async (hash: string, name: string) => `/cache/reports-open/${hash}/${name}`),
}))
const dialog = vi.hoisted(() => ({
  save: vi.fn(
    async (options?: { defaultPath?: string }): Promise<string | null> => options?.defaultPath ?? null,
  ),
}))
const transport = vi.hoisted(() => ({ isTauri: vi.fn(() => true) }))

vi.mock("../lib/report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/report")>()
  return { ...actual, ...native }
})
vi.mock("@tauri-apps/plugin-dialog", () => dialog)
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: async () => "/home/nyx/Downloads",
  join: async (...parts: string[]) => parts.join("/"),
}))
vi.mock("../lib/transport", () => ({ ...transport, TRANSPORT_EVENT: "loreweaver://transport" }))

import { reportErrorKey, reportVariant, useReportStore } from "./report"

const HASH = "ab".repeat(32)

function frame(overrides: Partial<ReportFrame> = {}): ReportFrame {
  return {
    type: "report",
    hash: HASH,
    name: "loreweaver-report-tide-20261016-120000.html",
    size: 2048,
    mime: "text/html",
    variant: "player",
    ...overrides,
  }
}

/** Let the fetch promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("report store", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transport.isTauri.mockReturnValue(true)
    useReportStore.getState().reset()
  })

  it("claims the report frame, fetches it at once, and offers it when verified", async () => {
    expect(useReportStore.getState().ingest(frame())).toBe(true)
    expect(native.reportFetch).toHaveBeenCalledWith(HASH)
    expect(useReportStore.getState().offers[0].phase).toBe("fetching")
    await settle()
    const offer = useReportStore.getState().offers[0]
    expect(offer.phase).toBe("ready")
    expect(offer.variant).toBe("player")
    expect(offer.fileName).toBe("loreweaver-report-tide-20261016-120000.html")
  })

  it("leaves every other frame alone", () => {
    expect(useReportStore.getState().ingest({ type: "pong", t: 1 })).toBe(false)
    expect(useReportStore.getState().offers).toEqual([])
  })

  it("never offers bytes that failed their sha256 check", async () => {
    native.reportFetch.mockRejectedValueOnce(new Error(`hash mismatch: expected ${HASH}, got deadbeef`))
    useReportStore.getState().ingest(frame())
    await settle()
    const offer = useReportStore.getState().offers[0]
    expect(offer.phase).toBe("error")
    expect(offer.error).toBe("play.report.err.checksum")
    await useReportStore.getState().save(HASH)
    await useReportStore.getState().openInBrowser(HASH)
    expect(dialog.save).not.toHaveBeenCalled()
    expect(native.reportSave).not.toHaveBeenCalled()
    expect(native.reportOpen).not.toHaveBeenCalled()
  })

  it("sanitizes the server's suggested name before anything uses it", async () => {
    useReportStore.getState().ingest(frame({ name: "../../../.ssh/authorized_keys" }))
    await settle()
    expect(useReportStore.getState().offers[0].fileName).toBe("authorized_keys.html")
    await useReportStore.getState().openInBrowser(HASH)
    expect(native.reportOpen).toHaveBeenCalledWith(HASH, "authorized_keys.html")
  })

  it("saves through the native dialog, defaulting to Downloads and the safe name", async () => {
    useReportStore.getState().ingest(frame())
    await settle()
    await useReportStore.getState().save(HASH)
    expect(dialog.save).toHaveBeenCalledWith({
      defaultPath: "/home/nyx/Downloads/loreweaver-report-tide-20261016-120000.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    })
    expect(native.reportSave).toHaveBeenCalledWith(
      HASH,
      "/home/nyx/Downloads/loreweaver-report-tide-20261016-120000.html",
    )
    expect(useReportStore.getState().offers[0].savedPath).toBe(
      "/home/nyx/Downloads/loreweaver-report-tide-20261016-120000.html",
    )
  })

  it("writes nothing when the save dialog is cancelled", async () => {
    dialog.save.mockResolvedValueOnce(null)
    useReportStore.getState().ingest(frame())
    await settle()
    await useReportStore.getState().save(HASH)
    expect(native.reportSave).not.toHaveBeenCalled()
    const offer = useReportStore.getState().offers[0]
    expect(offer.busy).toBe(false)
    expect(offer.savedPath).toBeNull()
  })

  it("keeps the offer usable when a save fails", async () => {
    native.reportSave.mockRejectedValueOnce(new Error("saving the report failed: permission denied"))
    useReportStore.getState().ingest(frame())
    await settle()
    await useReportStore.getState().save(HASH)
    const offer = useReportStore.getState().offers[0]
    expect(offer.phase).toBe("ready")
    expect(offer.actionError).toBe("saving the report failed: permission denied")
  })

  it("marks the reveal edition, and treats anything not explicitly the player edition as one", async () => {
    useReportStore.getState().ingest(frame({ variant: "reveal" }))
    await settle()
    expect(useReportStore.getState().offers[0].variant).toBe("reveal")
    expect(reportVariant("player")).toBe("player")
    expect(reportVariant("reveal")).toBe("reveal")
    expect(reportVariant("summary")).toBe("reveal")
    expect(reportVariant(undefined)).toBe("reveal")
  })

  it("names the reveal-on-a-player-connection refusal", async () => {
    native.reportFetch.mockRejectedValueOnce(new Error("media_not_found: unknown media hash"))
    useReportStore.getState().ingest(frame({ variant: "reveal" }))
    await settle()
    expect(useReportStore.getState().offers[0].error).toBe("play.report.err.notFound")
    expect(reportErrorKey(new Error('not a report: the server sent "image/png"'))).toBe(
      "play.report.err.notHtml",
    )
    expect(reportErrorKey("not connected")).toBe("play.report.err.offline")
  })

  it("drops a fetch that lands after the session was reset", async () => {
    let finish: (size: number) => void = () => {}
    native.reportFetch.mockImplementationOnce(() => new Promise<number>((resolve) => (finish = resolve)))
    useReportStore.getState().ingest(frame())
    useReportStore.getState().reset()
    finish(2048)
    await settle()
    expect(useReportStore.getState().offers).toEqual([])
  })

  it("replaces a re-announced hash, caps the list, and dismisses one row", async () => {
    const hashes = ["01", "02", "03", "04"].map((tag) => tag.repeat(32))
    for (const hash of hashes) useReportStore.getState().ingest(frame({ hash }))
    useReportStore.getState().ingest(frame({ hash: hashes[3], variant: "reveal" }))
    await settle()
    const offers = useReportStore.getState().offers
    expect(offers.map((offer) => offer.hash)).toEqual(hashes.slice(1))
    expect(offers.at(-1)?.variant).toBe("reveal")
    useReportStore.getState().dismiss(hashes[2])
    expect(useReportStore.getState().offers.map((offer) => offer.hash)).toEqual([hashes[1], hashes[3]])
  })

  it("says plainly that saving needs the desktop app outside the shell", () => {
    transport.isTauri.mockReturnValue(false)
    useReportStore.getState().ingest(frame())
    expect(native.reportFetch).not.toHaveBeenCalled()
    expect(useReportStore.getState().offers[0].error).toBe("play.report.err.unavailable")
  })
})
