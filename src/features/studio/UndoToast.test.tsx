import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { UNDO_WINDOW_MS, useUndoStore } from "../../store/undo"
import UndoToast from "./UndoToast"

describe("UndoToast", () => {
  beforeEach(() => useUndoStore.getState().clear())

  it("shows nothing when there is nothing to take back", () => {
    const { container } = render(<UndoToast />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names what was deleted and restores it on click", async () => {
    const restore = vi.fn()
    useUndoStore.getState().push("variable", "fear", restore)
    render(<UndoToast />)

    expect(screen.getByRole("status")).toHaveTextContent("Deleted the variable “fear”.")
    await userEvent.click(screen.getByRole("button", { name: /Undo/ }))
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it("falls back to an unnamed phrasing rather than empty quotes", () => {
    useUndoStore.getState().push("loreEntry", "   ", () => {})
    render(<UndoToast />)
    expect(screen.getByRole("status")).toHaveTextContent("Deleted a lore entry.")
  })

  it("dismisses without restoring", async () => {
    const restore = vi.fn()
    useUndoStore.getState().push("packItem", "cover.png", restore)
    render(<UndoToast />)
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(restore).not.toHaveBeenCalled()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("goes away once the offer has aged out", () => {
    vi.useFakeTimers()
    try {
      useUndoStore.getState().push("pregen", "Hana", () => {})
      const { container } = render(<UndoToast />)
      expect(screen.getByRole("status")).toBeInTheDocument()
      act(() => vi.advanceTimersByTime(UNDO_WINDOW_MS + 1000))
      expect(container).toBeEmptyDOMElement()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops its clock when the offer expires, instead of ticking all session", () => {
    // Nothing else changes the newest entry, so an interval left running here
    // re-renders the app twice a second forever over a toast nobody can see.
    vi.useFakeTimers()
    try {
      useUndoStore.getState().push("pregen", "Hana", () => {})
      render(<UndoToast />)
      act(() => vi.advanceTimersByTime(UNDO_WINDOW_MS + 1000))
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
