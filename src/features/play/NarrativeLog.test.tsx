import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import "../../i18n"
import { useConnectionStore } from "../../store/connection"
import { PENDING_ECHO_TIMEOUT_MS, useSessionStore } from "../../store/session"
import NarrativeLog, { ECHO_SWEEP_MS, NPC_PREVIEW_CHARS } from "./NarrativeLog"

const transport = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock("../../lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/transport")>()),
  transportSend: (frame: unknown) => {
    transport.send(frame)
    return Promise.resolve()
  },
}))

const ingest = useSessionStore.getState().ingest

describe("NarrativeLog", () => {
  beforeEach(() => {
    useSessionStore.getState().clear()
    useConnectionStore.setState({ status: "offline" })
    transport.send.mockClear()
  })

  it("renders markdown narrative as rich text", () => {
    ingest({
      type: "narrative",
      id: "n1",
      speaker: "kp",
      text: "The **lantern** dies.",
      format: "markdown",
    })
    render(<NarrativeLog />)
    expect(screen.getByText("lantern")).toBeInstanceOf(HTMLElement)
    expect(screen.getByText("lantern").tagName).toBe("STRONG")
  })

  it("labels NPC lines with the NPC name and players with theirs", () => {
    ingest({
      type: "narrative",
      id: "n2",
      speaker: "npc",
      name: "沈墨",
      text: "别碰那口井。",
      format: "markdown",
    })
    ingest({
      type: "narrative",
      id: "n3",
      speaker: "player",
      name: "Ash",
      text: "I step back.",
      format: "plain",
    })
    render(<NarrativeLog />)
    expect(screen.getByText("沈墨")).toBeInTheDocument()
    expect(screen.getByText("Ash")).toBeInTheDocument()
  })

  describe("NPC lines", () => {
    // The engine has the Keeper restate each voiced line inside its narration,
    // so the same speech arrives twice: the NPC bubble, then the narration.
    const SPEECH =
      "别碰那口井。我在这渡口守了三十年，从没见过潮水退得这样干净，井口的铁链也锈得不像话，你们若还想活着回到岸上，天黑以前就该离开这里。"
    const narrate = () =>
      ingest({
        type: "narrative",
        id: "kp1",
        speaker: "kp",
        text: `沈墨压低了嗓子：“${SPEECH}”`,
        format: "markdown",
      })
    const speak = () =>
      ingest({
        type: "narrative",
        id: "npc1",
        speaker: "npc",
        name: "沈墨",
        text: SPEECH,
        format: "markdown",
      })

    it("folds a long line to the NPC's name and its first words, and leaves the narration to carry it", () => {
      speak()
      narrate()
      render(<NarrativeLog />)

      const toggle = screen.getByRole("button", { name: /沈墨/ })
      const head = Array.from(SPEECH).slice(0, NPC_PREVIEW_CHARS).join("")
      expect(toggle).toHaveTextContent(`沈墨${head}…`)
      expect(toggle).toHaveAttribute("aria-expanded", "false")
      // The speech is read once: inside the narration, not again in the bubble.
      expect(screen.queryByText(SPEECH)).toBeNull()
      expect(screen.getByText(/沈墨压低了嗓子/)).toBeInTheDocument()
    })

    it("keeps the entry where it arrived — nothing dropped, nothing reordered", () => {
      speak()
      narrate()
      const { container } = render(<NarrativeLog />)
      const entries = Array.from(container.querySelectorAll(".log-entry"))
      expect(entries.map((entry) => entry.className)).toEqual([
        "log-entry speaker-npc npc-line",
        "log-entry speaker-kp",
      ])
    })

    it("unfolds to the full line on click and folds back", async () => {
      const user = userEvent.setup()
      speak()
      render(<NarrativeLog />)

      const toggle = screen.getByRole("button", { name: /沈墨/ })
      await user.click(toggle)
      expect(screen.getByText(SPEECH)).toBeInTheDocument()
      expect(toggle).toHaveAttribute("aria-expanded", "true")

      await user.click(toggle)
      expect(screen.queryByText(SPEECH)).toBeNull()
      expect(toggle).toHaveAttribute("aria-expanded", "false")
    })

    it("opens from the keyboard", async () => {
      const user = userEvent.setup()
      speak()
      render(<NarrativeLog />)

      await user.tab()
      expect(screen.getByRole("button", { name: /沈墨/ })).toHaveFocus()
      await user.keyboard("{Enter}")
      expect(screen.getByText(SPEECH)).toBeInTheDocument()
    })

    it("shows a line that fits the preview as it is, with nothing to unfold", () => {
      ingest({
        type: "narrative",
        id: "npc2",
        speaker: "npc",
        name: "沈墨",
        text: "别碰那口井。",
        format: "markdown",
      })
      render(<NarrativeLog />)
      expect(screen.getByText("别碰那口井。")).toBeInTheDocument()
      expect(screen.queryByRole("button")).toBeNull()
    })

    it("cuts by characters, and shows markdown as plain words", () => {
      // 30 astral-plane characters: a cut by UTF-16 unit would split a pair.
      ingest({
        type: "narrative",
        id: "npc3",
        speaker: "npc",
        name: "Wen",
        text: "𠮷".repeat(30),
        format: "plain",
      })
      ingest({
        type: "narrative",
        id: "npc4",
        speaker: "npc",
        name: "Ash",
        text: `*${"a".repeat(40)}*`,
        format: "markdown",
      })
      render(<NarrativeLog />)
      expect(screen.getByRole("button", { name: /Wen/ })).toHaveTextContent(
        `Wen${"𠮷".repeat(NPC_PREVIEW_CHARS)}…`,
      )
      expect(screen.getByRole("button", { name: /Ash/ })).toHaveTextContent(
        `Ash${"a".repeat(NPC_PREVIEW_CHARS)}…`,
      )
    })

    describe("with a mood parenthetical", () => {
      const WORDS = "哎哟哟，停手停手！我这把老骨头还经不起你这样折腾，快放下快放下，别把东西摔了。"
      const head = Array.from(WORDS).slice(0, NPC_PREVIEW_CHARS).join("")

      it("leads with the spoken words after a full-width parenthetical, and keeps the mood apart", async () => {
        const user = userEvent.setup()
        const mood = "嘴上嫌他手笨、念叨个不停、心里却领了他这份不收钱的好意"
        const line = `（${mood}）“${WORDS}”`
        ingest({ type: "narrative", id: "m1", speaker: "npc", name: "沈墨", text: line, format: "markdown" })
        const { container } = render(<NarrativeLog />)

        const toggle = screen.getByRole("button", { name: /沈墨/ })
        // The words, minus their opening quote — not the stage direction.
        expect(container.querySelector(".npc-line-preview")).toHaveTextContent(`${head}…`)
        expect(container.querySelector(".npc-line-preview")).not.toHaveTextContent("嘴上嫌他")
        // The mood is its own muted piece, whole in the tooltip.
        expect(container.querySelector(".npc-line-mood")).toHaveTextContent(mood)
        expect(screen.getByTitle(mood)).toBeInTheDocument()

        // Unfolded, it is the original line: mood and quotes untouched.
        await user.click(toggle)
        expect(screen.getByText(line)).toBeInTheDocument()
        expect(container.querySelector(".npc-line-mood")).toBeNull()
      })

      it("does the same with an ASCII parenthetical and straight quotes", () => {
        const text =
          '(sighs, wiping the counter) "Nobody drinks at the Anchor after dusk, stranger — not since the tide turned wrong."'
        ingest({ type: "narrative", id: "m2", speaker: "npc", name: "Bram", text, format: "markdown" })
        const { container } = render(<NarrativeLog />)

        expect(container.querySelector(".npc-line-preview")).toHaveTextContent("Nobody drinks at the Anc…")
        expect(container.querySelector(".npc-line-mood")).toHaveTextContent("sighs, wiping the counter")
      })

      it("shows a short spoken line inline, unquoted, beside its mood", () => {
        ingest({
          type: "narrative",
          id: "m3",
          speaker: "npc",
          name: "沈墨",
          text: "（笑）“好。”",
          format: "plain",
        })
        const { container } = render(<NarrativeLog />)

        expect(screen.queryByRole("button")).toBeNull()
        expect(container.querySelector(".npc-line-preview")).toHaveTextContent(/^好。$/)
        expect(container.querySelector(".npc-line-mood")).toHaveTextContent("笑")
      })

      it("shows a line that is only a parenthetical as it is", () => {
        ingest({
          type: "narrative",
          id: "m4",
          speaker: "npc",
          name: "沈墨",
          text: "（沉默）",
          format: "plain",
        })
        const { container } = render(<NarrativeLog />)

        expect(container.querySelector(".npc-line-preview")).toHaveTextContent("（沉默）")
        expect(container.querySelector(".npc-line-mood")).toBeNull()
      })

      it("has no mood piece when the line does not open with a parenthetical", () => {
        ingest({
          type: "narrative",
          id: "m5",
          speaker: "npc",
          name: "沈墨",
          text: `${WORDS}（他停了停）`,
          format: "markdown",
        })
        const { container } = render(<NarrativeLog />)

        expect(container.querySelector(".npc-line-mood")).toBeNull()
        expect(container.querySelector(".npc-line-preview")).toHaveTextContent(`${head}…`)
      })
    })

    it("leaves every other speaker's text in full", () => {
      narrate()
      render(<NarrativeLog />)
      expect(screen.queryByRole("button")).toBeNull()
      expect(screen.getByText(new RegExp(SPEECH))).toBeInTheDocument()
    })
  })

  it("shows a blinking cursor only while the draft is open", () => {
    ingest({
      type: "narrative_delta",
      id: "s1",
      speaker: "kp",
      text: "The fog",
    })
    const { container, rerender } = render(<NarrativeLog />)
    expect(container.querySelector(".stream-cursor")).not.toBeNull()

    // The closing `narrative` (same id, full final text) seals the bubble.
    ingest({
      type: "narrative",
      id: "s1",
      speaker: "kp",
      text: "The fog settles.",
      format: "markdown",
    })
    rerender(<NarrativeLog />)
    expect(container.querySelector(".stream-cursor")).toBeNull()
    expect(screen.getByText("The fog settles.")).toBeInTheDocument()
  })

  it("follows a stream only while the reader is pinned near the bottom", () => {
    const delta = (text: string) =>
      act(() => ingest({ type: "narrative_delta", id: "s1", speaker: "kp", text }))
    delta("The fog ")
    const { container } = render(<NarrativeLog />)
    const log = container.querySelector(".narrative-log") as HTMLDivElement
    Object.defineProperty(log, "scrollHeight", { value: 1000, configurable: true })
    Object.defineProperty(log, "clientHeight", { value: 200, configurable: true })

    // Scrolled up to reread history: a new delta must not yank the view down.
    log.scrollTop = 100
    fireEvent.scroll(log)
    delta("thickens ")
    expect(log.scrollTop).toBe(100)

    // Back at the bottom: following resumes.
    log.scrollTop = 780
    fireEvent.scroll(log)
    delta("over the pier.")
    expect(log.scrollTop).toBe(1000)
  })

  it("keeps following when media grows the log underneath a pinned reader", () => {
    const delta = (text: string) =>
      act(() => ingest({ type: "narrative_delta", id: "s2", speaker: "kp", text }))
    delta("A lantern ")
    const { container } = render(<NarrativeLog />)
    const log = container.querySelector(".narrative-log") as HTMLDivElement
    let height = 1000
    Object.defineProperty(log, "scrollHeight", { get: () => height, configurable: true })
    Object.defineProperty(log, "clientHeight", { value: 200, configurable: true })
    log.scrollTop = 800
    fireEvent.scroll(log)

    // An image finishes loading: the log is 600px taller, the position did not move.
    height = 1600
    fireEvent.scroll(log)
    const img = document.createElement("img")
    log.appendChild(img)
    fireEvent.load(img)
    expect(log.scrollTop).toBe(1600)

    // …and the next line of the turn still follows.
    height = 1700
    delta("swings.")
    expect(log.scrollTop).toBe(1700)
  })

  it("keeps following when an image sizes itself before our own follow's scroll event lands", () => {
    const delta = (text: string) =>
      act(() => ingest({ type: "narrative_delta", id: "s3", speaker: "kp", text }))
    delta("The gate ")
    const { container } = render(<NarrativeLog />)
    const log = container.querySelector(".narrative-log") as HTMLDivElement
    let height = 1000
    Object.defineProperty(log, "scrollHeight", { get: () => height, configurable: true })
    Object.defineProperty(log, "clientHeight", { value: 200, configurable: true })
    log.scrollTop = 800
    fireEvent.scroll(log)

    // A new line: the log follows to 1100…
    height = 1100
    delta("opens.")
    expect(log.scrollTop).toBe(1100)
    // …an image learns its size before that follow's scroll event is dispatched…
    height = 1700
    fireEvent.scroll(log)
    // …and when it finishes loading the reader is still following.
    const img = document.createElement("img")
    log.appendChild(img)
    fireEvent.load(img)
    expect(log.scrollTop).toBe(1700)
  })

  it("renders a pending echo dimmed, and stops rendering it once the line lands", () => {
    act(() => {
      useSessionStore.getState().echoLocalInput("I check the ledger.", "Nyx")
    })
    const { container, rerender } = render(<NarrativeLog />)
    expect(container.querySelector(".log-entry.pending")).not.toBeNull()
    expect(screen.getByText("sending…")).toBeInTheDocument()

    act(() => {
      ingest({
        type: "narrative",
        id: "p1",
        speaker: "player",
        name: "Nyx",
        text: "I check the ledger.",
        format: "plain",
      })
    })
    rerender(<NarrativeLog />)
    expect(container.querySelector(".log-entry.pending")).toBeNull()
    // Once — never the echo and the real line side by side.
    expect(screen.getAllByText("I check the ledger.")).toHaveLength(1)
  })

  it("turns an un-echoed line into a failure notice after the timeout", () => {
    vi.useFakeTimers()
    try {
      act(() => {
        useSessionStore.getState().echoLocalInput("I check the ledger.", "Nyx", Date.now())
      })
      const { container } = render(<NarrativeLog />)
      act(() => {
        vi.advanceTimersByTime(PENDING_ECHO_TIMEOUT_MS + ECHO_SWEEP_MS)
      })
      expect(container.querySelector(".log-entry.pending.failed")).not.toBeNull()
      expect(screen.getByText("not delivered")).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("renders system spinner notices with an animated spinner element", () => {
    ingest({ type: "system", level: "info", text: "Summoning the Keeper…", spinner: true })
    const { container } = render(<NarrativeLog />)
    expect(container.querySelector(".spinner")).not.toBeNull()
  })

  it("shows the turn-queued notice as a visible info line beside the still-pending echo", () => {
    // `net/session.py: notify_turn_queued` — sent privately to a member whose
    // input arrived while someone else's turn holds the room lock, well before
    // the queued line itself runs. The exact wire shape the engine sends.
    act(() => {
      useSessionStore.getState().echoLocalInput(".pack install gh:1A7432/antu@v1.0.0", "Nyx")
    })
    act(() => {
      ingest({ type: "system", level: "info", text: "Your input is queued behind the running turn." })
    })
    const { container } = render(<NarrativeLog />)

    // The held line is still there, dimmed…
    expect(container.querySelector(".log-entry.pending")).not.toBeNull()
    // …and the queue notice is its own visible line beside it, not swallowed.
    expect(screen.getByText("Your input is queued behind the running turn.")).toBeInTheDocument()
    const notice = container.querySelector(".system-line")
    expect(notice?.className).toContain("level-info")
    expect(notice?.className).not.toContain("level-error")
  })
  describe("an undelivered line", () => {
    const undelivered = (text = "I check the ledger.") => {
      let seq = 0
      act(() => {
        seq = useSessionStore.getState().echoLocalInput(text, "Nyx", Date.now())
        useSessionStore.getState().failEcho(seq)
      })
      return seq
    }

    it("offers to resend, and sends the same words once the table is back", () => {
      undelivered()
      act(() => useConnectionStore.setState({ status: "online" }))
      const { container } = render(<NarrativeLog />)
      expect(screen.getByText("not delivered")).toBeInTheDocument()

      fireEvent.click(screen.getByRole("button", { name: "Resend" }))

      expect(transport.send).toHaveBeenCalledTimes(1)
      expect(transport.send).toHaveBeenCalledWith({ type: "input", text: "I check the ledger." })
      // Back to waiting, in place: the failure mark and the button are gone.
      expect(container.querySelector(".log-entry.pending.failed")).toBeNull()
      expect(screen.queryByRole("button", { name: "Resend" })).toBeNull()
      expect(screen.getByText("sending…")).toBeInTheDocument()
      expect(screen.getAllByText("I check the ledger.")).toHaveLength(1)
    })

    it("cannot be sent twice by a double click", () => {
      undelivered()
      act(() => useConnectionStore.setState({ status: "online" }))
      render(<NarrativeLog />)
      const button = screen.getByRole("button", { name: "Resend" })

      fireEvent.click(button)
      fireEvent.click(button)

      expect(transport.send).toHaveBeenCalledTimes(1)
    })

    it("is disabled while offline, and says why", () => {
      undelivered()
      render(<NarrativeLog />)
      const button = screen.getByRole("button", { name: "Resend" })
      expect(button).toBeDisabled()
      expect(button).toHaveAttribute("title", "Offline — you can resend once you are reconnected.")

      fireEvent.click(button)
      expect(transport.send).not.toHaveBeenCalled()

      // The link comes back: the same button is live.
      act(() => useConnectionStore.setState({ status: "online" }))
      expect(screen.getByRole("button", { name: "Resend" })).toBeEnabled()
    })

    it("is offered on failed lines only", () => {
      act(() => {
        useSessionStore.getState().echoLocalInput("I check the ledger.", "Nyx", Date.now())
      })
      act(() => useConnectionStore.setState({ status: "online" }))
      render(<NarrativeLog />)
      expect(screen.getByText("sending…")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Resend" })).toBeNull()
    })
  })
})
