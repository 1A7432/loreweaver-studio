import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import "./i18n"
import App from "./App"
import { useAppStore } from "./store/app"

describe("App shell", () => {
  beforeEach(() => {
    useAppStore.setState({ mode: "play" })
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
})
