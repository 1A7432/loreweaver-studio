import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "./i18n"
import App from "./App"
import { guardedLocalStorage, resetPersistenceState } from "./lib/persistStorage"
import { useAppStore } from "./store/app"

const storage = guardedLocalStorage!

describe("App shell", () => {
  beforeEach(() => {
    useAppStore.setState({ mode: "play" })
    resetPersistenceState()
  })

  it("renders the app title", () => {
    render(<App />)
    expect(screen.getByRole("heading", { name: "Loreweaver Studio" })).toBeInTheDocument()
  })

  it("starts in play mode and switches to studio mode", async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(screen.getByRole("heading", { name: "Join a table" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Studio" }))
    expect(screen.getByText(/start forging/i)).toBeInTheDocument()
  })

  it("shows a persistence-failure banner as soon as the first write fails", async () => {
    const user = userEvent.setup()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("exceeded the quota", "QuotaExceededError")
    })
    render(<App />)
    expect(screen.queryByRole("alert")).toBeNull()

    act(() => {
      void storage.setItem("k", { state: {}, version: 1 })
    })
    expect(screen.getByRole("alert")).toHaveTextContent(/not being saved/)

    await user.click(screen.getByRole("button", { name: "Studio" }))
    expect(screen.getByRole("alert")).toHaveTextContent(/not being saved/)
    vi.restoreAllMocks()
    resetPersistenceState()
  })
})
