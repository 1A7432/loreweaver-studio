// The desk cards, from the engine's own view values (fixtures/views.json) fed into a real
// session, and their actions as `command.run` calls with the `commands` view's arguments.
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import type { Role } from "loreweaver-protocol/v3"
import "../../i18n"
import { TestRoom, fixtureView } from "./room.testkit"
import StatePanel from "./StatePanel"

let room: TestRoom | null = null
afterEach(() => {
  room?.close()
  room = null
})

async function open(role: Role = "player") {
  room = await TestRoom.open(role)
  return room
}

function card(title: string): HTMLElement {
  const header = screen.getAllByText(title).find((el) => el.closest(".desk-card"))
  if (!header) throw new Error(`no card ${title}`)
  return header.closest(".desk-card") as HTMLElement
}

/** The `commands` view with `import` available, as in a room with an enabled pack. */
function withImport(role: Role) {
  const commands = fixtureView(role, "commands") as {
    commands: { id: string; available: boolean; reason?: string }[]
  }
  for (const entry of commands.commands) {
    if (entry.id === "import") {
      entry.available = true
      delete entry.reason
    }
  }
  return commands
}

const PACKS = {
  packs: [
    {
      id: "harbor",
      version: "1.0.0",
      name: "The Harbor",
      enabled: true,
      cards: [
        { file: "cards/pilot.json", name: "The Pilot", kind: "character" },
        { file: "cards/world.json", name: "The Drowned Quay", kind: "world" },
      ],
    },
  ],
}

describe("StatePanel: what the table sees", () => {
  it("renders the character, the party, the scene, the fight, who is here and the room", async () => {
    await open()
    render(<StatePanel />)
    const me = card("Ada Lovelace")
    expect(within(me).getByText("coc7")).toBeInTheDocument()
    expect(within(me).getByText("HP")).toBeInTheDocument()

    const party = card("Party")
    expect(within(party).getByText("Bao Zheng")).toBeInTheDocument()
    expect(within(party).getByText("Bao")).toBeInTheDocument()
    expect(within(party).getByText("poisoned")).toBeInTheDocument()
    expect(within(party).getByText("Rex")).toBeInTheDocument()

    const scene = card("Scene")
    expect(scene).toHaveTextContent("The Farm · Searching the barn")
    expect(scene).toHaveTextContent("Day 1 08:00 · round 1")
    expect(scene).toHaveTextContent("The mill burned down")

    const fight = card("Initiative")
    expect(within(fight).getByText("Ada Lovelace").closest("li")).toHaveClass("is-current")
    expect(within(fight).getByText("Cultist")).toBeInTheDocument()

    const here = card("At the table")
    expect(here).toHaveTextContent("4 online")
    expect(within(here).getByText("Root")).toBeInTheDocument()
    expect(within(here).getAllByText("Room admin")).toHaveLength(1)

    expect(card("Room")).toHaveTextContent("CoC · English")
  })

  it("renders nothing before any view arrives", async () => {
    room = await TestRoom.open("player", { views: false })
    const { container } = render(<StatePanel />)
    expect(container.querySelectorAll(".desk-card")).toHaveLength(0)
  })

  it("re-renders when a view's new value arrives", async () => {
    const r = await open()
    render(<StatePanel />)
    expect(card("Trackers")).toHaveTextContent("7/10")
    const variables = fixtureView("player", "variables") as { module: { value: number }[] }
    variables.module[0].value = 8
    await r.view("variables", variables)
    expect(card("Trackers")).toHaveTextContent("8/10")
  })

  it("says when the Keeper is not answering, and the last turn's token figures", async () => {
    const r = await open()
    render(<StatePanel />)
    await r.view("room", { ...fixtureView("player", "room"), keeperMuted: true })
    expect(screen.getByText("The Keeper is not answering")).toBeInTheDocument()
    await r.view("usage", {
      last: {
        turn: 4,
        inputTokens: 1200,
        outputTokens: 300,
        cachedInputTokens: 1000,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimated: false,
      },
    })
    expect(screen.getByText(/Turn 4: 1200 tokens in · 300 out · 1000 cached/)).toBeInTheDocument()
  })
})

describe("StatePanel: variables", () => {
  it("shows a player the visible tracker and leaf, and no way to write them", async () => {
    await open()
    render(<StatePanel />)
    const trackers = card("Trackers")
    expect(within(trackers).getByText("Morale")).toBeInTheDocument()
    expect(within(trackers).getByText("stats.hp")).toBeInTheDocument()
    expect(within(trackers).queryByRole("button")).toBeNull()
  })

  it("shows the room admin the hidden ones too, locked", async () => {
    await open("admin")
    render(<StatePanel />)
    const trackers = card("Trackers")
    expect(within(trackers).getAllByLabelText(/Not exposed to players yet/)).toHaveLength(2)
    expect(within(trackers).getByText("plot.ending")).toBeInTheDocument()
  })

  it("lets the room admin step a tracker through `var add`, and stops at a declared bound", async () => {
    const r = await open("admin")
    const user = userEvent.setup()
    render(<StatePanel />)
    await user.click(within(card("Trackers")).getByRole("button", { name: "Write" }))
    await user.click(screen.getByRole("button", { name: "Increase Morale" }))
    expect(r.commands()).toEqual([{ id: "var", args: { op: "add", path: "morale", delta: 1 } }])

    const variables = fixtureView("admin", "variables") as { module: { value: unknown }[] }
    variables.module[0].value = 10
    await r.view("variables", variables)
    expect(screen.getByRole("button", { name: "Increase Morale" })).toBeDisabled()
  })

  it("sets a value and a tree leaf through `var set`, and shows what the server answered", async () => {
    const r = await open("admin")
    const user = userEvent.setup()
    render(<StatePanel />)
    await user.click(within(card("Trackers")).getByRole("button", { name: "Write" }))
    await user.type(screen.getByLabelText("Set MODVAR-KEEPER-LABEL"), "calm{Enter}")
    await r.answer({ ok: true, text: "doom = calm" })
    expect(screen.getByRole("status")).toHaveTextContent("doom = calm")
    await user.type(screen.getByLabelText("Set stats.hp"), "9{Enter}")
    await r.answer({ ok: false, error: { code: "var_refused", message: "stats.hp cannot take that value." } })
    expect(screen.getByRole("alert")).toHaveTextContent("stats.hp cannot take that value.")
    expect(r.commands()).toEqual([
      { id: "var", args: { op: "set", path: "doom", value: "calm" } },
      { id: "var", args: { op: "set", path: "stats.hp", value: "9" } },
    ])
  })
})

describe("StatePanel: the characters on offer", () => {
  it("offers an unclaimed character and claims it by its id", async () => {
    const r = await open()
    const user = userEvent.setup()
    render(<StatePanel />)
    const cast = card("Pre-generated cast")
    expect(within(cast).getByText("A detective.")).toBeInTheDocument()
    await user.click(within(cast).getByRole("button", { name: "Claim" }))
    expect(r.commands()).toEqual([{ id: "pc", args: { op: "claim", name: "pregen-holmes" } }])
    await r.answer({ ok: false, error: { code: "taken", message: "Holmes is already played." } })
    expect(within(cast).getByRole("alert")).toHaveTextContent("Holmes is already played.")
  })

  it("names another member's claim, and offers your own for release", async () => {
    const r = await open()
    const user = userEvent.setup()
    render(<StatePanel />)
    const characters = fixtureView("player", "characters") as Record<string, unknown>
    await r.view("characters", {
      ...characters,
      claimable: [
        {
          id: "pregen-holmes",
          name: "Holmes",
          blurb: "",
          source: { kind: "pack", id: "demo" },
          player: { id: "m-bao", name: "Bao" },
        },
        {
          id: "pregen-watson",
          name: "Watson",
          blurb: "",
          source: { kind: "pack", id: "demo" },
          player: { id: "m-ada", name: "Ada" },
        },
      ],
    })
    const cast = card("Pre-generated cast")
    expect(within(cast).getByText("claimed by Bao")).toBeInTheDocument()
    expect(within(cast).getByText("yours")).toBeInTheDocument()
    await user.click(within(cast).getByRole("button", { name: "Release" }))
    expect(r.commands()).toEqual([{ id: "pc", args: { op: "release" } }])
  })

  it("offers an observer nothing to claim: the command is not available to them", async () => {
    await open("observer")
    render(<StatePanel />)
    expect(within(card("Pre-generated cast")).queryByRole("button")).toBeNull()
  })
})

describe("StatePanel: importing a pack's card", () => {
  it("stays hidden while the room cannot import", async () => {
    const r = await open()
    await r.view("packs", PACKS)
    render(<StatePanel />)
    expect(screen.queryByText("Import from pack")).toBeNull()
  })

  it("imports a character card with its own kind", async () => {
    const r = await open()
    await r.view("packs", PACKS)
    await r.view("commands", withImport("player"))
    const user = userEvent.setup()
    render(<StatePanel />)
    await user.click(screen.getByRole("button", { name: "Browse" }))
    const pilot = screen.getByText("The Pilot").closest("li") as HTMLElement
    await user.click(within(pilot).getByRole("button", { name: "Import" }))
    expect(r.commands()).toEqual([
      { id: "import", args: { pack: "harbor", card: "cards/pilot.json", as: "character" } },
    ])
    // A world card is the room admin's to import.
    const world = screen.getByText("The Drowned Quay").closest("li") as HTMLElement
    expect(within(world).getByRole("button", { name: "Import" })).toBeDisabled()
  })

  it("lets the room admin import a world card as the world", async () => {
    const r = await open("admin")
    await r.view("packs", PACKS)
    await r.view("commands", withImport("admin"))
    const user = userEvent.setup()
    render(<StatePanel />)
    await user.click(screen.getByRole("button", { name: "Browse" }))
    const world = screen.getByText("The Drowned Quay").closest("li") as HTMLElement
    await user.click(within(world).getByRole("button", { name: "Import" }))
    expect(r.commands()).toEqual([
      { id: "import", args: { pack: "harbor", card: "cards/world.json", as: "world" } },
    ])
  })
})
