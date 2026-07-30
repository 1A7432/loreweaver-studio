import { describe, expect, it } from "vitest"
import type { StateFrame } from "@loreweaver/protocol"
import {
  buildBootstrapJs,
  buildThemeCss,
  MAX_INTENT_VALUE_CHARS,
  MAX_QUEUED_EVENTS,
  mintSecret,
  PanelBridge,
  projectStateForPanel,
  type PanelBridgeOptions,
} from "./bridge"

const PANEL_SOURCE = { tag: "iframe-window" }

function makeBridge(overrides: Partial<PanelBridgeOptions> = {}) {
  const posts: Array<Record<string, unknown>> = []
  const intents: unknown[] = []
  const bridge = new PanelBridge({
    panelId: "blackmoor/manor-map",
    nonce: "n".repeat(32),
    locale: "zh",
    theme: { "--lw-bg": "#131118" },
    getSource: () => PANEL_SOURCE,
    postToPanel: (message) => posts.push(message),
    sendIntent: (frame) => intents.push(frame),
    getSnapshot: () => ({
      variables: [],
      party: [],
      initiative: [],
      online: 2,
    }),
    ...overrides,
  })
  const message = (data: unknown, source: unknown = PANEL_SOURCE) =>
    bridge.handleMessage({ data, source } as unknown as MessageEvent)
  return { bridge, posts, intents, message }
}

const READY = { lw: "1", nonce: "n".repeat(32), type: "ready" }

describe("PanelBridge", () => {
  it("answers ready with ack + locale + theme + state snapshot", () => {
    const { posts, message, bridge } = makeBridge()
    expect(bridge.isReady()).toBe(false)
    message(READY)
    expect(bridge.isReady()).toBe(true)
    expect(posts[0]).toMatchObject({
      type: "ready_ack",
      panel: "blackmoor/manor-map",
      locale: "zh",
      theme: { "--lw-bg": "#131118" },
      lw: "1",
    })
    expect(posts[1]).toMatchObject({ type: "state", state: { online: 2 } })
  })

  it("drops messages with a wrong nonce or foreign source", () => {
    const { posts, intents, message } = makeBridge()
    message({ ...READY, nonce: "x".repeat(32) })
    message(READY, { tag: "someone-else" })
    message(null)
    message("ready")
    expect(posts).toHaveLength(0)
    expect(intents).toHaveLength(0)
  })

  it("validates intents: kind whitelist and value cap", () => {
    const { intents, message } = makeBridge()
    const intent = (kind: unknown, value: unknown) =>
      message({ lw: "1", nonce: "n".repeat(32), type: "intent", kind, value })

    intent("roll", "1d100")
    expect(intents).toEqual([
      { type: "panel_intent", panel: "blackmoor/manor-map", kind: "roll", value: "1d100" },
    ])

    intent("admin", "x")
    intent("input", "")
    intent("input", 42)
    intent("choice", "x".repeat(MAX_INTENT_VALUE_CHARS + 1))
    expect(intents).toHaveLength(1)

    intent("input", "x".repeat(MAX_INTENT_VALUE_CHARS))
    expect(intents).toHaveLength(2)
  })

  it("pushes state only after ready, and queues events (bounded) before ready", () => {
    const { bridge, posts, message } = makeBridge()
    bridge.pushState({ variables: [], party: [], initiative: [], online: 1 })
    expect(posts).toHaveLength(0)

    for (let i = 0; i < MAX_QUEUED_EVENTS + 4; i++) bridge.pushEvent({ seq: i })
    message(READY)
    const events = posts.filter((p) => p.type === "event")
    expect(events).toHaveLength(MAX_QUEUED_EVENTS)
    expect(events[0].payload).toEqual({ seq: 4 })

    bridge.pushEvent({ seq: "live" })
    expect(posts.filter((p) => p.type === "event")).toHaveLength(MAX_QUEUED_EVENTS + 1)
  })
})

describe("projectStateForPanel", () => {
  it("keeps the state-frame shapes and strips hidden variables", () => {
    const frame = {
      type: "state",
      party: [{ name: "Nyx", online: true, active: true }],
      initiative: [],
      online: 3,
      clock: { time: "23:10" },
      variables: [
        { id: "fear", label: "恐慌", kind: "number", value: 4 },
        { id: "secret", label: "暗线", kind: "number", value: 1, hidden: true },
      ],
      reset: true,
    } as unknown as StateFrame
    const snapshot = projectStateForPanel(frame)
    expect(snapshot?.variables.map((v) => v.id)).toEqual(["fear"])
    expect(snapshot?.clock).toEqual({ time: "23:10" })
    expect(snapshot?.online).toBe(3)
    expect(snapshot && "reset" in snapshot).toBe(false)
    expect(projectStateForPanel(null)).toBeNull()
  })
})

describe("host-injected assets", () => {
  it("mints 128-bit lowercase hex secrets", () => {
    const secret = mintSecret()
    expect(secret).toMatch(/^[0-9a-f]{32}$/)
    expect(mintSecret()).not.toBe(secret)
  })

  it("builds theme css from the collected record", () => {
    const css = buildThemeCss({ "--lw-bg": "#131118", "--lw-ink": "#e9e4d8" })
    expect(css).toContain(":root {")
    expect(css).toContain("--lw-bg: #131118;")
    expect(css).toContain("--lw-ink: #e9e4d8;")
  })

  it("bakes nonce, panel and parent origin into the bootstrap", () => {
    const js = buildBootstrapJs("abc123", "pack/panel", "tauri://localhost")
    expect(js).toContain('"abc123"')
    expect(js).toContain('"pack/panel"')
    expect(js).toContain('"tauri://localhost"')
    expect(js).toContain("window.loreweaver")
    expect(js).toContain('version: "1"')
    // The bootstrap authenticates its host exactly like the host authenticates it.
    expect(js).toContain("event.source !== window.parent")
  })
})
