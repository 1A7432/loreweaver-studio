// "Host locally & play" on screen: the connect screen's block in each state the
// store can be in, and the hosted server's start-up notes on the menu.

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import i18n from "../../i18n"
import { useConnectionStore } from "../../store/connection"
import { useHostLocalStore, type HostProblem } from "../../store/hostLocal"
import HostedNotes from "./HostedNotes"
import PlayView from "./PlayView"

const bridge = vi.hoisted(() => ({
  tauri: true,
  hostLocalStatus: vi.fn(async () => ({
    home: "/app/local-server",
    dataDir: "/app/local-server/data",
    running: false,
  })),
}))
vi.mock("../../lib/hostLocal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/hostLocal")>()
  return { ...actual, hostLocalStatus: bridge.hostLocalStatus }
})
vi.mock("../../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/transport")>()
  return { ...actual, isTauri: () => bridge.tauri }
})

const start = vi.fn(async () => {})
const stop = vi.fn(async () => {})

function hostState(patch: Partial<ReturnType<typeof useHostLocalStore.getState>>) {
  useHostLocalStore.setState({
    phase: "idle",
    problem: null,
    hosted: null,
    connection: null,
    notesDismissed: false,
    homeOverride: "",
    effectiveHome: "",
    running: false,
    start,
    stop,
    ...patch,
  })
}

function failed(problem: HostProblem) {
  hostState({ phase: "failed", problem })
}

beforeEach(() => {
  vi.clearAllMocks()
  bridge.hostLocalStatus.mockResolvedValue({
    home: "/app/local-server",
    dataDir: "/app/local-server/data",
    running: false,
  })
  bridge.tauri = true
  // Only stand-in connections here: nothing to stop.
  useConnectionStore.setState({ connection: null })
  hostState({})
})

describe("the host-locally block", () => {
  it("shows the folder a start would use and starts on a press", async () => {
    const user = userEvent.setup()
    render(<PlayView />)
    expect(await screen.findByPlaceholderText("/app/local-server")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Host locally & play" }))
    expect(start).toHaveBeenCalledTimes(1)
  })

  it("while starting: the button waits and Cancel stops", async () => {
    const user = userEvent.setup()
    hostState({ phase: "starting" })
    render(<PlayView />)
    expect(screen.getByRole("button", { name: "Starting the server…" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("while a server runs off screen: return to the table, or stop it", async () => {
    const user = userEvent.setup()
    bridge.hostLocalStatus.mockResolvedValue({ home: "/h", dataDir: "/h/data", running: true })
    hostState({ phase: "idle", running: true })
    render(<PlayView />)
    expect(screen.getByText("The local server this app started is still running.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Return to the table" }))
    expect(start).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole("button", { name: "Stop the server" }))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("a refusal for bad settings names each setting, never a value", () => {
    failed({
      code: "refused",
      refusal: "bad_settings",
      problems: [
        { variable: "TRPG_LLM__API_KEY", problem: "missing" },
        { variable: "TRPG_LLM__BASE_URL", problem: "invalid" },
      ],
    })
    render(<PlayView />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("The server refused its settings:")
    expect(alert).toHaveTextContent("TRPG_LLM__API_KEY is missing")
    expect(alert).toHaveTextContent("TRPG_LLM__BASE_URL is not valid")
  })

  it("another refusal is shown with its code", () => {
    failed({ code: "refused", refusal: "review_wordlist_missing", problems: [] })
    render(<PlayView />)
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The server refused to start (review_wordlist_missing).",
    )
  })

  it("a folder another server holds has its own words, in both languages", async () => {
    failed({ code: "refused", refusal: "data_dir_in_use", problems: [], detail: null })
    const { unmount } = render(<PlayView />)
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Another server is already running on this server folder",
    )
    unmount()
    await act(() => i18n.changeLanguage("zh"))
    try {
      render(<PlayView />)
      expect(screen.getByRole("alert")).toHaveTextContent("这个服务器目录已经有一台服务器在运行")
    } finally {
      await act(() => i18n.changeLanguage("en"))
    }
  })

  it("a start-up failure says so and shows the server's detail", () => {
    failed({ code: "refused", refusal: "startup_failed", problems: [], detail: "EADDRINUSE: bind failed" })
    render(<PlayView />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("The local server could not start:")
    expect(alert).toHaveTextContent("EADDRINUSE: bind failed")
  })

  it("no engine says what to install or set, and lists what was tried", () => {
    failed({
      code: "no_engine",
      engines: [{ kind: "checkout", program: "bun", problem: "spawning bun failed: not found" }],
    })
    render(<PlayView />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("No Loreweaver server was found.")
    expect(alert).toHaveTextContent("bun: spawning bun failed: not found")
  })

  it("a server that died says so with its last lines", () => {
    failed({ code: "died", exitCode: 7, stderr: ["[main] worker crashed", "fatal: the store went away"] })
    render(<PlayView />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("The local server stopped (code 7).")
    expect(alert).toHaveTextContent("fatal: the store went away")
    expect(screen.getByRole("button", { name: "Host locally & play" })).toBeEnabled()
  })

  it("an early exit and a timeout carry their last lines too", () => {
    failed({ code: "exited", exitCode: 1, stderr: ["error: cannot open the database"] })
    const { unmount } = render(<PlayView />)
    expect(screen.getByRole("alert")).toHaveTextContent("exited before it was ready (code 1)")
    expect(screen.getByRole("alert")).toHaveTextContent("error: cannot open the database")
    unmount()
    failed({ code: "timeout", stderr: [] })
    render(<PlayView />)
    expect(screen.getByRole("alert")).toHaveTextContent("not ready within a minute")
  })

  it("a server already running for another folder can be stopped from here", async () => {
    const user = userEvent.setup()
    failed({ code: "already_running", dataDir: "/elsewhere/data" })
    render(<PlayView />)
    expect(screen.getByRole("alert")).toHaveTextContent("/elsewhere/data")
    await user.click(screen.getByRole("button", { name: "Stop the server" }))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it("outside the desktop app the button is off and says why", () => {
    bridge.tauri = false
    render(<PlayView />)
    expect(screen.getByRole("button", { name: "Host locally & play" })).toBeDisabled()
    expect(screen.getByText("Local hosting needs the desktop app.")).toBeInTheDocument()
  })
})

describe("the hosted server's notes on the menu", () => {
  const table = {} as never

  function hosting(notes: string[], keySource: "first" | "kept" | "minted" = "first") {
    useConnectionStore.setState({ connection: table })
    hostState({
      phase: "hosting",
      connection: table,
      hosted: { hostId: "host-1", dataDir: "/d", room: "main", keySource, notes },
    })
  }

  it("says no model is set and opens the Models screen", async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    hosting(["model_not_configured", "recall_off"])
    render(<HostedNotes onNavigate={onNavigate} />)
    expect(screen.getByRole("status")).toHaveTextContent("No model is set")
    expect(screen.getByRole("status")).toHaveTextContent("Recall by meaning is off")
    await user.click(screen.getByRole("button", { name: "Open Models" }))
    expect(onNavigate).toHaveBeenCalledWith("model")
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("says when a new admin key had to be made, and shows an unknown note by its code", () => {
    hosting(["pack_skipped"], "minted")
    render(<HostedNotes onNavigate={() => {}} />)
    expect(screen.getByRole("status")).toHaveTextContent("so the server made a new one")
    expect(screen.getByRole("status")).toHaveTextContent("Server note: pack_skipped")
    expect(screen.queryByRole("button", { name: "Open Models" })).not.toBeInTheDocument()
  })

  it("shows nothing at a table this app does not host", () => {
    hosting(["model_not_configured"])
    useConnectionStore.setState({ connection: {} as never })
    const { container } = render(<HostedNotes onNavigate={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
