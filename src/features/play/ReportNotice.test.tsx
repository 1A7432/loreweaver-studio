import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({
  reportFetch: vi.fn(async () => 2048),
  reportSave: vi.fn(async () => 2048),
  reportOpen: vi.fn(async () => "/cache/report.html"),
}))
vi.mock("../../lib/report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/report")>()
  return { ...actual, ...native }
})
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => null) }))
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: async () => "/dl",
  join: async (...parts: string[]) => parts.join("/"),
}))
vi.mock("../../lib/transport", () => ({
  TRANSPORT_EVENT: "loreweaver://transport",
  isTauri: () => true,
  transportSend: async () => {},
}))

import i18n from "../../i18n"
import { useConnectionStore } from "../../store/connection"
import { useReportStore } from "../../store/report"
import { useSessionStore } from "../../store/session"
import ReportNotice from "./ReportNotice"

const HASH = "cd".repeat(32)
const FRAME = {
  type: "report" as const,
  hash: HASH,
  name: "loreweaver-report-tide-20261016-120000.html",
  size: 2048,
  mime: "text/html" as const,
  variant: "player" as const,
}

async function offer(variant: "player" | "reveal") {
  await act(async () => {
    useReportStore.getState().ingest({ ...FRAME, variant })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe("ReportNotice", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    useReportStore.getState().reset()
    await i18n.changeLanguage("en")
  })

  it("renders nothing until a report arrives", () => {
    const { container } = render(<ReportNotice />)
    expect(container).toBeEmptyDOMElement()
  })

  it("offers the player edition with Save and Open, and no spoiler cue", async () => {
    render(<ReportNotice />)
    await offer("player")
    expect(screen.getByText("Session report ready")).toBeInTheDocument()
    expect(screen.getByText(FRAME.name)).toBeInTheDocument()
    expect(screen.queryByText("Spoilers")).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveAttribute("data-variant", "player")

    await userEvent.click(screen.getByRole("button", { name: "Open in browser" }))
    expect(native.reportOpen).toHaveBeenCalledWith(HASH, FRAME.name)
  })

  it("marks the reveal edition unmistakably as spoilers", async () => {
    render(<ReportNotice />)
    await offer("reveal")
    const row = screen.getByRole("status")
    expect(row).toHaveAttribute("data-variant", "reveal")
    expect(row).toHaveClass("report-notice-reveal")
    expect(screen.getByText("Debrief edition ready")).toBeInTheDocument()
    expect(screen.getByText("Spoilers")).toBeInTheDocument()
    expect(screen.getByText(/don't share it mid-campaign/)).toBeInTheDocument()
  })

  it("says so in Chinese too", async () => {
    await i18n.changeLanguage("zh")
    render(<ReportNotice />)
    await offer("reveal")
    expect(screen.getByText("复盘版团报已就绪")).toBeInTheDocument()
    expect(screen.getByText("含剧透")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "保存…" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "在浏览器中打开" })).toBeInTheDocument()
  })

  it("shows a checksum failure with no way to save or open the bytes", async () => {
    native.reportFetch.mockRejectedValueOnce(new Error("hash mismatch: expected x, got y"))
    render(<ReportNotice />)
    await offer("player")
    expect(screen.getByText(/did not match its checksum/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Save…" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open in browser" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(useReportStore.getState().offers).toEqual([])
  })

  it("never puts the report's HTML into the studio's own UI", async () => {
    const { container } = render(<ReportNotice />)
    await offer("reveal")
    expect(container.querySelector("iframe, webview, object, embed")).toBeNull()
  })

  it("is routed off the connection, not into the chronicle", () => {
    useSessionStore.getState().clear()
    useConnectionStore.setState({ connectionId: "gen-report" })
    useConnectionStore.getState().handleEvent({
      kind: "frame",
      connectionId: "gen-report",
      frame: FRAME,
    } as Parameters<ReturnType<typeof useConnectionStore.getState>["handleEvent"]>[0])
    expect(useReportStore.getState().offers.map((o) => o.hash)).toEqual([HASH])
    expect(useSessionStore.getState().entries).toEqual([])
  })
})
