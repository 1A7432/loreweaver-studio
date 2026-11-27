// The connection owner (protocol 3.0): one table, one `Session`, any number of
// links over its life. Modelled on the terminal client's `connection.ts`,
// adapted to a link that lives in the Tauri core.
//
// It dials through a `LinkDriver` (the Rust bridge in the app, a fake in tests),
// attaches the protocol `Session` to every link that comes up — the session
// says `hello`, resuming with `{epoch, after}` from the log it kept — keeps the
// link alive with a client ping, and redials with backoff after a drop, but
// ONLY while `session.canRedial`: a fatal `error` (a bad key, another protocol
// major…) ends the session for good and nothing here dials again. It is the one
// authority for redialling; the Rust link never redials by itself.
//
// Two rules the Tauri bridge makes this class keep:
//   - one link = one bridge generation (`connectionId`); an event stamped with
//     any other generation is ignored, so a dying link cannot write into the
//     session after its successor came up;
//   - outbound sends are SERIALISED per link: Tauri may run two `invoke`s out of
//     order, and `hello` must reach the wire before anything else. Each send is
//     issued only once the one before it has settled.
//
// Server state lives in the session's snapshot alone (React reads it with
// `useSyncExternalStore(session.subscribe, session.getSnapshot)`). What this
// class keeps besides is the client's own: the phase of the link, the redial
// count, and why it stopped.
import {
  Session,
  SessionError,
  type ClientFrame,
  type Timers,
  type WelcomeFrame,
} from "loreweaver-protocol/v3"
import {
  createGeneration,
  type ConnectionGeneration,
  type LinkCloseCode,
  type LinkEvent,
  type NetworkProfile,
} from "./transport"

/** What the connection owner needs from a link: the Rust bridge's three commands. */
export interface LinkDriver {
  connect(params: {
    ticket: string
    network: NetworkProfile
    generation: ConnectionGeneration
  }): Promise<void>
  send(connectionId: string, frame: ClientFrame): Promise<void>
  disconnect(connectionId: string): Promise<void>
}

/** A driver's refusal with a code of its own (e.g. `no_shell` outside the app). */
export class LinkDriverError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = "LinkDriverError"
    this.code = code
  }
}

/**
 * - `idle`: not started.
 * - `dialing`: a link was asked for and is not up yet.
 * - `linked`: the link is up and `hello` is on its way; no `welcome` yet.
 * - `online`: welcomed.
 * - `waiting`: the link dropped; the next dial is scheduled.
 * - `ended`: stopped for good — by the caller, a refusal, a first connection
 *   that never got in, or redials that ran out.
 */
export type ConnectionPhase = "idle" | "dialing" | "linked" | "online" | "waiting" | "ended"

/** Codes for a link the owner itself gave up on (beside the Rust link's own). */
export type OwnerCloseCode = "welcome_timeout" | "ping_timeout" | "send_failed" | "dial_failed"

/** Why the connection ended, when it was not the caller's doing. */
export type ConnectionFailure =
  /** The server (or the session itself) refused for good: a fatal `error`.
   * `message` is the server's own words, in this member's language. */
  | { readonly kind: "refused"; readonly code: string; readonly message: string }
  /** The very first connection never got in. `detail` is English, for logs. */
  | { readonly kind: "link"; readonly code: LinkCloseCode | OwnerCloseCode | string; readonly detail: string }
  /** It was in, dropped, and every redial failed. */
  | { readonly kind: "lost"; readonly code: LinkCloseCode | OwnerCloseCode | string; readonly detail: string }

export interface ConnectionState {
  readonly phase: ConnectionPhase
  /** Redials since the last welcome. */
  readonly attempt: number
  /** Whether any link of this connection was ever welcomed. */
  readonly established: boolean
  readonly failure: ConnectionFailure | null
}

export const IDLE_STATE: ConnectionState = Object.freeze({
  phase: "idle",
  attempt: 0,
  established: false,
  failure: null,
})

/** Redials after a drop before the owner gives up and says so. */
export const DEFAULT_MAX_REDIALS = 10
export const DEFAULT_PING_EVERY_MS = 15_000
export const DEFAULT_PING_TIMEOUT_MS = 10_000
/** How long a link that is up may go without a `welcome` before it is dropped. */
export const DEFAULT_WELCOME_TIMEOUT_MS = 15_000
export const DEFAULT_REDIAL_BASE_MS = 500
export const DEFAULT_REDIAL_MAX_MS = 15_000

export interface ConnectionOptions {
  readonly ticket: string
  readonly key: string
  /** The name to appear under; the key's own name when absent. */
  readonly name?: string
  /** This client's language: results and errors addressed to it are written in it. */
  readonly locale: string
  readonly client: { readonly name: string; readonly version: string }
  readonly network?: NetworkProfile
  readonly driver: LinkDriver
  readonly timers?: Timers
  readonly now?: () => number
  /** Mints one bridge generation per link (`createGeneration` by default). */
  readonly mint?: () => ConnectionGeneration
  readonly pingEveryMs?: number
  readonly pingTimeoutMs?: number
  readonly welcomeTimeoutMs?: number
  readonly redialBaseMs?: number
  readonly redialMaxMs?: number
  readonly maxRedials?: number
  /** Views wanted for the life of the connection: subscribed on every welcome, a resume's
   * included (the session keeps the wanted set and re-subscribes it itself). */
  readonly views?: readonly string[]
  /** Every welcome, a resume's included. */
  readonly onWelcome?: (welcome: WelcomeFrame) => void
  /** The server refused for good. */
  readonly onRefused?: (failure: ConnectionFailure & { kind: "refused" }) => void
}

interface Link {
  readonly id: string
  attachment: ReturnType<Session["attach"]> | null
  /** The tail of this link's send chain: each send starts when it settles. */
  sends: Promise<void>
  /** Given up on (by either side): its events and sends are dead. */
  closed: boolean
}

const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
}

export class Connection {
  readonly session: Session
  readonly ticket: string
  readonly network: NetworkProfile
  readonly #options: ConnectionOptions
  readonly #timers: Timers
  readonly #driver: LinkDriver
  #state: ConnectionState = IDLE_STATE
  readonly #listeners = new Set<() => void>()
  #link: Link | null = null
  #stopped = false
  #lastStatus: string = "idle"
  #redialTimer: unknown = undefined
  #pingTimer: unknown = undefined
  #welcomeTimer: unknown = undefined
  /** How many holders want each view (`want`); a name leaves the session's wanted set with its last. */
  readonly #held = new Map<string, number>()

  constructor(options: ConnectionOptions) {
    this.#options = options
    this.ticket = options.ticket
    this.network = options.network ?? "n0"
    this.#timers = options.timers ?? GLOBAL_TIMERS
    this.#driver = options.driver
    this.session = new Session({
      key: options.key,
      ...(options.name ? { name: options.name } : {}),
      locale: options.locale,
      client: options.client,
      timers: this.#timers,
      ...(options.now ? { now: options.now } : {}),
      // A listener of ours that throws must not take the session down.
      onListenerError: () => undefined,
    })
    this.session.subscribe(this.#onSession)
    // Wanted before the first attach: the session subscribes them on every welcome. The
    // call itself is refused now (`not_connected`) — the names stay wanted all the same.
    // Held for the connection's whole life: nothing releases them.
    if (options.views && options.views.length > 0) this.want(options.views)
  }

  /**
   * Hold `names` subscribed until the returned release is called. Holders are counted per
   * name, so two screens (or a screen and a panel) wanting one view share one subscription
   * and the first to leave does not take it from the other. The session keeps the wanted set
   * and re-subscribes it on every welcome; only the NAMES are held here, never a value.
   */
  want(names: readonly string[]): () => void {
    const unique = [...new Set(names)]
    const added: string[] = []
    for (const name of unique) {
      const count = this.#held.get(name) ?? 0
      this.#held.set(name, count + 1)
      if (count === 0) added.push(name)
    }
    if (added.length > 0) void this.session.viewSubscribe(added).catch(() => undefined)
    let released = false
    return () => {
      if (released) return
      released = true
      const dropped: string[] = []
      for (const name of unique) {
        const count = (this.#held.get(name) ?? 1) - 1
        if (count > 0) this.#held.set(name, count)
        else {
          this.#held.delete(name)
          dropped.push(name)
        }
      }
      if (dropped.length > 0) void this.session.viewUnsubscribe(dropped).catch(() => undefined)
    }
  }

  // --- the owner's own state -------------------------------------------------------------

  getState = (): ConnectionState => this.#state

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #set(patch: Partial<ConnectionState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        // a listener's failure is its own
      }
    }
  }

  // --- the caller's controls -------------------------------------------------------------

  /** The first dial. A first connection that never gets in is not redialled. */
  start(): void {
    if (this.#state.phase !== "idle") return
    this.#dial()
  }

  /** Give up: the link closes, the session ends, nothing is dialled again. A
   * failure that already ended the connection stays on record. */
  stop(): void {
    if (this.#stopped) return
    this.#finish(null)
  }

  /** One event from the bridge. Events of any link but the current one are ignored. */
  handleEvent(event: LinkEvent): void {
    const link = this.#link
    if (link === null || link.closed || event.connectionId !== link.id) return
    if (event.kind === "frame") {
      link.attachment?.receive(event.frame)
      return
    }
    if (event.status === "up") this.#up(link)
    else if (event.status === "closed") this.#lost(link, event.code ?? "connection_lost", event.reason ?? "")
  }

  // --- the link ------------------------------------------------------------------------------

  #dial(): void {
    if (this.#stopped || !this.session.canRedial) return
    const generation = (this.#options.mint ?? createGeneration)()
    const link: Link = {
      id: generation.connectionId,
      attachment: null,
      sends: Promise.resolve(),
      closed: false,
    }
    this.#link = link
    this.#set({ phase: "dialing" })
    this.#driver
      .connect({ ticket: this.ticket, network: this.network, generation })
      .catch((error: unknown) => {
        if (this.#link !== link || link.closed) return
        const code = error instanceof LinkDriverError ? error.code : "dial_failed"
        this.#lost(link, code, error instanceof Error ? error.message : String(error))
      })
  }

  /** The control stream is open: the session says hello on it. */
  #up(link: Link): void {
    if (link.attachment !== null) return
    this.#set({ phase: "linked" })
    try {
      link.attachment = this.session.attach({ send: (frame) => this.#send(link, frame) })
    } catch {
      // The session ended in the meantime; `#onSession` has already stopped us.
      return
    }
    this.#clearWelcomeTimer()
    this.#welcomeTimer = this.#timers.setTimeout(() => {
      this.#welcomeTimer = undefined
      if (this.#link === link && this.session.status === "connecting") this.#drop(link, "welcome_timeout")
    }, this.#options.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS)
  }

  /** Queue one frame behind this link's previous send. */
  #send(link: Link, frame: ClientFrame): void {
    link.sends = link.sends.then(async () => {
      if (link.closed) return
      try {
        await this.#driver.send(link.id, frame)
      } catch (error) {
        if (this.#link === link && !link.closed) {
          this.#drop(link, "send_failed", error instanceof Error ? error.message : String(error))
        }
      }
    })
  }

  /** This side gives up on a link: the bridge is told to close it. */
  #drop(link: Link, code: OwnerCloseCode, detail = ""): void {
    link.closed = true
    if (this.#link === link) this.#link = null
    void this.#driver.disconnect(link.id).catch(() => undefined)
    link.attachment?.closed(code)
    this.#afterLoss(code, detail)
  }

  /** The link went away on its own (the bridge said `closed`, or the dial was refused). */
  #lost(link: Link, code: string, detail: string): void {
    link.closed = true
    if (this.#link === link) this.#link = null
    link.attachment?.closed(detail || code)
    this.#afterLoss(code, detail)
  }

  #afterLoss(code: string, detail: string): void {
    this.#clearPing()
    this.#clearWelcomeTimer()
    // Ended by a refusal (the session is over), or by the caller: nothing to redial.
    if (this.#stopped || !this.session.canRedial) return
    if (!this.#state.established) {
      this.#finish({ kind: "link", code, detail })
      return
    }
    this.#scheduleRedial(code, detail)
  }

  #scheduleRedial(code: string, detail: string): void {
    const attempt = this.#state.attempt
    if (attempt >= (this.#options.maxRedials ?? DEFAULT_MAX_REDIALS)) {
      this.#finish({ kind: "lost", code, detail })
      return
    }
    const base = this.#options.redialBaseMs ?? DEFAULT_REDIAL_BASE_MS
    const max = this.#options.redialMaxMs ?? DEFAULT_REDIAL_MAX_MS
    const delay = Math.min(max, base * 2 ** Math.min(attempt, 16))
    this.#set({ phase: "waiting", attempt: attempt + 1 })
    this.#redialTimer = this.#timers.setTimeout(() => {
      this.#redialTimer = undefined
      this.#dial()
    }, delay)
  }

  /** Stop for good, with the reason (null: the caller asked). */
  #finish(failure: ConnectionFailure | null): void {
    this.#stopped = true
    this.#clearTimers()
    const link = this.#link
    this.#link = null
    if (link !== null) {
      link.closed = true
      void this.#driver.disconnect(link.id).catch(() => undefined)
    }
    this.#set({ phase: "ended", failure: failure ?? this.#state.failure })
    if (this.session.status !== "ended") this.session.end()
  }

  #onSession = (): void => {
    const snapshot = this.session.getSnapshot()
    if (snapshot.status === this.#lastStatus) return
    this.#lastStatus = snapshot.status
    if (snapshot.status === "online") {
      this.#clearWelcomeTimer()
      this.#set({ phase: "online", attempt: 0, established: true, failure: null })
      this.#schedulePing()
      if (snapshot.welcome !== null) this.#options.onWelcome?.(snapshot.welcome)
    } else if (snapshot.status === "ended" && !this.#stopped) {
      const failure = {
        kind: "refused" as const,
        code: snapshot.lastError?.code ?? "ended",
        message: snapshot.lastError?.message ?? "",
      }
      this.#finish(failure)
      this.#options.onRefused?.(failure)
    }
  }

  // --- the client ping ---------------------------------------------------------------------

  #schedulePing(): void {
    this.#clearPing()
    this.#pingTimer = this.#timers.setTimeout(() => {
      this.#pingTimer = undefined
      void this.#ping()
    }, this.#options.pingEveryMs ?? DEFAULT_PING_EVERY_MS)
  }

  async #ping(): Promise<void> {
    const link = this.#link
    if (link === null || this.#stopped || this.session.status !== "online") return
    try {
      await this.session.ping({ timeoutMs: this.#options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS })
      if (this.#link === link && !this.#stopped) this.#schedulePing()
    } catch (error) {
      // No pong in time: the link is dead even if QUIC has not noticed. Drop it and redial.
      if (error instanceof SessionError && error.code === "timeout" && this.#link === link) {
        this.#drop(link, "ping_timeout")
      }
    }
  }

  #clearPing(): void {
    if (this.#pingTimer !== undefined) this.#timers.clearTimeout(this.#pingTimer)
    this.#pingTimer = undefined
  }

  #clearWelcomeTimer(): void {
    if (this.#welcomeTimer !== undefined) this.#timers.clearTimeout(this.#welcomeTimer)
    this.#welcomeTimer = undefined
  }

  #clearTimers(): void {
    this.#clearPing()
    this.#clearWelcomeTimer()
    if (this.#redialTimer !== undefined) this.#timers.clearTimeout(this.#redialTimer)
    this.#redialTimer = undefined
  }
}

/** What the status pill and the connect form show. */
export type DisplayStatus = "offline" | "connecting" | "online" | "reconnecting"

export function displayStatus(state: ConnectionState): DisplayStatus {
  switch (state.phase) {
    case "idle":
    case "ended":
      return "offline"
    case "online":
      return "online"
    case "waiting":
      return "reconnecting"
    case "dialing":
    case "linked":
      return state.established ? "reconnecting" : "connecting"
  }
}
