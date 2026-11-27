// The log, read from a real protocol `Session` fed real 3.0 frames. The frames of the
// table session are protocol.md §13.1's, verbatim; the others follow §8's shapes.
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import "../../i18n"
import { DEFAULT_REDIAL_BASE_MS } from "../../lib/connection"
import { flush } from "../../lib/connection.testkit"
import NarrativeLog, { NPC_PREVIEW_CHARS } from "./NarrativeLog"
import { TestRoom } from "./room.testkit"

// protocol.md §13.1, steps 2 and 4.
const BAO_LINE = {
  type: "event",
  seq: 1,
  id: "2c1f8e7a-6b5d-4c3e-9f2a-1b0c9d8e7f6a",
  ts: 1764240000001,
  kind: "narrative",
  turn: 1,
  data: {
    speaker: "player",
    name: "Bao",
    member: "m:b40a5aaa35ea",
    text: "I wait by the quay.",
    format: "plain",
  },
}
const FOG = {
  type: "event",
  seq: 2,
  id: "7d6e5f4a-3b2c-4d1e-8f9a-0b1c2d3e4f5a",
  ts: 1764240002410,
  kind: "narrative",
  turn: 1,
  data: { speaker: "kp", text: "The fog thickens.", format: "markdown" },
}
const ADA_LINE = {
  type: "event",
  seq: 3,
  id: "5e4d3c2b-1a0f-4e9d-8c7b-6a5f4e3d2c1b",
  ts: 1764240010000,
  kind: "narrative",
  turn: 2,
  data: {
    speaker: "player",
    name: "Ada",
    member: "m:15b5f3445045",
    text: "I light the lantern. [[1d6]]",
    format: "plain",
  },
}
const INLINE_ROLL = {
  type: "event",
  seq: 4,
  id: "0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d",
  ts: 1764240010001,
  kind: "dice",
  turn: 2,
  data: {
    actor: "Ada",
    kind: "roll",
    expr: "1d6",
    rolls: [6],
    total: 6,
    detail: { text: "1d6 (6) = 6", inline: true },
  },
}
const BUSY = { type: "signal", kind: "turn", data: { status: "busy", actor: "Ada" } }
const DRAFT_ID = "9b4f6c1e-2d3a-4e5f-8a7b-1c2d3e4f5a6b"
const SLICE_1 = { type: "signal", kind: "draft", data: { id: DRAFT_ID, text: "The lantern catches, " } }
const SLICE_2 = {
  type: "signal",
  kind: "draft",
  data: { id: DRAFT_ID, text: "and the quay comes out of the dark." },
}
const REPLY = {
  type: "event",
  seq: 5,
  id: DRAFT_ID,
  ts: 1764240014820,
  kind: "narrative",
  turn: 2,
  data: {
    speaker: "kp",
    text: "The lantern catches, and the quay comes out of the dark.",
    format: "markdown",
  },
}
const IDLE = { type: "signal", kind: "turn", data: { status: "idle" } }
// §13.1 step 7: the undo of turn 2.
const REWIND = {
  type: "event",
  seq: 8,
  id: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d",
  ts: 1764240030000,
  kind: "rewind",
  data: { from: 3, kept: [], epoch: 2 },
}

let nextSeq = 100
function narrative(data: Record<string, unknown>, seq = nextSeq++) {
  return { type: "event", seq, id: `n-${seq}`, ts: 1764240000000 + seq, kind: "narrative", data }
}

let room: TestRoom | null = null
async function open(head = 2, first = 1): Promise<TestRoom> {
  room = await TestRoom.open("player", { views: false, head, first })
  return room
}
afterEach(() => {
  room?.close()
  room = null
})

describe("NarrativeLog: the table session", () => {
  it("renders the replay: a player line under its name, the Keeper's markdown under KP", async () => {
    const r = await open()
    await r.feed(BAO_LINE, narrative({ speaker: "kp", text: "The **lantern** dies.", format: "markdown" }, 2))
    const { container } = render(<NarrativeLog />)
    expect(screen.getByText("Bao")).toBeInTheDocument()
    expect(screen.getByText("I wait by the quay.")).toBeInTheDocument()
    expect(screen.getByText("lantern").tagName).toBe("STRONG")
    expect(container.querySelector(".log-entry.speaker-kp .entry-speaker")).toHaveTextContent("KP")
  })

  it("streams the reply into a bubble with a cursor, and its event replaces the bubble", async () => {
    const r = await open()
    await r.feed(BAO_LINE, FOG)
    const { container } = render(<NarrativeLog />)
    await r.feed(ADA_LINE, INLINE_ROLL, BUSY, SLICE_1)
    expect(container.querySelector(".stream-cursor")).not.toBeNull()
    expect(screen.getByText("The lantern catches,")).toBeInTheDocument()

    await r.feed(SLICE_2)
    expect(screen.getByText("The lantern catches, and the quay comes out of the dark.")).toBeInTheDocument()

    await r.feed(REPLY, IDLE)
    expect(container.querySelector(".stream-cursor")).toBeNull()
    // One bubble, not the draft AND the event.
    expect(screen.getAllByText("The lantern catches, and the quay comes out of the dark.")).toHaveLength(1)
    expect(container.querySelectorAll(".log-entry")).toHaveLength(4)
  })

  it("drops a bubble the turn never turned into an event when the turn goes idle", async () => {
    const r = await open()
    const { container } = render(<NarrativeLog />)
    await r.feed(BUSY, SLICE_1)
    expect(container.querySelector(".stream-cursor")).not.toBeNull()
    await r.feed(IDLE)
    expect(container.querySelector(".stream-cursor")).toBeNull()
    expect(screen.queryByText(/The lantern catches/)).toBeNull()
  })

  it("draws an inline roll as a dice line, from its readable text", async () => {
    const r = await open()
    await r.feed(ADA_LINE, INLINE_ROLL)
    const { container } = render(<NarrativeLog />)
    const dice = container.querySelector(".dice-line") as HTMLElement
    expect(dice).toHaveTextContent("Ada 1d6 (6) = 6")
    expect(dice).toHaveClass("rank-neutral")
  })

  it("applies an undo: the rewound events go, and the log says the story was rewound", async () => {
    const r = await open()
    await r.feed(BAO_LINE, FOG, ADA_LINE, INLINE_ROLL, REPLY)
    render(<NarrativeLog />)
    expect(screen.getByText(/I light the lantern/)).toBeInTheDocument()
    await r.feed(REWIND)
    expect(screen.queryByText(/I light the lantern/)).toBeNull()
    expect(screen.queryByText(/The lantern catches/)).toBeNull()
    expect(screen.getByText("I wait by the quay.")).toBeInTheDocument()
    expect(screen.getByText("The story was rewound.")).toBeInTheDocument()
  })

  it("applies a reset: the scrollback empties and the reset is the first line of the new log", async () => {
    const r = await open()
    await r.feed(BAO_LINE, FOG)
    render(<NarrativeLog />)
    await r.feed({
      type: "event",
      seq: 9,
      id: "reset-9",
      ts: 1764240050000,
      kind: "reset",
      data: { scope: "all", epoch: 3 },
    })
    expect(screen.queryByText("I wait by the quay.")).toBeNull()
    expect(screen.getByText("The campaign was wiped clean.")).toBeInTheDocument()
  })

  it("draws a shared picture under its name", async () => {
    const r = await open()
    // protocol.md §13.2: the file the table sees arrive.
    await r.feed({
      type: "event",
      seq: 9,
      id: "e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b",
      ts: 1764240040000,
      kind: "media",
      data: {
        hash: "3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
        mime: "image/png",
        size: 48213,
        name: "map.png",
        from: "m:15b5f3445045",
      },
    })
    render(<NarrativeLog />)
    expect(screen.getAllByText(/map\.png/).length).toBeGreaterThan(0)
  })
})

describe("NarrativeLog: blocks", () => {
  const block = (seq: number, id: string, title: string, replace?: boolean) => ({
    type: "event",
    seq,
    id,
    ts: 1764240000000 + seq,
    kind: "blocks",
    data: {
      blocks: [{ kind: "title_card", title, subtitle: "The Drowned Quay" }],
      ...(replace ? { replace } : {}),
    },
  })

  it("draws a replacement in place of the blocks it replaces — never both", async () => {
    const r = await open()
    await r.feed(block(1, "b-1", "Act I"))
    const { container } = render(<NarrativeLog />)
    expect(screen.getByText("Act I")).toBeInTheDocument()
    await r.feed(FOG, block(3, "b-1", "Act II", true))
    expect(screen.queryByText("Act I")).toBeNull()
    expect(screen.getAllByText("Act II")).toHaveLength(1)
    // Where the first one was: before the Keeper's line.
    const order = Array.from(container.querySelectorAll(".ui-title-card-title, .log-entry")).map(
      (el) => el.textContent,
    )
    expect(order[0]).toBe("Act II")
  })
})

describe("NarrativeLog: history", () => {
  it("offers older history while the window does not reach the start, and pages it in", async () => {
    // head 300, oldest 1: only the newest 200 are replayed, the rest is older history.
    const r = await open(300, 1)
    await r.feed(narrative({ speaker: "kp", text: "Line 101.", format: "markdown" }, 101))
    render(<NarrativeLog />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Load earlier" }))
    expect(r.lastRequest()).toMatchObject({
      type: "call",
      method: "log.page",
      params: { before: 101, limit: 100 },
    })
    await r.answer({
      ok: true,
      data: { events: [narrative({ speaker: "kp", text: "Line 50.", format: "markdown" }, 50)] },
    })
    expect(screen.getByText("Line 50.")).toBeInTheDocument()
    // Fewer than a page came back: that was the start of the room's log.
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull()
  })

  it("marks the hole a resume could not replay, and fills it from there", async () => {
    const r = await open(2, 1)
    await r.feed(BAO_LINE, FOG)
    render(<NarrativeLog />)
    // The link drops; the room moves on 500 events while we are away.
    await r.drop()
    await act(async () => {
      r.timers.advance(DEFAULT_REDIAL_BASE_MS)
      r.connection.handleEvent(r.driver.up())
      await flush()
      r.connection.handleEvent(
        r.driver.frame({
          type: "welcome",
          protocol: "3.0",
          server: { name: "loreweaver", version: "3.0.0-alpha.0" },
          room: { id: "main", locale: "en" },
          you: { id: "m-ada", name: "Ada", role: "player" },
          features: [],
          epoch: 1,
          head: 500,
          first: 1,
        }),
      )
      await flush()
    })
    await r.feed(narrative({ speaker: "kp", text: "Line 301.", format: "markdown" }, 301))
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Load the missing lines" }))
    expect(r.lastRequest()).toMatchObject({ method: "log.page", params: { before: 301, limit: 100 } })
    await r.answer({
      ok: true,
      data: { events: [narrative({ speaker: "player", name: "Bao", text: "Line 3.", format: "plain" }, 3)] },
    })
    expect(screen.getByText("Line 3.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Load the missing lines" })).toBeNull()
  })
})

describe("NarrativeLog: speakers", () => {
  it("labels NPC lines with the NPC's name and players with theirs", async () => {
    const r = await open()
    await r.feed(
      narrative({ speaker: "npc", name: "沈墨", text: "别碰那口井。", format: "markdown" }),
      narrative({ speaker: "player", name: "Ash", member: "m-ash", text: "I step back.", format: "plain" }),
    )
    render(<NarrativeLog />)
    expect(screen.getByText("沈墨")).toBeInTheDocument()
    expect(screen.getByText("Ash")).toBeInTheDocument()
  })

  it("gives a nameless or control-character-named player line no header", async () => {
    const r = await open()
    await r.feed(
      narrative({ speaker: "player", text: "I step back.", format: "plain" }),
      narrative({ speaker: "player", name: " \u0007 ", text: "Hm.", format: "plain" }),
    )
    const { container } = render(<NarrativeLog />)
    expect(screen.getByText("I step back.")).toBeInTheDocument()
    expect(container.querySelector(".entry-speaker")).toBeNull()
  })

  it("names a system announcement as the system", async () => {
    const r = await open()
    await r.feed(narrative({ speaker: "system", text: "Ada claimed Holmes.", format: "plain" }))
    render(<NarrativeLog />)
    expect(screen.getByText("System")).toBeInTheDocument()
  })

  describe("NPC lines", () => {
    // The engine has the Keeper restate each voiced line inside its narration,
    // so the same speech arrives twice: the NPC bubble, then the narration.
    const SPEECH =
      "别碰那口井。我在这渡口守了三十年，从没见过潮水退得这样干净，井口的铁链也锈得不像话，你们若还想活着回到岸上，天黑以前就该离开这里。"
    const speak = () => narrative({ speaker: "npc", name: "沈墨", text: SPEECH, format: "markdown" })
    const narrate = () =>
      narrative({ speaker: "kp", text: `沈墨压低了嗓子：“${SPEECH}”`, format: "markdown" })

    it("folds a long line to the NPC's name and its first words, and leaves the narration to carry it", async () => {
      const r = await open()
      await r.feed(speak(), narrate())
      const { container } = render(<NarrativeLog />)
      const toggle = screen.getByRole("button", { name: /沈墨/ })
      const head = Array.from(SPEECH).slice(0, NPC_PREVIEW_CHARS).join("")
      expect(toggle).toHaveTextContent(`沈墨${head}…`)
      expect(toggle).toHaveAttribute("aria-expanded", "false")
      expect(screen.queryByText(SPEECH)).toBeNull()
      expect(screen.getByText(/沈墨压低了嗓子/)).toBeInTheDocument()
      // Nothing dropped, nothing reordered.
      expect(Array.from(container.querySelectorAll(".log-entry")).map((entry) => entry.className)).toEqual([
        "log-entry speaker-npc npc-line",
        "log-entry speaker-kp",
      ])
    })

    it("unfolds to the full line on click, and from the keyboard", async () => {
      const user = userEvent.setup()
      const r = await open()
      await r.feed(speak())
      render(<NarrativeLog />)
      const toggle = screen.getByRole("button", { name: /沈墨/ })
      await user.click(toggle)
      expect(screen.getByText(SPEECH)).toBeInTheDocument()
      await user.click(toggle)
      expect(screen.queryByText(SPEECH)).toBeNull()
      toggle.focus()
      await user.keyboard("{Enter}")
      expect(screen.getByText(SPEECH)).toBeInTheDocument()
    })

    it("leads with the spoken words after a mood parenthetical, and keeps the mood apart", async () => {
      const words = "哎哟哟，停手停手！我这把老骨头还经不起你这样折腾，快放下快放下，别把东西摔了。"
      const mood = "嘴上嫌他手笨、念叨个不停"
      const r = await open()
      await r.feed(
        narrative({ speaker: "npc", name: "沈墨", text: `（${mood}）“${words}”`, format: "markdown" }),
      )
      const { container } = render(<NarrativeLog />)
      const head = Array.from(words).slice(0, NPC_PREVIEW_CHARS).join("")
      expect(container.querySelector(".npc-line-preview")).toHaveTextContent(`${head}…`)
      expect(container.querySelector(".npc-line-mood")).toHaveTextContent(mood)
    })

    it("shows a line that fits the preview as it is, with nothing to unfold", async () => {
      const r = await open()
      await r.feed(narrative({ speaker: "npc", name: "沈墨", text: "别碰那口井。", format: "markdown" }))
      render(<NarrativeLog />)
      expect(screen.getByText("别碰那口井。")).toBeInTheDocument()
      expect(screen.queryByRole("button")).toBeNull()
    })
  })
})

describe("NarrativeLog: following the stream", () => {
  const slice = (text: string) => ({ type: "signal", kind: "draft", data: { id: "d-1", text } })

  async function streaming() {
    const r = await open()
    const { container } = render(<NarrativeLog />)
    const log = container.querySelector(".narrative-log") as HTMLDivElement
    return { r, log }
  }

  it("follows a stream only while the reader is pinned near the bottom", async () => {
    const { r, log } = await streaming()
    Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(log, "clientHeight", { value: 200, configurable: true })
    await r.feed(slice("The fog "))

    // Scrolled up to reread history: a new slice must not yank the view down.
    log.scrollTop = 100
    fireEvent.scroll(log)
    await r.feed(slice("thickens "))
    expect(log.scrollTop).toBe(100)

    // Back at the bottom: following resumes.
    log.scrollTop = 780
    fireEvent.scroll(log)
    await r.feed(slice("over the pier."))
    expect(log.scrollTop).toBe(1000)
  })

  it("keeps following when a picture grows the log underneath a pinned reader", async () => {
    const { r, log } = await streaming()
    let height = 1000
    Object.defineProperty(log, "scrollHeight", { get: () => height, configurable: true })
    Object.defineProperty(log, "clientHeight", { value: 200, configurable: true })
    await r.feed(slice("A lantern "))
    log.scrollTop = 800
    fireEvent.scroll(log)

    height = 1600
    fireEvent.scroll(log)
    const img = document.createElement("img")
    log.appendChild(img)
    fireEvent.load(img)
    expect(log.scrollTop).toBe(1600)

    height = 1700
    await r.feed(slice("swings."))
    expect(log.scrollTop).toBe(1700)
  })
})
