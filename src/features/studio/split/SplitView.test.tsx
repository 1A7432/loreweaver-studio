import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { useSplitStore } from "../../../store/split"
import { useStudioStore } from "../../../store/studio"
import SplitView from "./SplitView"

const encoder = new TextEncoder()

vi.mock("../../../lib/native", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../lib/native")>()
  return {
    ...original,
    pickCardFile: vi.fn(async () => ({
      name: "heavy.json",
      path: null,
      bytes: encoder.encode(
        JSON.stringify({
          spec: "chara_card_v3",
          data: {
            name: "深渊之主",
            description: "harbor <%= getvar('mood') %>",
            extensions: { loreweaver_hooks: ["on('turn_start', () => {})"] },
            character_book: {
              entries: [
                { comment: "[InitVar]", content: '{"理": {"好感度": [10, "0..100"]}}' },
                { comment: "Pier", content: "plain lore" },
              ],
            },
          },
        }),
      ),
    })),
  }
})

function reset() {
  useStudioStore.setState({ projects: [], activeUid: null, tab: "card", view: "split" })
  // The session persists now, so a test that wants an empty bench has to say so.
  useSplitStore.getState().clear()
}

describe("SplitView", () => {
  beforeEach(reset)

  it("opens a heavy card and shows both halves with payload counts", async () => {
    const user = userEvent.setup()
    render(<SplitView />)
    await user.click(screen.getByRole("button", { name: "Open a card…" }))

    expect(await screen.findByText("Character half")).toBeInTheDocument()
    expect(screen.getByText("World half")).toBeInTheDocument()
    expect(screen.getByText(/1 hook script/)).toBeInTheDocument()
    expect(screen.getByText("carries world machinery")).toBeInTheDocument()

    // EJS stripped from the editable character half…
    const description = screen.getByLabelText("Description")
    expect(description).toHaveValue("harbor ")
    // …and the promotion row landed with the guessed bounds.
    expect(screen.getByDisplayValue("好感度")).toBeInTheDocument()
    expect(screen.getByText(".var expose 理")).toBeInTheDocument()
  })

  it("hands the split off to the forge editor as a project", async () => {
    const user = userEvent.setup()
    render(<SplitView />)
    await user.click(screen.getByRole("button", { name: "Open a card…" }))
    await screen.findByText("Character half")
    await user.click(screen.getByRole("button", { name: "Edit in the forge" }))

    const state = useStudioStore.getState()
    expect(state.view).toBe("forge")
    expect(state.projects).toHaveLength(1)
    expect(state.projects[0].name).toBe("深渊之主")
    expect(state.projects[0].variables).toHaveLength(1)
    expect(state.projects[0].hooks).toContain("turn_start")
    expect(state.projects[0].lorebook).toHaveLength(1)
  })

  it("survives an unmount — a tab switch no longer destroys the session", async () => {
    const user = userEvent.setup()
    const first = render(<SplitView />)
    await user.click(screen.getByRole("button", { name: "Open a card…" }))
    await screen.findByText("Character half")
    await user.clear(screen.getByLabelText("Description"))
    await user.type(screen.getByLabelText("Description"), "rewritten by hand")
    first.unmount()

    render(<SplitView />)
    expect(await screen.findByText("Character half")).toBeInTheDocument()
    expect(screen.getByLabelText("Description")).toHaveValue("rewritten by hand")
  })
})
