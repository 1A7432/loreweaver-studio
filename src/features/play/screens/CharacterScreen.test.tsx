// The character screen's jobs: make one, claim one, change one. Everything goes out as a
// `command.run` with the `commands` view's argument names, and everything the screen
// knows about a rule system it learned from the views — pinned here, because the failure
// mode is a client quietly growing its own copy of CoC and D&D.

import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import "../../../i18n"

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, convertFileSrc: (path: string) => path }))
vi.mock("../../../lib/native", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/native")>()),
  pickUploadPath: vi.fn(async () => "/cards/captain.png"),
}))

import { flush } from "../../../lib/connection.testkit"
import { TestRoom, fixtureView, resultBody } from "../room.testkit"
import CharacterScreen from "./CharacterScreen"
import { sheetSetArgs } from "./sheetWrite"

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
})

/** A player with no character yet: the fixture room, unseated. */
async function unseated() {
  const r = await TestRoom.open("player")
  await r.view("me", { ...fixtureView("player", "me"), character: null })
  await r.view("characters", { ...fixtureView("player", "characters"), mine: null })
  room = r
  return r
}

async function seated() {
  room = await TestRoom.open("player")
  return room
}

/** The sheet row labelled `label`. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest("tr") as HTMLElement
}

describe("CharacterScreen — no character yet", () => {
  it("offers the systems the SERVER listed, the room's own first, and rolls in the chosen one", async () => {
    const r = await unseated()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    const picker = screen.getByLabelText("Rule system") as HTMLSelectElement
    expect(Array.from(picker.options).map((option) => [option.value, option.text])).toEqual([
      ["coc7", "CoC"],
      ["dnd5e", "DnD5e"],
    ])
    expect(picker.value).toBe("coc7")
    await user.selectOptions(picker, "dnd5e")
    await user.type(screen.getByLabelText("Name"), "  Mira  ")
    await user.click(screen.getByRole("button", { name: "Create character" }))
    expect(r.commands()).toEqual([{ id: "new_character", args: { system: "dnd5e", name: "Mira" } }])
  })

  it("lets the server name the character when the name is left empty, and shows a refusal", async () => {
    const r = await unseated()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    await user.click(screen.getByRole("button", { name: "Create character" }))
    expect(r.commands()).toEqual([{ id: "new_character", args: { system: "coc7" } }])
    await r.answer({
      ok: false,
      error: { code: "name_taken", message: "Someone at this table is already called that." },
    })
    expect(screen.getByRole("alert")).toHaveTextContent("Someone at this table is already called that.")
  })

  it("offers the room's cast to claim beside the creation form", async () => {
    const r = await unseated()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    await user.click(screen.getByRole("button", { name: "Claim" }))
    expect(r.commands()).toEqual([{ id: "pc", args: { op: "claim", name: "pregen-holmes" } }])
  })

  it("says so plainly when the room offers no system", async () => {
    const r = await unseated()
    await r.view("characters", { claimable: [], systems: [], mine: null })
    render(<CharacterScreen onBack={() => {}} />)
    expect(screen.getByText(/no rule system to make a character in/)).toBeInTheDocument()
  })
})

describe("CharacterScreen — the sheet", () => {
  it("shows the sheet from `me`: each value under its label in the viewer's language", async () => {
    await seated()
    render(<CharacterScreen onBack={() => {}} />)
    expect(screen.getByRole("heading", { name: /Ada Lovelace/ })).toBeInTheDocument()
    expect(row("Max HP")).toHaveTextContent("10")
    expect(screen.getByText("Max HP")).toHaveAttribute("title", "HPMAX")
    expect(row("Accounting")).toHaveTextContent("5")
  })

  it("writes one value through `sheet set` with the sheet's own key and the explicit `=`", async () => {
    const r = await seated()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    await user.click(within(row("Luck")).getByRole("button", { name: "50" }))
    const box = screen.getByLabelText("Luck")
    await user.clear(box)
    await user.type(box, "-5{Enter}")
    expect(r.commands()).toEqual([
      { id: "sheet", args: { op: "set", writes: [{ name: "LUC", op: "=", value: "-5" }] } },
    ])
    expect(sheetSetArgs("会计", 30)).toEqual({ op: "set", writes: [{ name: "会计", op: "=", value: "30" }] })
  })

  it("edits through a text box, because pasting into a number box took the app down", async () => {
    // Three times out of three, ⌘V into this field reloaded the whole WebView (2026-08-20
    // play-test) — a crash below our floor, in WebKit's native paste path for
    // `<input type=number>`. Pinned so nobody "tidies" it back.
    const r = await seated()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    await user.click(within(row("STR")).getByRole("button", { name: "50" }))
    const box = screen.getByLabelText("STR")
    expect(box).toHaveAttribute("type", "text")
    expect(box).toHaveAttribute("inputMode", "numeric")
    await user.clear(box)
    await user.paste("  62  ")
    await user.keyboard("{Enter}")
    expect(r.commands()).toEqual([
      { id: "sheet", args: { op: "set", writes: [{ name: "STR", op: "=", value: "62" }] } },
    ])
  })

  it("clears the draft on Escape, and sends nothing for an unchanged value", async () => {
    const r = await seated()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    await user.click(within(row("STR")).getByRole("button", { name: "50" }))
    await user.type(screen.getByLabelText("STR"), "70{Escape}")
    expect(screen.queryByLabelText("STR")).toBeNull()
    await user.click(within(row("CON")).getByRole("button", { name: "50" }))
    await user.type(screen.getByLabelText("CON"), "{Enter}")
    expect(r.commands()).toEqual([])
  })

  it("shows what the server answered a write, and the next `me` value is the truth", async () => {
    const r = await seated()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    await user.click(within(row("STR")).getByRole("button", { name: "50" }))
    const box = screen.getByLabelText("STR")
    await user.clear(box)
    await user.type(box, "999{Enter}")
    await r.answer({ ok: false, error: { code: "sheet_refused", message: "STR must be between 15 and 90." } })
    expect(screen.getByRole("alert")).toHaveTextContent("STR must be between 15 and 90.")
    expect(within(row("STR")).getByRole("button", { name: "50" })).toBeInTheDocument()
  })

  it("re-derives vitals and asks before deleting, through the `sheet` command", async () => {
    const r = await seated()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    await user.click(screen.getByRole("button", { name: "Re-derive vitals" }))
    expect(r.commands()).toEqual([{ id: "sheet", args: { op: "finalize" } }])
    await r.answer({ ok: true, text: "Ada Lovelace is finalized." })
    await user.click(screen.getByRole("button", { name: "Delete character" }))
    expect(r.commands()).toHaveLength(1)
    await user.click(screen.getByRole("button", { name: "Delete for good" }))
    expect(r.commands()).toEqual([
      { id: "sheet", args: { op: "finalize" } },
      { id: "sheet", args: { op: "clear" } },
    ])
  })
})

describe("CharacterScreen — a character from words or from a card file", () => {
  /** An unseated player in the engine's file-keeping bench, whose command table offers `genchar` and `import`. */
  async function bench() {
    const r = await unseated()
    await r.actionViews("player")
    return r
  }

  function section(title: string): HTMLElement {
    return screen.getByRole("heading", { name: title }).closest(".play-form") as HTMLElement
  }

  it("describes a character with genchar, says it is working, and shows the sheet it made", async () => {
    const r = await bench()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    const form = section("Describe a character")
    await user.type(
      within(form).getByLabelText("Description"),
      "a retired sea captain, stubborn, good with knots and a rifle",
    )
    await user.type(within(form).getByLabelText("Name"), "Ada Lin")
    await user.click(within(form).getByRole("button", { name: "Make this character" }))
    expect(r.commands()).toEqual([
      {
        id: "genchar",
        args: {
          description: "a retired sea captain, stubborn, good with knots and a rifle",
          name: "Ada Lin",
        },
      },
    ])
    expect(within(form).getByRole("button", { name: "Making…" })).toBeDisabled()
    expect(within(form).getByRole("status")).toHaveTextContent("The model is working on it")
    await r.answer(resultBody("gencharOk"))
    expect(within(form).getByRole("status")).toHaveTextContent("You now play Ada Lin (CoC)")
  })

  it("shows genchar's refusal in the server's words", async () => {
    const r = await bench()
    const user = userEvent.setup()
    render(<CharacterScreen onBack={() => {}} />)
    const form = section("Describe a character")
    await user.type(within(form).getByLabelText("Description"), "a tired harbour pilot who knows every reef")
    await user.selectOptions(within(form).getByLabelText("Rule system"), "dnd5e")
    await user.click(within(form).getByRole("button", { name: "Make this character" }))
    expect(r.commands().at(-1)).toEqual({
      id: "genchar",
      args: { description: "a tired harbour pilot who knows every reef", system: "dnd5e" },
    })
    await r.answer(resultBody("gencharNoModel"))
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "The model's answer could not be used (model_failed).",
    )
  })

  it("imports a card of my own: uploaded for import, then imported as my character", async () => {
    const r = await bench()
    const card = { name: "captain.png", mime: "image/png", size: 2048, sha256: "d".repeat(64) }
    native.invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === "media_prepare") return card
      if (command === "media_upload")
        return { hash: card.sha256, size: card.size, mime: card.mime, name: card.name }
      throw new Error(command)
    })
    render(<CharacterScreen onBack={() => {}} />)
    const form = section("My own card")
    await userEvent.setup().click(within(form).getByRole("button", { name: "Pick a card file…" }))
    await r.feed()
    expect(native.invoke).toHaveBeenCalledWith("media_prepare", {
      path: "/cards/captain.png",
      purpose: "import",
    })
    expect(r.lastRequest()).toMatchObject({ method: "media.offer", params: { ...card, purpose: "import" } })
    await r.answer({ ok: true, data: { upload_id: "u-card" } })
    await act(async () => flush(10))
    expect(r.commands()).toEqual([{ id: "import", args: { file: card.sha256, as: "character" } }])
    await r.answer(resultBody("importNotUploaded"))
    expect(within(form).getByRole("alert")).toHaveTextContent(
      "You have not uploaded a file with that hash for import.",
    )
  })
})
