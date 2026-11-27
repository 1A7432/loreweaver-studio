// The page bridge, version 2: how a page panel (LWF panels §7) talks to this client. The
// reference is `docs/PAGE-BRIDGE.md`; the page-side object is `window.loreweaver`, defined by
// the bootstrap below, which the `panel://` scheme splices into the page's `<head>`.
//
// A page runs in a frame with an OPAQUE origin (`sandbox="allow-scripts"`), so the only
// channel between it and the host is `postMessage`. Every message carries the mount's nonce
// (128 bits, minted per mount, known only to the bootstrap served under the mount's secret
// token) and the host accepts a message only from the mounted frame's own window.
//
// What crosses, and nothing else:
// - in: the values of the views the panel declared, keyed by the panel's handles, exactly as
//   this member's session holds them (minus list elements flagged `hidden`, which a panel
//   never shows — LWF panels §4.2); the room's log events that arrive after the page is ready;
// - out: `command.run`, as this member, through the connection owner — after the host has
//   checked the `commands` view, asked the person for a `danger` command, and applied a
//   per-page rate limit and size caps.

import type { EventFrame, PanelEntry, Result, Role, ViewCommand } from "loreweaver-protocol/v3"

export const BRIDGE_VERSION = "2"
/** The 2.x bridge's version: a page that speaks it gets its fallback. */
export const LEGACY_BRIDGE_VERSION = "1"

/** A message from a page larger than this (as JSON, in bytes) is dropped. */
export const MAX_PAGE_MESSAGE_BYTES = 64 * 1024
/** The `args` of one `run`, as JSON, in bytes. */
export const MAX_RUN_ARGS_BYTES = 16 * 1024
/** A command id, in code points (the protocol's own cap, §12.4). */
export const MAX_COMMAND_ID_CHARS = 200
/** Per page: at most this many `run`s at once, then one more every {@link PAGE_RUN_REFILL_MS}. */
export const PAGE_RUN_BURST = 4
export const PAGE_RUN_REFILL_MS = 2500
/** Events a page receives before it registered an `onEvent` callback are queued, up to this. */
export const MAX_QUEUED_EVENTS = 32
/** A page's crash report is one line; anything longer is cut here. */
export const MAX_PANEL_ERROR_CHARS = 200
/** How long a page gets to call `ready()` before the host shows its fallback. */
export const HANDSHAKE_TIMEOUT_MS = 6000

/** The refusals the host answers a `run` with itself, before anything reaches the room. */
export const LOCAL_REFUSALS = [
  "invalid_params",
  "too_large",
  "rate_limited",
  "unavailable",
  "cancelled",
  "busy",
  "not_ready",
  "not_sent",
] as const
export type LocalRefusal = (typeof LOCAL_REFUSALS)[number]

export interface PageMember {
  name: string
  role: Role
}

/** What `ready()` resolves with on the page. */
export interface PageReadyInfo {
  panel: { id: string; title: string }
  locale: string
  theme: string
  member: PageMember
}

/** One log event as a page receives it: the protocol's envelope without `type`. */
export interface PageEvent {
  seq: number
  id: string
  ts: number
  kind: string
  turn?: number
  data: unknown
}

export type PageRunResult =
  { ok: true; text?: string; data?: unknown } | { ok: false; code: string; message: string; reason?: string }

/** 32 lowercase hex chars (128 bits) — serve tokens and bridge nonces. */
export function mintSecret(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `value` without any list element flagged `hidden: true`, at any depth (LWF panels §4.2). */
export function withoutHidden(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !(isRecord(item) && item.hidden === true)).map(withoutHidden)
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = withoutHidden(item)
    return out
  }
  return value
}

/**
 * The views a page receives: each handle its panel declared → that view's value as this
 * member's session holds it (null: not held yet, or the room has no such view), with hidden
 * list elements removed. Nothing else of the snapshot.
 */
export function pageViews(
  panel: Pick<PanelEntry, "views">,
  held: ReadonlyMap<string, { readonly data: unknown }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const ref of panel.views) {
    if (!isRecord(ref) || typeof ref.as !== "string" || typeof ref.view !== "string") continue
    const value = held.get(ref.view)
    out[ref.as] = value === undefined ? null : withoutHidden(value.data)
  }
  return out
}

/** The size of `value` as JSON, in bytes; null when it is not JSON at all. */
export function jsonBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : new TextEncoder().encode(text).length
  } catch {
    return null
  }
}

function toPageEvent(event: EventFrame): PageEvent {
  return {
    seq: event.seq,
    id: event.id,
    ts: event.ts,
    kind: event.kind,
    ...(event.turn === undefined ? {} : { turn: event.turn }),
    data: event.data,
  }
}

function newestSeq(events: readonly EventFrame[], head: number): number {
  let newest = head
  for (const event of events) if (event.seq > newest) newest = event.seq
  return newest
}

export interface PageBridgeOptions {
  panel: { id: string; title: string }
  nonce: string
  locale: string
  theme: string
  /** The authenticated peer: the mounted frame's `contentWindow`. */
  getSource: () => unknown
  /** Post to the frame (target `"*"`: an opaque origin matches no other). */
  post: (message: Record<string, unknown>) => void
  /** Who is viewing: the welcome's member. */
  member: () => PageMember | null
  /** The page's views now ({@link pageViews}). */
  views: () => Record<string, unknown>
  /** The session's log window and head. */
  log: () => { events: readonly EventFrame[]; head: number }
  /** The `commands` view's list; null while it is not held. */
  commands: () => readonly ViewCommand[] | null
  /** `command.run` as this member, through the connection owner. */
  run: (id: string, args: Record<string, unknown>) => Promise<Result>
  /** The host's own confirmation for a `danger` command; `signal` aborts when the page goes. */
  confirm: (command: ViewCommand, signal: AbortSignal) => Promise<boolean>
  /** A local refusal's message, in the member's language. */
  refusalText: (code: LocalRefusal, params: Record<string, string>) => string
  now?: () => number
  /** The page called `ready()`: it loaded, and its script runs. */
  onReady?: () => void
  /** The page's bootstrap caught an uncaught error (first one only). */
  onPanelError?: (message: string) => void
  /** The page speaks the 2.x bridge. */
  onLegacy?: () => void
  /** A dropped message, for the console. */
  warn?: (text: string) => void
}

/** The host side of one mounted page. */
export class PageBridge {
  readonly #opts: PageBridgeOptions
  #ready = false
  #disposed = false
  #legacy = false
  /** The newest log `seq` the page has been handed (or that existed when it became ready). */
  #cursor = 0
  #lastViews: Record<string, unknown> | null = null
  #tokens = PAGE_RUN_BURST
  #refilledAt: number
  #confirming = false
  readonly #abort = new AbortController()

  constructor(options: PageBridgeOptions) {
    this.#opts = options
    this.#refilledAt = this.#now()
  }

  isReady(): boolean {
    return this.#ready
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)()
  }

  #post(message: Record<string, unknown>): void {
    if (this.#disposed) return
    this.#opts.post({ lw: BRIDGE_VERSION, nonce: this.#opts.nonce, ...message })
  }

  /** The window `message` listener. */
  handleMessage(event: MessageEvent): void {
    if (this.#disposed) return
    const source = this.#opts.getSource()
    if (!source || event.source !== source) return
    const data: unknown = event.data
    if (!isRecord(data) || data.nonce !== this.#opts.nonce) return
    const size = jsonBytes(data)
    if (size === null || size > MAX_PAGE_MESSAGE_BYTES) {
      this.#opts.warn?.(
        `panel ${this.#opts.panel.id}: a message of ${size ?? "?"} bytes was dropped (the cap is ${MAX_PAGE_MESSAGE_BYTES})`,
      )
      return
    }
    if (data.lw === LEGACY_BRIDGE_VERSION) {
      if (!this.#legacy) {
        this.#legacy = true
        this.#opts.onLegacy?.()
      }
      return
    }
    if (data.lw !== BRIDGE_VERSION) return
    switch (data.type) {
      case "ready":
        this.#onReady()
        return
      case "panel_error": {
        const message = typeof data.message === "string" ? data.message : ""
        this.#opts.onPanelError?.(message.slice(0, MAX_PANEL_ERROR_CHARS))
        return
      }
      case "run":
        void this.#onRun(data)
        return
    }
  }

  #onReady(): void {
    if (this.#ready || this.#legacy) return
    const member = this.#opts.member()
    if (member === null) return
    this.#ready = true
    const { events, head } = this.#opts.log()
    this.#cursor = newestSeq(events, head)
    this.#lastViews = this.#opts.views()
    const info: PageReadyInfo = {
      panel: this.#opts.panel,
      locale: this.#opts.locale,
      theme: this.#opts.theme,
      member,
    }
    this.#post({ type: "ready_ack", ...info, views: this.#lastViews })
    this.#opts.onReady?.()
  }

  /** The views may have changed: post them if they did (and the page is ready). */
  syncViews(): void {
    if (!this.#ready || this.#disposed) return
    const next = this.#opts.views()
    const last = this.#lastViews ?? {}
    const keys = new Set([...Object.keys(last), ...Object.keys(next)])
    let changed = false
    for (const key of keys) {
      if (JSON.stringify(last[key]) !== JSON.stringify(next[key])) changed = true
    }
    if (!changed) return
    this.#lastViews = next
    this.#post({ type: "views", views: next })
  }

  /** The log may have grown: hand the page every event newer than the last it got. */
  syncEvents(): void {
    if (!this.#ready || this.#disposed) return
    const { events } = this.#opts.log()
    for (const event of events) {
      if (event.seq <= this.#cursor) continue
      this.#cursor = event.seq
      this.#post({ type: "event", event: toPageEvent(event) })
    }
  }

  #take(): boolean {
    const now = this.#now()
    const refills = Math.floor((now - this.#refilledAt) / PAGE_RUN_REFILL_MS)
    if (refills > 0) {
      this.#tokens = Math.min(PAGE_RUN_BURST, this.#tokens + refills)
      this.#refilledAt += refills * PAGE_RUN_REFILL_MS
    }
    if (this.#tokens <= 0) return false
    if (this.#tokens === PAGE_RUN_BURST) this.#refilledAt = now
    this.#tokens -= 1
    return true
  }

  #refuse(code: LocalRefusal, params: Record<string, string> = {}, reason?: string): PageRunResult {
    return {
      ok: false,
      code,
      message: this.#opts.refusalText(code, params),
      ...(reason === undefined ? {} : { reason }),
    }
  }

  async #onRun(data: Record<string, unknown>): Promise<void> {
    const call = data.call
    if (typeof call !== "number" || !Number.isSafeInteger(call)) return
    const result = await this.#decide(data)
    if (this.#disposed) return
    this.#post({ type: "run_result", call, result })
  }

  async #decide(data: Record<string, unknown>): Promise<PageRunResult> {
    if (!this.#ready) return this.#refuse("not_ready")
    const command = data.command
    const args = data.args === undefined ? {} : data.args
    if (
      typeof command !== "string" ||
      command.length === 0 ||
      [...command].length > MAX_COMMAND_ID_CHARS ||
      !isRecord(args)
    ) {
      return this.#refuse("invalid_params")
    }
    const size = jsonBytes(args)
    if (size === null) return this.#refuse("invalid_params")
    if (size > MAX_RUN_ARGS_BYTES) return this.#refuse("too_large", { max: String(MAX_RUN_ARGS_BYTES) })
    if (!this.#take()) return this.#refuse("rate_limited")

    const entry = this.#opts.commands()?.find((candidate) => candidate.id === command)
    if (entry === undefined) return this.#refuse("unavailable", { command, reason: "unknown" }, "unknown")
    if (!entry.available) {
      const reason = entry.reason ?? "unavailable"
      return this.#refuse("unavailable", { command, reason }, reason)
    }
    if (entry.danger === true) {
      if (this.#confirming) return this.#refuse("busy")
      this.#confirming = true
      const agreed = await this.#opts.confirm(entry, this.#abort.signal).then(
        (answer) => answer,
        () => false,
      )
      this.#confirming = false
      if (!agreed || this.#disposed) return this.#refuse("cancelled")
    }

    try {
      const outcome = await this.#opts.run(
        command,
        JSON.parse(JSON.stringify(args)) as Record<string, unknown>,
      )
      if (!outcome.ok) return { ok: false, code: outcome.error.code, message: outcome.error.message }
      return {
        ok: true,
        ...(outcome.text === undefined ? {} : { text: outcome.text }),
        ...(outcome.data === undefined ? {} : { data: outcome.data }),
      }
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failed"
      return this.#refuse("not_sent", { code })
    }
  }

  /** The page is unmounted: nothing more is posted, and an open confirmation is withdrawn. */
  dispose(): void {
    this.#disposed = true
    this.#abort.abort()
  }
}

// ---- Host-injected page head ----------------------------------------------------------

/** App CSS custom properties re-exported to pages under a stable --lw-* contract. */
const THEME_VARS: ReadonlyArray<readonly [string, string]> = [
  ["--bg", "--lw-bg"],
  ["--bg-raised", "--lw-bg-raised"],
  ["--bg-inset", "--lw-bg-inset"],
  ["--border", "--lw-border"],
  ["--border-soft", "--lw-border-soft"],
  ["--ink", "--lw-ink"],
  ["--ink-dim", "--lw-ink-dim"],
  ["--ink-faint", "--lw-ink-faint"],
  ["--accent", "--lw-accent"],
  ["--accent-strong", "--lw-accent-strong"],
  ["--accent-ink", "--lw-accent-ink"],
  ["--danger", "--lw-danger"],
  ["--warn", "--lw-warn"],
  ["--ok", "--lw-ok"],
  ["--font-ui", "--lw-font-ui"],
  ["--font-story", "--lw-font-story"],
  ["--font-mono", "--lw-font-mono"],
]

export function collectPanelTheme(): Record<string, string> {
  if (typeof document === "undefined") return {}
  const styles = getComputedStyle(document.documentElement)
  const theme: Record<string, string> = {}
  for (const [appVar, panelVar] of THEME_VARS) {
    const value = styles.getPropertyValue(appVar).trim()
    // Spliced into a <style> element: a value that could close it is left out.
    if (value && !value.includes("<")) theme[panelVar] = value
  }
  return theme
}

/** The theme variables as one `:root` rule (the scheme puts it in a `<style>` element). */
export function buildThemeCss(theme: Record<string, string>): string {
  const lines = Object.entries(theme).map(([name, value]) => `  ${name}: ${value};`)
  return `:root {\n${lines.join("\n")}\n}\n`
}

/**
 * The bootstrap the scheme splices into the page's `<head>` as an inline script: it defines
 * `window.loreweaver` (bridge version 2) with the mount's nonce baked in, before any author
 * script runs. ES5, no dependencies. Only the nonce (hex) is interpolated: the panel's id and
 * title reach the page in the `ready` answer, never inside this script.
 */
export function buildBootstrapJs(nonce: string): string {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("bad nonce")
  return `// Loreweaver page bridge (host-injected, version ${BRIDGE_VERSION}; docs/PAGE-BRIDGE.md).
(function () {
  "use strict";
  var NONCE = "${nonce}";
  var VERSION = "${BRIDGE_VERSION}";
  var HOST = window.parent;
  var views = {};
  var isReady = false;
  var announced = false;
  var viewCbs = [];
  var eventCbs = [];
  var queued = [];
  var calls = {};
  var nextCall = 1;
  var readyResolve;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

  function post(message, version) {
    message.lw = version || VERSION;
    message.nonce = NONCE;
    // An opaque origin matches no target origin: "*" is the only one that delivers.
    HOST.postMessage(message, "*");
  }
  function copyViews() {
    var out = {};
    for (var key in views) if (Object.prototype.hasOwnProperty.call(views, key)) out[key] = views[key];
    return out;
  }
  function call(cb, value) {
    try { cb(value); } catch (err) { setTimeout(function () { throw err; }, 0); }
  }
  function remover(list, cb) {
    return function () {
      var at = list.indexOf(cb);
      if (at >= 0) list.splice(at, 1);
    };
  }

  // A page that throws before ready() would otherwise be a blank box until the host's
  // deadline. Report the FIRST failure only, as one line.
  var crashed = false;
  function reportCrash(text) {
    if (crashed) return;
    crashed = true;
    try {
      post({ type: "panel_error", message: String(text).replace(/\\s+/g, " ").slice(0, ${MAX_PANEL_ERROR_CHARS}) });
    } catch (err) { /* the host is gone */ }
  }
  window.addEventListener("error", function (event) {
    reportCrash((event && event.message) || (event && event.error && event.error.message) || "uncaught error");
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    reportCrash((reason && reason.message) || reason || "unhandled rejection");
  });

  window.addEventListener("message", function (event) {
    if (event.source !== HOST) return;
    var data = event.data;
    if (!data || data.lw !== VERSION || data.nonce !== NONCE) return;
    var i;
    if (data.type === "ready_ack") {
      if (isReady) return;
      isReady = true;
      views = data.views || {};
      readyResolve({ panel: data.panel, locale: data.locale, theme: data.theme, member: data.member });
      var first = viewCbs.slice();
      for (i = 0; i < first.length; i++) call(first[i], copyViews());
    } else if (data.type === "views") {
      views = data.views || {};
      var listeners = viewCbs.slice();
      for (i = 0; i < listeners.length; i++) call(listeners[i], copyViews());
    } else if (data.type === "event") {
      if (eventCbs.length === 0) {
        queued.push(data.event);
        if (queued.length > ${MAX_QUEUED_EVENTS}) queued.shift();
        return;
      }
      var hearers = eventCbs.slice();
      for (i = 0; i < hearers.length; i++) call(hearers[i], data.event);
    } else if (data.type === "run_result") {
      var resolve = calls[data.call];
      if (!resolve) return;
      delete calls[data.call];
      resolve(data.result);
    }
  });

  // The 2.x bridge's methods: a page written for them is told it needs a newer client.
  function legacy() {
    try { post({ type: "legacy" }, "1"); } catch (err) { /* the host is gone */ }
  }

  var api = {
    version: VERSION,
    ready: function () {
      if (!announced) { announced = true; post({ type: "ready" }); }
      return readyPromise;
    },
    views: function () { return copyViews(); },
    onViews: function (cb) {
      viewCbs.push(cb);
      if (isReady) call(cb, copyViews());
      return remover(viewCbs, cb);
    },
    onEvent: function (cb) {
      eventCbs.push(cb);
      var backlog = queued.splice(0, queued.length);
      for (var i = 0; i < backlog.length; i++) call(cb, backlog[i]);
      return remover(eventCbs, cb);
    },
    run: function (command, args) {
      return new Promise(function (resolve) {
        var id = nextCall++;
        calls[id] = resolve;
        try {
          post({ type: "run", call: id, command: command, args: args === undefined ? {} : args });
        } catch (err) {
          delete calls[id];
          resolve({ ok: false, code: "invalid_params", message: String((err && err.message) || err) });
        }
      });
    },
    onState: legacy,
    send: legacy
  };
  Object.defineProperty(window, "loreweaver", { value: Object.freeze(api), enumerable: true });
})();
`
}
