// The session report: the scoreboard as the server wrote it, and the page — offered by
// reference in the result, fetched by hash at once, then saved or opened natively, never shown
// in this window. Results are the engine's own (`fixtures/actions.json`).

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"

const native = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, convertFileSrc: (path: string) => path }))
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: native.save, open: vi.fn() }))

import { flush } from "../../../lib/connection.testkit"
import { TestRoom, actionResult, resultBody } from "../room.testkit"
import ReportScreen from "./ReportScreen"

const PAGE = (actionResult("reportHtml") as { data: { media: { hash: string; name: string } } }).data.media
const REVEAL = (actionResult("reportReveal") as { data: { media: { hash: string; name: string } } }).data
  .media

let room: TestRoom | null = null
beforeEach(() => {
  native.invoke.mockReset().mockResolvedValue(17057)
  native.save.mockReset()
})
afterEach(() => {
  room?.close()
  room = null
})

async function open(role: "player" | "admin") {
  room = await TestRoom.open(role)
  await room.actionViews(role)
  render(<ReportScreen onBack={() => {}} />)
  return room
}

describe("ReportScreen", () => {
  it("shows the scoreboard as the server wrote it", async () => {
    const r = await open("player")
    await userEvent.setup().click(screen.getByRole("button", { name: "Show the scoreboard" }))
    expect(r.commands()).toEqual([{ id: "report", args: {} }])
    await r.answer(resultBody("reportText"))
    expect(screen.getByRole("status")).toHaveTextContent("Nobody rolled a die this session.")
  })

  it("fetches the page by the hash the result names, at once, then saves it where asked", async () => {
    const r = await open("player")
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Make the page" }))
    expect(r.commands()).toEqual([{ id: "report", args: { format: "html" } }])
    await r.answer(resultBody("reportHtml"))
    await act(async () => flush(10))
    expect(native.invoke).toHaveBeenCalledWith("report_fetch", { hash: PAGE.hash })
    expect(screen.getByText("Session report ready")).toBeInTheDocument()
    native.save.mockResolvedValue("/home/ada/report.html")
    await user.click(screen.getByRole("button", { name: "Save…" }))
    expect(native.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: PAGE.name }))
    expect(native.invoke).toHaveBeenCalledWith("report_save", {
      hash: PAGE.hash,
      path: "/home/ada/report.html",
    })
    expect(screen.getByText("Saved to /home/ada/report.html")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Open in browser" }))
    expect(native.invoke).toHaveBeenCalledWith("report_open", { hash: PAGE.hash, name: PAGE.name })
  })

  it("shows a refused fetch in the server's words (a page already replaced)", async () => {
    const r = await open("player")
    native.invoke.mockRejectedValue({ code: "media_not_found", message: "No such file.", server: true })
    await userEvent.setup().click(screen.getByRole("button", { name: "Make the page" }))
    await r.answer(resultBody("reportHtml"))
    await act(async () => flush(10))
    expect(screen.getByRole("alert")).toHaveTextContent("No such file.")
  })

  it("never offers a player the reveal edition", async () => {
    await open("player")
    expect(screen.queryByRole("button", { name: "Reveal edition…" })).toBeNull()
  })

  it("asks the room admin before the reveal edition, which says it holds spoilers", async () => {
    const r = await open("admin")
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Reveal edition…" }))
    expect(r.commands()).toEqual([])
    expect(screen.getByRole("alert")).toHaveTextContent("prints everything hidden from the players")
    await user.click(screen.getByRole("button", { name: "Make the reveal edition" }))
    expect(r.commands()).toEqual([{ id: "report", args: { format: "html", reveal: true } }])
    await r.answer(resultBody("reportReveal"))
    await act(async () => flush(10))
    expect(native.invoke).toHaveBeenCalledWith("report_fetch", { hash: REVEAL.hash })
    expect(screen.getByText("Spoilers")).toBeInTheDocument()
  })
})
