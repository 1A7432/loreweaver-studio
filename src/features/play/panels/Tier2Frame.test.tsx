// A page panel mounted for real: the documented example page (docs/examples/page-bridge-
// example.html, the one docs/PAGE-BRIDGE.md shows) runs in the mounted frame with the bootstrap
// this component registered, against the real connection owner and protocol session. What
// jsdom cannot do (serve `panel://`, set `MessageEvent.source`, enforce sandbox or CSP) is
// said in `page.testkit.ts`.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { PanelEntry } from "loreweaver-protocol/v3"
import "../../../i18n"
import EXAMPLE_PAGE from "../../../../docs/examples/page-bridge-example.html?raw"
import PAGE_BRIDGE_DOC from "../../../../docs/PAGE-BRIDGE.md?raw"
import { usePanelsStore } from "../../../store/panels"
import { TestRoom, fixtureView } from "../room.testkit"
import PanelModalHost from "./PanelModalHost"
import Tier2Frame from "./Tier2Frame"
import { servePage } from "./page.testkit"

vi.mock("../../../lib/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/transport")>()
  return { ...actual, isTauri: () => true }
})

vi.mock("./assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets")>()
  return {
    ...actual,
    ensurePage: vi.fn().mockResolvedValue(undefined),
    panelServeRegister: vi.fn().mockResolvedValue(undefined),
    panelServeUnregister: vi.fn().mockResolvedValue(undefined),
    // jsdom does not load a custom scheme; the test writes the page into the frame itself.
    panelEntryUrl: vi.fn(() => "about:blank"),
  }
})

import { ensurePage, panelServeRegister, panelServeUnregister } from "./assets"

const QUICK_ROLL: PanelEntry = {
  id: "harbor/quick-roll",
  title: "Quick roll",
  slot: "sidebar",
  kind: "page",
  views: [
    { as: "me", view: "me" },
    { as: "tide", view: "harbor/tide" },
  ],
  source: { kind: "pack", id: "harbor" },
  page: { hash: "c".repeat(64), size: EXAMPLE_PAGE.length, mime: "text/html" },
  fallback: [{ kind: "text", text: "Roll in the rich client." }],
}

/** A page that runs whatever the test asks and keeps every result. */
const PROBE = `<!doctype html><html><head></head><body><script>
  window.results = [];
  window.go = function (command, args) {
    loreweaver.run(command, args).then(function (result) { window.results.push(result) });
  };
  loreweaver.ready();
</script></body></html>`

type ProbeWindow = Window & {
  results: Record<string, unknown>[]
  go: (command: string, args: Record<string, unknown>) => void
}

interface Head {
  token: string
  bootstrapJs: string
  themeCss: string
}

let room: TestRoom | null = null
beforeEach(() => {
  vi.mocked(ensurePage).mockClear().mockResolvedValue(undefined)
  vi.mocked(panelServeRegister).mockClear().mockResolvedValue(undefined)
  vi.mocked(panelServeUnregister).mockClear().mockResolvedValue(undefined)
})
afterEach(() => {
  room?.close()
  room = null
})

async function mounted(role: "player" | "admin" = "player") {
  room = await TestRoom.open(role)
  const view = render(<Tier2Frame panel={QUICK_ROLL} />)
  const iframe = await waitFor(() => {
    const el = view.container.querySelector("iframe")
    if (!el) throw new Error("no frame yet")
    return el
  })
  const registration: Head = vi.mocked(panelServeRegister).mock.calls.at(-1)![0]
  return { r: room, view, iframe, registration }
}

/** Serve `html` into the frame and wait until the page has said `ready()` (the frame shows). */
async function live<W extends Window = Window>(iframe: HTMLIFrameElement, head: Head, html = EXAMPLE_PAGE) {
  let page: Window | null = null
  act(() => {
    page = servePage(iframe, html, head)
  })
  await waitFor(() => expect(iframe.className).toBe("panel-frame"))
  return page as unknown as W
}

describe("Tier2Frame", () => {
  it("mounts a strictly sandboxed frame for the page's hash, with the fallback while it loads", async () => {
    const { iframe, registration } = await mounted()
    // The isolation contract: allow-scripts alone — never allow-same-origin.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts")
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer")
    expect(iframe.getAttribute("title")).toBe("Quick roll")
    expect(iframe).toHaveClass("waiting")
    expect(screen.getByText("Roll in the rich client.")).toBeInTheDocument()
    expect(ensurePage).toHaveBeenCalledWith("c".repeat(64))
    expect(registration.token).toMatch(/^[0-9a-f]{32}$/)
    expect(vi.mocked(panelServeRegister).mock.calls.at(-1)![0].hash).toBe("c".repeat(64))
    expect(registration.bootstrapJs).toContain(`Object.defineProperty(window, "loreweaver"`)
    expect(registration.themeCss).toContain(":root {")
    // The nonce in the bootstrap is the mount's own, and not the serve token.
    const nonce = /var NONCE = "([0-9a-f]{32})"/.exec(registration.bootstrapJs)![1]
    expect(nonce).not.toBe(registration.token)
  })

  it("runs the documented example: it reads its view, runs a command, and follows a change", async () => {
    const { r, iframe, registration } = await mounted()
    const page = await live(iframe, registration)
    const doc = page.document
    // The fallback gives way to the running page.
    expect(screen.queryByText("Roll in the rich client.")).toBeNull()
    await waitFor(() => expect(doc.getElementById("who")?.textContent).toBe("Ada Lovelace"))

    const button = doc.getElementById("roll") as HTMLButtonElement
    expect(button.disabled).toBe(false)
    act(() => button.click())
    await waitFor(() => expect(r.commands()).toEqual([{ id: "roll", args: { expr: "1d20" } }]))
    await r.answer({ ok: true, data: { totals: [7] }, text: "1d20 = 7" })
    await waitFor(() => expect(doc.getElementById("answer")?.textContent).toBe("1d20 = 7"))

    const me = fixtureView("player", "me")
    ;(me.character as { name: string }).name = "Ada, soaked"
    await r.view("me", me)
    await waitFor(() => expect(doc.getElementById("who")?.textContent).toBe("Ada, soaked"))
  })

  it("hands the page only its declared views, by handle, and the new log events", async () => {
    const { r, iframe, registration } = await mounted()
    const html = `<!doctype html><html><head></head><body><script>
      window.seen = []; window.events = [];
      loreweaver.ready().then(function () {
        loreweaver.onViews(function (v) { window.seen.push(v) });
        loreweaver.onEvent(function (e) { window.events.push(e) });
      });
    </script></body></html>`
    const page = await live<Window & { seen: Record<string, unknown>[]; events: unknown[] }>(
      iframe,
      registration,
      html,
    )
    await waitFor(() => expect(page.seen.length).toBe(1))
    expect(Object.keys(page.seen[0]).sort()).toEqual(["me", "tide"])
    expect(page.seen[0].tide).toBeNull()
    // Not one of the snapshot's other views crosses.
    expect(JSON.stringify(page.seen)).not.toContain('"commands"')
    expect(JSON.stringify(page.seen)).not.toContain('"panels"')

    await r.view("harbor/tide", { level: 4 })
    await waitFor(() => expect(page.seen.at(-1)?.tide).toEqual({ level: 4 }))

    await r.feed({
      type: "event",
      seq: 1,
      id: "n1",
      ts: 5,
      kind: "narrative",
      turn: 1,
      data: { speaker: "kp", text: "The tide turns.", format: "plain" },
    })
    await waitFor(() => expect(page.events).toHaveLength(1))
    expect(page.events[0]).toEqual({
      seq: 1,
      id: "n1",
      ts: 5,
      kind: "narrative",
      turn: 1,
      data: { speaker: "kp", text: "The tide turns.", format: "plain" },
    })
  })

  it("asks before a danger command with the host's own dialog, naming the panel and the command", async () => {
    const user = userEvent.setup()
    const { r, iframe, registration } = await mounted("admin")
    const page = await live<ProbeWindow>(iframe, registration, PROBE)

    act(() => page.go("undo", { turns: 1 }))
    let dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Quick roll")
    expect(dialog).toHaveTextContent("(undo)")
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus()
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(page.results).toHaveLength(1))
    expect(page.results[0]).toMatchObject({
      ok: false,
      code: "cancelled",
      message: "You declined to run it.",
    })
    expect(r.commands()).toEqual([])

    act(() => page.go("undo", { turns: 1 }))
    dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Run it" }))
    await waitFor(() => expect(r.commands()).toEqual([{ id: "undo", args: { turns: 1 } }]))
    await r.answer({ ok: true, data: { undone: 1 } })
    await waitFor(() => expect(page.results).toHaveLength(2))
    expect(page.results[1]).toEqual({ ok: true, data: { undone: 1 } })
  })

  it("refuses a command the commands view does not offer, without sending it", async () => {
    const { r, iframe, registration } = await mounted("player")
    const page = await live<ProbeWindow>(iframe, registration, PROBE)
    act(() => page.go("undo", {}))
    act(() => page.go("import", { as: "character" }))
    await waitFor(() => expect(page.results).toHaveLength(2))
    expect(page.results[0]).toMatchObject({ ok: false, code: "unavailable", reason: "unknown" })
    expect(page.results[1]).toMatchObject({ ok: false, code: "unavailable", reason: "no_media" })
    expect(r.commands()).toEqual([])
  })

  it("closes the confirmation on Escape, which declines", async () => {
    const { iframe, registration } = await mounted("admin")
    const page = await live<ProbeWindow>(iframe, registration, PROBE)
    act(() => page.go("undo", {}))
    await screen.findByRole("alertdialog")
    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(page.results).toHaveLength(1))
    expect(page.results[0]).toMatchObject({ code: "cancelled" })
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("shows the fallback and a clear line for a page written for the older bridge", async () => {
    const { view, iframe, registration } = await mounted()
    const legacy = `<!doctype html><html><head></head><body><script>
      loreweaver.ready(); loreweaver.onState(function () {});
    </script></body></html>`
    act(() => {
      servePage(iframe, legacy, registration)
    })
    expect(await screen.findByRole("alert")).toHaveTextContent("This page was written for an older client.")
    expect(screen.getByText("Roll in the rich client.")).toBeInTheDocument()
    expect(view.container.querySelector("iframe")).toBeNull()
  })

  it("shows the fallback the moment the page crashes before it is ready, with its own line", async () => {
    const { iframe, registration } = await mounted()
    const crashing = `<!doctype html><html><head></head><body><script>
      null.boom();
    </script></body></html>`
    act(() => {
      servePage(iframe, crashing, registration)
    })
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("This panel did not start")
    expect(alert).toHaveTextContent("The panel reported:")
    expect(screen.getByText("Roll in the rich client.")).toBeInTheDocument()
  })

  it("falls back with a retry line when the page cannot be fetched", async () => {
    const user = userEvent.setup()
    vi.mocked(ensurePage).mockRejectedValueOnce(new Error("offline"))
    room = await TestRoom.open("player")
    const { container } = render(<Tier2Frame panel={QUICK_ROLL} />)
    expect(await screen.findByText("This page could not be fetched.")).toBeInTheDocument()
    expect(screen.getByText("Roll in the rich client.")).toBeInTheDocument()
    expect(container.querySelector("iframe")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull())
  })

  it("unmounts cleanly: the registration goes, the views are let go, an open question is withdrawn", async () => {
    const { r, view, iframe, registration } = await mounted("admin")
    const subscribed = r
      .requests()
      .flatMap((frame) =>
        frame.type === "call" && frame.method === "view.subscribe" ? (frame.params.names as string[]) : [],
      )
    expect(subscribed).toContain("harbor/tide")
    const page = await live<ProbeWindow>(iframe, registration, PROBE)
    act(() => page.go("undo", {}))
    await screen.findByRole("alertdialog")

    view.unmount()
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(panelServeUnregister).toHaveBeenCalledWith(registration.token)
    await act(async () => undefined)
    expect(r.requests().at(-1)).toMatchObject({
      method: "view.unsubscribe",
      params: { names: ["harbor/tide"] },
    })
    expect(r.commands()).toEqual([])
  })
})

describe("a page in the overlay", () => {
  it("keeps the overlay's focus, Escape and chrome with a running frame inside", async () => {
    const user = userEvent.setup()
    usePanelsStore.setState({ collapsed: {}, closed: {}, modalOpen: null })
    room = await TestRoom.open("player")
    await room.view("panels", { panels: [{ ...QUICK_ROLL, slot: "modal" }] })
    render(<PanelModalHost />)
    act(() => usePanelsStore.getState().openModal(QUICK_ROLL.id))
    const dialog = await screen.findByRole("dialog", { name: "Quick roll" })
    const iframe = await waitFor(() => {
      const el = dialog.querySelector("iframe")
      if (!el) throw new Error("no frame yet")
      return el
    })
    const registration: Head = vi.mocked(panelServeRegister).mock.calls.at(-1)![0]
    await live(iframe, registration)
    // Mounting and readying the frame does not take focus from the overlay.
    expect(dialog).toHaveFocus()

    // Focus goes into the frame; a click on the overlay's own chrome takes it back out.
    act(() => iframe.focus())
    expect(iframe).toHaveFocus()
    await user.click(within(dialog).getByText("Quick roll"))
    expect(dialog).toHaveFocus()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(panelServeUnregister).toHaveBeenCalledWith(registration.token)
  })
})

describe("docs/PAGE-BRIDGE.md", () => {
  it("shows the example page these tests run, verbatim", () => {
    expect(PAGE_BRIDGE_DOC).toContain(EXAMPLE_PAGE.trim())
  })
})
