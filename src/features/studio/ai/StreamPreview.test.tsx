import { act, render, renderHook, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { StreamPreview } from "./StreamPreview"
import { useDraftStream } from "./useDraftStream"

describe("useDraftStream", () => {
  it("accumulates deltas and clears on the next attempt's start", () => {
    const { result } = renderHook(() => useDraftStream())
    act(() => {
      result.current.onStream({ kind: "start", attempt: 1 })
      result.current.onStream({ kind: "delta", text: "夜航" })
      result.current.onStream({ kind: "delta", text: "灯塔" })
    })
    expect(result.current.text).toBe("夜航灯塔")
    // A validation retry REPLACES the rejected draft on screen, exactly as it
    // replaces it in the result — attempt 2 must not append to attempt 1.
    act(() => result.current.onStream({ kind: "start", attempt: 2 }))
    expect(result.current.text).toBe("")
  })
})

describe("StreamPreview", () => {
  it("renders only while busy and non-empty", () => {
    const { rerender } = render(<StreamPreview text="drafting…" busy={true} />)
    expect(screen.getByText("drafting…")).toBeInTheDocument()
    rerender(<StreamPreview text="drafting…" busy={false} />)
    expect(screen.queryByText("drafting…")).not.toBeInTheDocument()
    rerender(<StreamPreview text="" busy={true} />)
    expect(document.querySelector(".ai-stream-preview")).toBeNull()
  })
})
