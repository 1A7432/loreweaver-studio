// The host side of the page bridge, version 2 (docs/PAGE-BRIDGE.md), against a fake frame
// window: what a page is handed, what it may do, and what is refused before anything reaches
// the room.
import { describe, expect, it, vi } from "vitest"
import type { EventFrame, Result, ViewCommand } from "loreweaver-protocol/v3"
import {
  buildBootstrapJs,
  buildThemeCss,
  MAX_PAGE_MESSAGE_BYTES,
  MAX_RUN_ARGS_BYTES,
  PAGE_RUN_BURST,
  PAGE_RUN_REFILL_MS,
  PageBridge,
  pageViews,
  type LocalRefusal,
  type PageBridgeOptions,
} from "./bridge"

const NONCE = "0123456789abcdef0123456789abcdef"

const COMMANDS: ViewCommand[] = [
  {
    id: "roll",
    source: "engine",
    title: "Roll dice",
    description: "",
    params: {},
    role: "player",
    available: true,
  },
  {
    id: "undo",
    source: "engine",
    title: "Undo",
    description: "Take back turns.",
    params: {},
    role: "player",
    available: true,
    danger: true,
  },
  {
    id: "check",
    source: "engine",
    title: "Check",
    description: "",
    params: {},
    role: "player",
    available: false,
    reason: "no_rule_system",
  },
]

function event(seq: number): EventFrame {
  return {
    type: "event",
    seq,
    id: `e${seq}`,
    ts: 1000 + seq,
    kind: "narrative",
    turn: 1,
    data: { speaker: "kp", text: `line ${seq}`, format: "plain" },
  }
}

/** A mounted page with a fake frame window; everything the host posts is in `posted`. */
function mount(overrides: Partial<PageBridgeOptions> = {}) {
  const frame = { name: "frame" }
  const posted: Record<string, unknown>[] = []
  const state = {
    views: { tide: { level: 3 } } as Record<string, unknown>,
    events: [event(1), event(2)],
    head: 2,
    commands: COMMANDS as ViewCommand[] | null,
    now: 0,
  }
  const run = vi.fn<(id: string, args: Record<string, unknown>) => Promise<Result>>(async () => ({
    ok: true,
    data: { totals: [7] },
    text: "1d20 = 7",
  }))
  const confirm = vi.fn<(command: ViewCommand, signal: AbortSignal) => Promise<boolean>>(async () => true)
  const warn = vi.fn()
  const onReady = vi.fn()
  const onLegacy = vi.fn()
  const onPanelError = vi.fn()
  const bridge = new PageBridge({
    panel: { id: "harbor/map", title: "Harbor map" },
    nonce: NONCE,
    locale: "en",
    theme: "dark",
    getSource: () => frame,
    post: (message) => posted.push(message),
    member: () => ({ name: "Ada", role: "player" }),
    views: () => state.views,
    log: () => ({ events: state.events, head: state.head }),
    commands: () => state.commands,
    run,
    confirm,
    refusalText: (code: LocalRefusal, params) => `${code}:${JSON.stringify(params)}`,
    now: () => state.now,
    onReady,
    onLegacy,
    onPanelError,
    warn,
    ...overrides,
  })
  // jsdom's MessageEvent refuses a plain object as `source`: it is set by property.
  const deliver = (data: unknown, source: unknown = frame) => {
    const message = new MessageEvent("message", { data })
    Object.defineProperty(message, "source", { value: source })
    bridge.handleMessage(message)
  }
  const ready = () => deliver({ lw: "2", nonce: NONCE, type: "ready" })
  const runCall = (call: number, command: unknown, args?: unknown) =>
    deliver({ lw: "2", nonce: NONCE, type: "run", call, command, ...(args === undefined ? {} : { args }) })
  const results = () => posted.filter((message) => message.type === "run_result")
  return {
    bridge,
    posted,
    state,
    run,
    confirm,
    warn,
    onReady,
    onLegacy,
    onPanelError,
    deliver,
    ready,
    runCall,
    results,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the envelope", () => {
  it("accepts a message only from the mounted frame's window, with this mount's nonce", () => {
    const page = mount()
    page.deliver({ lw: "2", nonce: NONCE, type: "ready" }, { name: "another window" })
    page.deliver({ lw: "2", nonce: "f".repeat(32), type: "ready" })
    page.deliver({ lw: "2", type: "ready" })
    page.deliver("ready")
    expect(page.posted).toEqual([])
    expect(page.onReady).not.toHaveBeenCalled()
    page.ready()
    expect(page.onReady).toHaveBeenCalledTimes(1)
  })

  it("drops a message over the size cap, with a console note", () => {
    const page = mount()
    page.ready()
    page.runCall(1, "roll", { x: "a".repeat(MAX_PAGE_MESSAGE_BYTES) })
    expect(page.warn).toHaveBeenCalledWith(expect.stringContaining("dropped"))
    expect(page.run).not.toHaveBeenCalled()
    expect(page.results()).toEqual([])
  })

  it("tells a page written for bridge 1 apart, and never readies it", () => {
    const page = mount()
    page.deliver({ lw: "1", nonce: NONCE, type: "legacy" })
    page.deliver({ lw: "1", nonce: NONCE, type: "intent", kind: "input", value: "hi" })
    expect(page.onLegacy).toHaveBeenCalledTimes(1)
    page.ready()
    expect(page.onReady).not.toHaveBeenCalled()
    expect(page.posted).toEqual([])
    // A legacy message from another window changes nothing.
    const other = mount()
    other.deliver({ lw: "1", nonce: NONCE, type: "legacy" }, {})
    expect(other.onLegacy).not.toHaveBeenCalled()
  })

  it("passes a crash report on as one capped line", () => {
    const page = mount()
    page.deliver({ lw: "2", nonce: NONCE, type: "panel_error", message: "x".repeat(500) })
    expect(page.onPanelError).toHaveBeenCalledWith("x".repeat(200))
  })
})

describe("ready, views and events", () => {
  it("answers ready with the panel, the language, the theme, the member and the current views", () => {
    const page = mount()
    page.ready()
    expect(page.posted).toEqual([
      {
        lw: "2",
        nonce: NONCE,
        type: "ready_ack",
        panel: { id: "harbor/map", title: "Harbor map" },
        locale: "en",
        theme: "dark",
        member: { name: "Ada", role: "player" },
        views: { tide: { level: 3 } },
      },
    ])
    page.ready()
    expect(page.posted).toHaveLength(1)
  })

  it("posts the views when they change, and only then", () => {
    const page = mount()
    page.bridge.syncViews()
    expect(page.posted).toEqual([]) // not ready yet
    page.ready()
    page.bridge.syncViews()
    expect(page.posted).toHaveLength(1)
    page.state.views = { tide: { level: 3 } } // a new object, the same value
    page.bridge.syncViews()
    expect(page.posted).toHaveLength(1)
    page.state.views = { tide: { level: 9 } }
    page.bridge.syncViews()
    expect(page.posted.at(-1)).toEqual({
      lw: "2",
      nonce: NONCE,
      type: "views",
      views: { tide: { level: 9 } },
    })
  })

  it("hands over only the events after the page became ready, each once, without `type`", () => {
    const page = mount()
    page.state.events = [...page.state.events, event(3)]
    page.state.head = 3
    page.bridge.syncEvents() // before ready: nothing, and no replay later
    page.ready()
    page.bridge.syncEvents()
    expect(page.posted.filter((m) => m.type === "event")).toEqual([])
    page.state.events = [...page.state.events, event(5)]
    page.bridge.syncEvents()
    page.bridge.syncEvents()
    expect(page.posted.filter((m) => m.type === "event")).toEqual([
      {
        lw: "2",
        nonce: NONCE,
        type: "event",
        event: {
          seq: 5,
          id: "e5",
          ts: 1005,
          kind: "narrative",
          turn: 1,
          data: { speaker: "kp", text: "line 5", format: "plain" },
        },
      },
    ])
  })

  it("delivers a reset like any other event", () => {
    const page = mount()
    page.ready()
    page.state.events = [
      { type: "event", seq: 9, id: "r", ts: 1, kind: "reset", data: { scope: "all", epoch: 2 } },
    ]
    page.bridge.syncEvents()
    const last = page.posted.at(-1) as { type: string; event: Record<string, unknown> }
    expect(last).toMatchObject({
      type: "event",
      event: { seq: 9, kind: "reset", data: { scope: "all", epoch: 2 } },
    })
    expect("turn" in last.event).toBe(false)
  })
})

describe("pageViews", () => {
  it("keys the declared views by handle, null when not held, without hidden list elements", () => {
    const held = new Map<string, { data: unknown }>([
      [
        "variables",
        {
          data: {
            module: [
              { id: "dread", value: 2 },
              { id: "secret", value: 9, hidden: true },
            ],
          },
        },
      ],
      ["me", { data: { member: { name: "Ada" } } }],
      ["admin/keys", { data: { keys: ["never-crosses"] } }],
    ])
    const views = pageViews(
      {
        views: [
          { as: "vars", view: "variables" },
          { as: "me", view: "me" },
          { as: "tide", view: "harbor/tide" },
        ],
      },
      held,
    )
    expect(views).toEqual({
      vars: { module: [{ id: "dread", value: 2 }] },
      me: { member: { name: "Ada" } },
      tide: null,
    })
    expect(JSON.stringify(views)).not.toContain("never-crosses")
  })
})

describe("run", () => {
  it("runs a listed command as command.run and passes the result through", async () => {
    const page = mount()
    page.ready()
    page.runCall(1, "roll", { expr: "1d20" })
    await settle()
    expect(page.run).toHaveBeenCalledWith("roll", { expr: "1d20" })
    expect(page.results()).toEqual([
      {
        lw: "2",
        nonce: NONCE,
        type: "run_result",
        call: 1,
        result: { ok: true, text: "1d20 = 7", data: { totals: [7] } },
      },
    ])
  })

  it("passes the server's refusal through in its own words", async () => {
    const page = mount({
      run: async () => ({
        ok: false,
        error: { code: "bad_dice", message: "That is not a dice expression." },
      }),
    })
    page.ready()
    page.runCall(2, "roll", { expr: "x" })
    await settle()
    expect(page.results()[0].result).toEqual({
      ok: false,
      code: "bad_dice",
      message: "That is not a dice expression.",
    })
  })

  it("an answer without text or data is just ok; args default to {}", async () => {
    const page = mount({ run: async () => ({ ok: true, data: undefined }) })
    page.ready()
    page.runCall(3, "roll")
    await settle()
    expect(page.results()[0].result).toEqual({ ok: true })
    const plain = mount()
    plain.ready()
    plain.runCall(1, "roll")
    await settle()
    expect(plain.run).toHaveBeenCalledWith("roll", {})
  })

  it("refuses an unknown or unavailable command locally, with the reason", async () => {
    const page = mount()
    page.ready()
    page.runCall(1, "nope")
    page.runCall(2, "check")
    await settle()
    expect(page.run).not.toHaveBeenCalled()
    const [unknown, unavailable] = page.results().map((m) => m.result)
    expect(unknown).toEqual({
      ok: false,
      code: "unavailable",
      reason: "unknown",
      message: 'unavailable:{"command":"nope","reason":"unknown"}',
    })
    expect(unavailable).toMatchObject({ ok: false, code: "unavailable", reason: "no_rule_system" })
    // Without the commands view nothing is known to be runnable.
    const blind = mount()
    blind.state.commands = null
    blind.ready()
    blind.runCall(1, "roll")
    await settle()
    expect(blind.run).not.toHaveBeenCalled()
    expect(blind.results()[0].result).toMatchObject({ code: "unavailable" })
  })

  it("asks the person before a danger command, and runs it only on yes", async () => {
    const page = mount()
    page.ready()
    page.confirm.mockResolvedValueOnce(true)
    page.runCall(1, "undo", { turns: 1 })
    await settle()
    expect(page.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ id: "undo" }),
      expect.any(AbortSignal),
    )
    expect(page.run).toHaveBeenCalledWith("undo", { turns: 1 })

    page.confirm.mockResolvedValueOnce(false)
    page.runCall(2, "undo", { turns: 1 })
    await settle()
    expect(page.run).toHaveBeenCalledTimes(1)
    expect(page.results()[1].result).toMatchObject({ ok: false, code: "cancelled" })
  })

  it("asks one danger question at a time", async () => {
    let answer: (agreed: boolean) => void = () => undefined
    const page = mount()
    page.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)))
    page.ready()
    page.runCall(1, "undo")
    page.runCall(2, "undo")
    await settle()
    expect(page.results()).toEqual([
      expect.objectContaining({ call: 2, result: expect.objectContaining({ code: "busy" }) }),
    ])
    answer(true)
    await settle()
    expect(page.results()[1]).toMatchObject({ call: 1, result: { ok: true } })
  })

  it("is rate-limited per page", async () => {
    const page = mount()
    page.ready()
    for (let call = 1; call <= PAGE_RUN_BURST + 1; call++) page.runCall(call, "roll")
    await settle()
    const result = (call: number) => page.results().find((m) => m.call === call)?.result
    expect(page.run).toHaveBeenCalledTimes(PAGE_RUN_BURST)
    expect(result(PAGE_RUN_BURST + 1)).toMatchObject({ ok: false, code: "rate_limited" })
    page.state.now += PAGE_RUN_REFILL_MS
    page.runCall(99, "roll")
    await settle()
    expect(page.run).toHaveBeenCalledTimes(PAGE_RUN_BURST + 1)
    page.runCall(100, "roll")
    await settle()
    expect(result(100)).toMatchObject({ code: "rate_limited" })
  })

  it("caps the size of args and refuses what is not an object", async () => {
    const page = mount()
    page.ready()
    page.runCall(1, "roll", { expr: "a".repeat(MAX_RUN_ARGS_BYTES) })
    page.runCall(2, "roll", ["not", "an", "object"])
    page.runCall(3, "", {})
    page.runCall(4, 42, {})
    await settle()
    expect(page.run).not.toHaveBeenCalled()
    expect(page.results().map((m) => (m.result as { code: string }).code)).toEqual([
      "too_large",
      "invalid_params",
      "invalid_params",
      "invalid_params",
    ])
  })

  it("refuses before ready, and says when the command never reached the room", async () => {
    const page = mount({
      run: async () => {
        throw Object.assign(new Error("no link"), { code: "not_connected" })
      },
    })
    page.runCall(1, "roll")
    await settle()
    expect(page.results()[0].result).toMatchObject({ code: "not_ready" })
    page.ready()
    page.runCall(2, "roll")
    await settle()
    expect(page.results()[1].result).toMatchObject({
      ok: false,
      code: "not_sent",
      message: expect.stringContaining("not_connected"),
    })
  })

  it("on unmount, withdraws an open confirmation and posts nothing more", async () => {
    let signal: AbortSignal | null = null
    let finishRun: (result: Result) => void = () => undefined
    const page = mount({ run: () => new Promise<Result>((resolve) => (finishRun = resolve)) })
    page.confirm.mockImplementationOnce(
      (_command, given) =>
        new Promise<boolean>((resolve) => {
          signal = given
          given.addEventListener("abort", () => resolve(false))
        }),
    )
    page.ready()
    page.runCall(1, "roll")
    page.runCall(2, "undo")
    await settle()
    const before = page.posted.length
    page.bridge.dispose()
    expect(signal!.aborted).toBe(true)
    finishRun({ ok: true, data: null })
    await settle()
    page.state.views = { tide: { level: 10 } }
    page.bridge.syncViews()
    page.state.events = [...page.state.events, event(7)]
    page.bridge.syncEvents()
    expect(page.posted).toHaveLength(before)
  })
})

describe("the page's head", () => {
  it("bakes only the nonce into the bootstrap, and refuses anything else as one", () => {
    const js = buildBootstrapJs(NONCE)
    expect(js).toContain(`var NONCE = "${NONCE}"`)
    expect(js.toLowerCase()).not.toContain("</script")
    expect(() => buildBootstrapJs('"; alert(1); "')).toThrow()
  })

  it("writes the theme as one :root rule", () => {
    expect(buildThemeCss({ "--lw-ink": "#fff" })).toBe(":root {\n  --lw-ink: #fff;\n}\n")
  })
})
