import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ServerFrame } from "@loreweaver/protocol"
import "../../i18n"
import { useConnectionStore } from "../../store/connection"
import { JOIN_REPLAY_TIMEOUT_MS, useSessionStore } from "../../store/session"
import InputBox from "./InputBox"

vi.mock("../../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/transport")>()
  return { ...actual, transportSend: vi.fn().mockResolvedValue(undefined) }
})

import { transportSend } from "../../lib/transport"

describe("InputBox", () => {
  beforeEach(() => {
    vi.mocked(transportSend).mockClear()
    vi.mocked(transportSend).mockResolvedValue(undefined)
    useSessionStore.getState().clear()
    useConnectionStore.setState({
      status: "online",
      welcome: {
        type: "welcome",
        protocol: "2.3",
        room: "midnight-pier",
        you: { id: "p1", name: "Nyx", role: "player" },
        locale: "en",
        server: "loreweaver",
      },
    })
  })

  it("sends the typed text as an input frame and clears the field", async () => {
    const user = userEvent.setup()
    render(<InputBox />)
    const field = screen.getByRole("textbox")
    await user.type(field, "look around{Enter}")
    expect(transportSend).toHaveBeenCalledWith({ type: "input", text: "look around" })
    expect(field).toHaveValue("")
  })

  it("echoes the line locally the moment it is sent", async () => {
    const user = userEvent.setup()
    render(<InputBox />)
    await user.type(screen.getByRole("textbox"), "I check the ledger.{Enter}")
    const entries = useSessionStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: "pending",
      pending: { speaker: "Nyx", text: "I check the ledger." },
    })
  })

  it("marks the echo undelivered when the send itself fails", async () => {
    const user = userEvent.setup()
    vi.mocked(transportSend).mockRejectedValueOnce(new Error("offline"))
    render(<InputBox />)
    await user.type(screen.getByRole("textbox"), ".ra spot hidden{Enter}")
    await waitFor(() => {
      const entry = useSessionStore.getState().entries[0]
      if (!(entry.kind === "pending" && entry.pending.failed)) throw new Error("not failed yet")
    })
    const entry = useSessionStore.getState().entries[0]
    expect(entry).toMatchObject({ kind: "pending", pending: { text: ".ra spot hidden", failed: true } })
  })

  it("does not send blank input", async () => {
    const user = userEvent.setup()
    render(<InputBox />)
    await user.type(screen.getByRole("textbox"), "   {Enter}")
    expect(transportSend).not.toHaveBeenCalled()
  })

  it("is disabled unless the connection is online", () => {
    useConnectionStore.setState({ status: "reconnecting" })
    render(<InputBox />)
    expect(screen.getByRole("textbox")).toBeDisabled()
  })

  // A welcome puts the transport online at once, but the room's history is still
  // arriving behind it and only the `state` frame ends that replay.
  describe("while a join replay is still arriving", () => {
    const WELCOME: ServerFrame = {
      type: "welcome",
      protocol: "2.4",
      room: "midnight-pier",
      you: { id: "p1", name: "Nyx", role: "player" },
      locale: "en",
      server: "loreweaver",
    }
    const STATE: ServerFrame = { type: "state", party: [], initiative: [], online: 1 }
    let ids = 0
    const ingest = (frame: ServerFrame) => act(() => useSessionStore.getState().ingest(frame))
    const line = (speaker: "kp" | "player", text: string) =>
      ingest({
        type: "narrative",
        id: `replay-${(ids += 1)}`,
        speaker,
        text,
        format: speaker === "kp" ? "markdown" : "plain",
        ...(speaker === "player" ? { name: "Nyx" } : {}),
      })
    const shown = () =>
      useSessionStore.getState().entries.map((entry) => {
        if (entry.kind === "narrative") return `${entry.frame.speaker}: ${entry.frame.text}`
        if (entry.kind === "pending")
          return `${entry.pending.failed ? "undelivered" : "pending"}: ${entry.pending.text}`
        return entry.kind
      })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("holds the line on a first join and sends it below the whole history once the replay ends", async () => {
      const user = userEvent.setup()
      render(<InputBox />)
      ingest(WELCOME)
      line("kp", "The pier creaks under a grey dawn.")

      const field = screen.getByRole("textbox")
      await user.type(field, "I raise the lantern.{Enter}")
      // Nothing went out, nothing was echoed, and the words are still there.
      expect(transportSend).not.toHaveBeenCalled()
      expect(field).toHaveValue("I raise the lantern.")
      expect(screen.getByRole("status")).toHaveTextContent("Catching up")
      expect(screen.getByRole("button")).toBeDisabled()

      line("player", "I step onto the pier.")
      line("kp", "A lantern gutters at the far end.")
      ingest(STATE)

      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
      await user.type(field, "{Enter}")
      expect(transportSend).toHaveBeenCalledWith({ type: "input", text: "I raise the lantern." })
      expect(shown()).toEqual([
        "kp: The pier creaks under a grey dawn.",
        "player: I step onto the pier.",
        "kp: A lantern gutters at the far end.",
        "pending: I raise the lantern.",
      ])
    })

    it("does not end a reconnect's replay early, and an old replayed line never retires the new one", async () => {
      const user = userEvent.setup()
      render(<InputBox />)
      // A first session: the player said "continue" once already, then typed a
      // line the dying connection never delivered.
      ingest(WELCOME)
      line("kp", "The corridor splits in two.")
      line("player", "continue")
      line("kp", "You reach a crossroads.")
      ingest(STATE)
      act(() => {
        useSessionStore.getState().echoLocalInput("I open the door.", "Nyx")
      })

      // The link drops; the redial's replay starts arriving.
      ingest(WELCOME)
      line("kp", "The corridor splits in two.")
      await user.type(screen.getByRole("textbox"), "continue{Enter}")
      expect(transportSend).not.toHaveBeenCalled()
      expect(useSessionStore.getState().replay).not.toBeNull()

      // The rest of the replay: its old "continue" must not touch anything new.
      line("player", "continue")
      line("kp", "You reach a crossroads.")
      ingest(STATE)
      await user.type(screen.getByRole("textbox"), "{Enter}")

      expect(transportSend).toHaveBeenCalledWith({ type: "input", text: "continue" })
      expect(shown()).toEqual([
        "kp: The corridor splits in two.",
        "player: continue",
        "kp: You reach a crossroads.",
        "undelivered: I open the door.",
        "pending: continue",
      ])
    })

    it("lets go of the input if the replay never ends", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      render(<InputBox />)
      ingest(WELCOME)
      await user.type(screen.getByRole("textbox"), "Hello?")
      expect(screen.getByRole("button")).toBeDisabled()

      act(() => {
        vi.advanceTimersByTime(JOIN_REPLAY_TIMEOUT_MS)
      })
      expect(useSessionStore.getState().replay).toBeNull()
      await user.type(screen.getByRole("textbox"), "{Enter}")
      expect(transportSend).toHaveBeenCalledWith({ type: "input", text: "Hello?" })
    })
  })
})
