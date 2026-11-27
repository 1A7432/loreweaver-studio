// Test doubles for the 3.0 connection owner: a link driver that records what
// the owner asks of the bridge, timers that run only when a test says so, and
// the server frames a test feeds back. Imported by tests only.

import type { ClientFrame, Timers, WelcomeFrame } from "loreweaver-protocol/v3"
import type { LinkDriver } from "./connection"
import type { ConnectionGeneration, LinkCloseCode, LinkEvent, NetworkProfile } from "./transport"

export const WELCOME: WelcomeFrame = {
  type: "welcome",
  protocol: "3.0",
  server: { name: "loreweaver", version: "3.0.0-alpha.0" },
  room: { id: "main", locale: "en" },
  you: { id: "m:15b5f3445045", name: "Ada", role: "admin" },
  features: [],
  epoch: 1,
  head: 0,
  first: 0,
}

export function welcome(patch: Partial<WelcomeFrame> = {}): WelcomeFrame {
  return { ...WELCOME, ...patch }
}

export function fatal(code: string, message = `refused: ${code}`) {
  return { type: "error", code, message, fatal: true }
}

export function narrativeEvent(seq: number) {
  return {
    type: "event",
    seq,
    id: `e-${seq}`,
    ts: 1_764_240_000_000 + seq,
    kind: "narrative",
    data: { speaker: "kp", text: `line ${seq}`, format: "markdown" },
  }
}

/** Let queued promise callbacks run (the owner's send chain, the session's requests). */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** Timers that fire only on `advance`, against a clock the test owns. */
export class ManualTimers implements Timers {
  now = 0
  #next = 1
  #tasks = new Map<number, { at: number; run: () => void }>()

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.#next++
    this.#tasks.set(id, { at: this.now + Math.max(0, ms), run: callback })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this.#tasks.delete(handle as number)
  }

  clock = (): number => this.now

  get pending(): number {
    return this.#tasks.size
  }

  /** Move the clock on, firing every task that falls due, in order. */
  advance(ms: number): void {
    const until = this.now + ms
    for (;;) {
      let due: [number, { at: number; run: () => void }] | undefined
      for (const entry of this.#tasks)
        if (entry[1].at <= until && (due === undefined || entry[1].at < due[1].at)) due = entry
      if (due === undefined) break
      this.#tasks.delete(due[0])
      this.now = due[1].at
      due[1].run()
    }
    this.now = until
  }
}

interface Dial {
  ticket: string
  network: NetworkProfile
  generation: ConnectionGeneration
}

/** Records the owner's bridge calls; a test answers for the bridge with `up`, `frame`, `closed`. */
export class FakeDriver implements LinkDriver {
  readonly dials: Dial[] = []
  readonly sent: { connectionId: string; frame: ClientFrame }[] = []
  readonly disconnected: string[] = []
  /** When set, every send waits for it (a slow `invoke`). */
  gate: Promise<void> | null = null
  /** When set, sends are refused with it. */
  refuseSends: Error | null = null
  /** When set, dials are refused with it. */
  refuseDials: Error | null = null

  connect = async (params: Dial): Promise<void> => {
    this.dials.push(params)
    if (this.refuseDials) throw this.refuseDials
  }

  send = async (connectionId: string, frame: ClientFrame): Promise<void> => {
    this.sent.push({ connectionId, frame })
    if (this.gate) await this.gate
    if (this.refuseSends) throw this.refuseSends
  }

  disconnect = async (connectionId: string): Promise<void> => {
    this.disconnected.push(connectionId)
  }

  /** The bridge generation of the latest dial. */
  get id(): string {
    const dial = this.dials.at(-1)
    if (dial === undefined) throw new Error("nothing dialled")
    return dial.generation.connectionId
  }

  framesOn(connectionId: string): ClientFrame[] {
    return this.sent.filter((entry) => entry.connectionId === connectionId).map((entry) => entry.frame)
  }

  up(connectionId = this.id): LinkEvent {
    return { kind: "status", connectionId, status: "up" }
  }

  closed(code: LinkCloseCode, connectionId = this.id): LinkEvent {
    return { kind: "status", connectionId, status: "closed", code, reason: code }
  }

  frame(frame: unknown, connectionId = this.id): LinkEvent {
    return { kind: "frame", connectionId, frame }
  }
}
