// The blocks vocabulary of protocol 3.0 §8.3, and choices that run as commands.
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import type { Block } from "loreweaver-protocol/v3"
import "../../i18n"
import { TestRoom } from "./room.testkit"
import UiBlocks from "./UiBlocks"

const BLOCKS: Block[] = [
  { kind: "meter", label: "Tide", value: 7, min: 0, max: 10 },
  { kind: "stat", label: "Lanterns", value: 9 },
  { kind: "badge", label: "Flooding", tone: "danger" },
  { kind: "text", text: "The water is rising.", style: "warning" },
  { kind: "divider" },
  {
    kind: "choices",
    prompt: "What now?",
    options: [
      { id: "wade", label: "Wade in", command: "roll", args: { expr: "1d100" } },
      { id: "wait", label: "Wait", command: "duel/strike" },
    ],
  },
]

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
})

describe("UiBlocks", () => {
  it("renders every simple block kind, and skips one this version does not know", () => {
    const { container } = render(
      <UiBlocks blocks={[...BLOCKS, { kind: "hologram", label: "?" } as unknown as Block]} />,
    )
    expect(screen.getByText("Tide")).toBeInTheDocument()
    expect(screen.getByText("7/10")).toBeInTheDocument()
    expect(screen.getByText("Lanterns")).toBeInTheDocument()
    expect(screen.getByText("Flooding")).toHaveClass("badge-danger")
    expect(screen.getByText("The water is rising.")).toHaveClass("is-warning")
    expect(container.querySelector(".ui-divider")).not.toBeNull()
    expect(screen.getByText("What now?")).toBeInTheDocument()
    expect(container).not.toHaveTextContent("?hologram")
  })

  it("runs a choice as `command.run {id: command, args}`, as the member pressing it", async () => {
    room = await TestRoom.open("player", { views: false })
    const user = userEvent.setup()
    render(<UiBlocks blocks={BLOCKS} />)
    await user.click(screen.getByRole("button", { name: "Wade in" }))
    await user.click(screen.getByRole("button", { name: "Wait" }))
    expect(room.commands()).toEqual([
      { id: "roll", args: { expr: "1d100" } },
      { id: "duel/strike", args: {} },
    ])
  })

  it("shows a choice's refusal as the server wrote it", async () => {
    room = await TestRoom.open("player", { views: false })
    const user = userEvent.setup()
    render(<UiBlocks blocks={BLOCKS} />)
    await user.click(screen.getByRole("button", { name: "Wait" }))
    await room.answer({ ok: false, error: { code: "module_unavailable", message: "The duel is over." } })
    expect(screen.getByRole("alert")).toHaveTextContent("The duel is over.")
  })

  it("disables choices while not online", async () => {
    room = await TestRoom.open("player", { views: false })
    await room.drop()
    render(<UiBlocks blocks={BLOCKS} />)
    expect(screen.getByRole("button", { name: "Wade in" })).toBeDisabled()
  })
})
