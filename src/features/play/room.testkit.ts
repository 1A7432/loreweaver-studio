// Test doubles for the room screen (protocol 3.0): a REAL connection owner and a REAL
// protocol `Session`, behind the fake link driver of `lib/connection.testkit.ts`, put in
// the app's connection slot — so a component under test reads exactly what the app's
// would. A test feeds server frames and answers the requests the session sent.
//
// The view values in `fixtures/views.json` are not written from memory: they are the
// engine's own built-in views computed by its server code over the engine's view-test
// room (`server/test/gateway/views/fixture.ts` `seededRoom()`, viewers Ada = player,
// Root = admin, Eve = observer), with the `commands` table cut to the entries this
// client's tests use and the `audio` view left out. The session checks every built-in
// view against the protocol package's schema, so a fixture that drifted from the
// protocol would be dropped, and the tests would say so. Imported by tests only.
//
// `fixtures/actions.json` is computed the same way for the tools of the admin screens, the
// sound, the pictures and the report: the engine's command bench with a file store and the
// admin's settings (`server/test/gateway/commands/bench.ts` `bench({media: true, admin: true})`,
// the two sounds of `seed.ts` `seedSounds`), its `commands` view cut to the entries those tools
// use, its `room`, `audio`, `admin/keys`, `admin/model` and `admin/content` views, and the real
// results (and `audio` signals) of the commands they run there.

import { act } from "@testing-library/react"
import type { ClientFrame, Role } from "loreweaver-protocol/v3"
import { Connection } from "../../lib/connection"
import { DEFAULT_REDIAL_BASE_MS } from "../../lib/connection"
import { FakeDriver, ManualTimers, WELCOME, flush, welcome } from "../../lib/connection.testkit"
import { ROOM_VIEWS, useConnectionStore } from "../../store/connection"
import FIXTURE from "./fixtures/views.json"
import ACTIONS from "./fixtures/actions.json"

/** The engine-computed views and results of `fixtures/actions.json` (see the header). */
export const ACTION_FIXTURE = ACTIONS

/** A deep copy of one of the engine's command results in `fixtures/actions.json`. */
export function actionResult(name: keyof typeof ACTIONS.results): Record<string, unknown> {
  return structuredClone(ACTIONS.results[name]) as Record<string, unknown>
}

/** The result frame body (`ok` and `text`/`data`, or `error`) of an engine result. */
export function resultBody(
  name: keyof typeof ACTIONS.results,
): { ok: true; data?: unknown; text?: string } | { ok: false; error: { code: string; message: string } } {
  const result = actionResult(name) as {
    ok: boolean
    text?: string
    data?: unknown
    error?: { code: string; message: string }
  }
  if (!result.ok) return { ok: false, error: result.error as { code: string; message: string } }
  return { ok: true, data: result.data, ...(result.text === undefined ? {} : { text: result.text }) }
}

/** The member each role is welcomed as: the fixture room's own viewers. */
export const MEMBERS: Record<Role, { id: string; name: string; role: Role }> = {
  player: { id: "m-ada", name: "Ada", role: "player" },
  admin: { id: "m-root", name: "Root", role: "admin" },
  observer: { id: "m-eve", name: "Eve", role: "observer" },
}

/** A deep copy of the fixture's value of one view for one role, to change freely. */
export function fixtureView(role: Role, name: string): Record<string, unknown> {
  const views = FIXTURE[role] as Record<string, unknown>
  if (!(name in views)) throw new Error(`no fixture view ${name}`)
  return structuredClone(views[name]) as Record<string, unknown>
}

type Request = Extract<ClientFrame, { rid: string }>

export class TestRoom {
  readonly driver = new FakeDriver()
  readonly timers = new ManualTimers()
  readonly connection: Connection
  readonly #revs = new Map<string, number>()

  constructor(views: readonly string[] = ROOM_VIEWS) {
    this.connection = new Connection({
      ticket: "endpointabc",
      key: "k-test",
      locale: "en",
      client: { name: "loreweaver-studio", version: "0.0.0-test" },
      driver: this.driver,
      timers: this.timers,
      now: this.timers.clock,
      views,
    })
    useConnectionStore.setState({ connection: this.connection })
  }

  /** A room welcomed as `role`, holding every room view of the fixture for that role. */
  static async open(role: Role = "player", options: { views?: boolean; head?: number; first?: number } = {}) {
    const room = new TestRoom()
    await room.welcome(role, { head: options.head ?? 0, first: options.first ?? 0 })
    if (options.views !== false) await room.feedFixtureViews(role)
    return room
  }

  async welcome(role: Role, patch: Partial<typeof WELCOME> = {}): Promise<void> {
    await act(async () => {
      this.connection.start()
      this.connection.handleEvent(this.driver.up())
      await flush()
      this.connection.handleEvent(this.driver.frame(welcome({ you: MEMBERS[role], ...patch })))
      await flush()
    })
  }

  /** Server frames, in order, as the link delivers them. */
  async feed(...frames: unknown[]): Promise<void> {
    await act(async () => {
      for (const frame of frames) this.connection.handleEvent(this.driver.frame(frame))
      await flush()
    })
  }

  /** A `view` frame for `name` under the next rev of this connection. */
  viewFrame(name: string, data: unknown, at = 0) {
    const rev = (this.#revs.get(name) ?? 0) + 1
    this.#revs.set(name, rev)
    return { type: "view", name, rev, at, data }
  }

  async view(name: string, data: unknown): Promise<void> {
    await this.feed(this.viewFrame(name, data))
  }

  async feedFixtureViews(role: Role): Promise<void> {
    await this.feed(...ROOM_VIEWS.map((name) => this.viewFrame(name, fixtureView(role, name))))
  }

  /** Every request (`input`, `call`) the session sent on the current link, oldest first. */
  requests(): Request[] {
    return this.driver
      .framesOn(this.driver.id)
      .filter((frame): frame is Request => frame.type === "input" || frame.type === "call")
  }

  /** The `command.run` calls sent, as `{id, args}`. */
  commands(): { id: string; args: unknown }[] {
    return this.requests()
      .filter((frame) => frame.type === "call" && frame.method === "command.run")
      .map((frame) => {
        const params = (frame as Extract<ClientFrame, { type: "call" }>).params as {
          id: string
          args: unknown
        }
        return { id: params.id, args: params.args }
      })
  }

  /** The newest request that is not a view subscription. */
  lastRequest(): Request {
    const own = this.requests().filter(
      (frame) => !(frame.type === "call" && frame.method.startsWith("view.")),
    )
    const last = own.at(-1)
    if (last === undefined) throw new Error("no request sent")
    return last
  }

  /** Answer the newest request (or `request`) with a result. */
  async answer(
    result:
      { ok: true; data?: unknown; text?: string } | { ok: false; error: { code: string; message: string } },
    request: Request = this.lastRequest(),
  ): Promise<void> {
    await this.feed({ type: "result", rid: request.rid, ...result })
  }

  /** After a drop: the redial fires, the link comes up and the server welcomes `role` again. */
  async redial(role: Role, patch: Partial<typeof WELCOME> = {}): Promise<void> {
    await act(async () => {
      this.timers.advance(DEFAULT_REDIAL_BASE_MS)
      this.connection.handleEvent(this.driver.up())
      await flush()
      this.connection.handleEvent(this.driver.frame(welcome({ you: MEMBERS[role], ...patch })))
      await flush()
    })
  }

  /** The `commands` (and `room`) views of `fixtures/actions.json` for `role`. */
  async actionViews(role: Role): Promise<void> {
    const views = ACTIONS as unknown as {
      commands: Record<string, unknown>
      room: Record<string, unknown>
    }
    await this.view("commands", structuredClone(views.commands[role]))
    if (role in views.room) await this.view("room", structuredClone(views.room[role]))
  }

  /** The link drops (the transport noticed). */
  async drop(): Promise<void> {
    await act(async () => {
      this.connection.handleEvent(this.driver.closed("connection_lost"))
      await flush()
    })
  }

  /** Stop for good: requests still waiting are rejected (inside `act`, as they update state). */
  close(): void {
    act(() => {
      this.connection.stop()
      useConnectionStore.setState({ connection: null })
    })
  }
}
