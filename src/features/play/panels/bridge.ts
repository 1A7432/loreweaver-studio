// The host side of the Tier-2 panel bridge (spec M15, "Tier-2 runtime").
//
// A panel iframe is an OPAQUE origin; the only channel between host and panel
// is postMessage, authenticated by a per-mount 128-bit nonce that the panel
// learns from its host-injected bootstrap (served over the panel's own secret
// token namespace). Inbound the bridge forwards exactly the viewer-filtered
// data this client already received (`state` projections + `panel_event`
// payloads); outbound it accepts only `panel_intent` — what this player could
// have typed — validated and capped before it reaches the wire. There is no
// second data path.

import type {
  CharacterState,
  ClockState,
  InitiativeEntry,
  ModuleVariable,
  PanelIntentFrame,
  PanelIntentKind,
  PartyMember,
  SceneState,
  StateFrame,
  UsageState,
} from "@loreweaver/protocol"
import { visibleVariables } from "./templates"

export const BRIDGE_VERSION = "1"
/** Mirror of the server-side `panel_intent.value` cap. */
export const MAX_INTENT_VALUE_CHARS = 2000
/** Events queued for a panel that has not completed `ready()` yet. */
export const MAX_QUEUED_EVENTS = 32

const INTENT_KINDS: readonly PanelIntentKind[] = ["choice", "input", "roll"]

/**
 * What a panel's `onState` receives: the SAME per-viewer-filtered shapes the
 * protocol `state` frame carries (minus transport bookkeeping like `reset`),
 * with keeper-flagged hidden variables stripped — identical to what tier-1
 * templates may bind.
 */
export interface PanelStateSnapshot {
  variables: ModuleVariable[]
  character?: CharacterState
  party: PartyMember[]
  scene?: SceneState
  clock?: ClockState
  initiative: InitiativeEntry[]
  online: number
  usage?: UsageState
}

export function projectStateForPanel(frame: StateFrame | null): PanelStateSnapshot | null {
  if (!frame) return null
  return {
    variables: visibleVariables(frame.variables ?? []),
    character: frame.character,
    party: frame.party,
    scene: frame.scene,
    clock: frame.clock,
    initiative: frame.initiative,
    online: frame.online,
    usage: frame.usage,
  }
}

/** 32 lowercase hex chars (128 bits) — used for serve tokens and bridge nonces. */
export function mintSecret(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

interface BridgeEnvelope {
  lw: string
  nonce: string
  type: string
  kind?: unknown
  value?: unknown
}

function parseEnvelope(data: unknown): BridgeEnvelope | null {
  if (typeof data !== "object" || data === null) return null
  const env = data as Record<string, unknown>
  if (env.lw !== BRIDGE_VERSION) return null
  if (typeof env.nonce !== "string" || typeof env.type !== "string") return null
  return env as unknown as BridgeEnvelope
}

export interface PanelBridgeOptions {
  panelId: string
  nonce: string
  locale: string
  theme: Record<string, string>
  /** The authenticated peer: the mounted iframe's contentWindow. */
  getSource: () => unknown
  postToPanel: (message: Record<string, unknown>) => void
  sendIntent: (frame: PanelIntentFrame) => void
  getSnapshot: () => PanelStateSnapshot | null
}

export class PanelBridge {
  private ready = false
  private queuedEvents: unknown[] = []

  constructor(private readonly opts: PanelBridgeOptions) {}

  isReady(): boolean {
    return this.ready
  }

  private post(message: Record<string, unknown>): void {
    this.opts.postToPanel({ lw: BRIDGE_VERSION, nonce: this.opts.nonce, ...message })
  }

  /**
   * Window `message` listener. Every message must carry the panel's nonce AND
   * originate from the mounted iframe's own window — a message from anywhere
   * else (other panels, the app itself, a devtools console) is dropped.
   */
  handleMessage(event: MessageEvent): void {
    const envelope = parseEnvelope(event.data)
    if (!envelope || envelope.nonce !== this.opts.nonce) return
    const source = this.opts.getSource()
    if (!source || event.source !== source) return

    if (envelope.type === "ready") {
      this.ready = true
      this.post({
        type: "ready_ack",
        panel: this.opts.panelId,
        locale: this.opts.locale,
        theme: this.opts.theme,
      })
      const snapshot = this.opts.getSnapshot()
      if (snapshot) this.post({ type: "state", state: snapshot })
      for (const payload of this.queuedEvents.splice(0)) {
        this.post({ type: "event", payload })
      }
      return
    }
    if (envelope.type === "intent") {
      const kind = envelope.kind
      const value = envelope.value
      if (!INTENT_KINDS.includes(kind as PanelIntentKind)) return
      if (typeof value !== "string" || value.length === 0) return
      if (value.length > MAX_INTENT_VALUE_CHARS) return
      this.opts.sendIntent({
        type: "panel_intent",
        panel: this.opts.panelId,
        kind: kind as PanelIntentKind,
        value,
      })
    }
  }

  /** Push a fresh state projection (no-op until the panel said ready). */
  pushState(snapshot: PanelStateSnapshot | null): void {
    if (!this.ready || !snapshot) return
    this.post({ type: "state", state: snapshot })
  }

  /** Forward one `panel_event` payload, queueing (bounded) before ready. */
  pushEvent(payload: unknown): void {
    if (this.ready) {
      this.post({ type: "event", payload })
      return
    }
    this.queuedEvents.push(payload)
    if (this.queuedEvents.length > MAX_QUEUED_EVENTS) this.queuedEvents.shift()
  }
}

// ---- Host-injected panel assets -------------------------------------------

/** App CSS custom properties re-exported to panels under a stable --lw-* contract. */
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
    if (value) theme[panelVar] = value
  }
  return theme
}

/** The `__loreweaver__/theme.css` body: app theme as CSS custom properties. */
export function buildThemeCss(theme: Record<string, string>): string {
  const lines = Object.entries(theme).map(([name, value]) => `  ${name}: ${value};`)
  return `:root {\n${lines.join("\n")}\n}\n`
}

/**
 * The `__loreweaver__/bootstrap.js` body: defines `window.loreweaver` (bridge
 * contract v1 — ready/onState/onEvent/send) with the mount's nonce baked in.
 * Runs before any author script (injected first in head), frameworks-agnostic,
 * ES5-safe.
 */
export function buildBootstrapJs(nonce: string, panelId: string, parentOrigin: string): string {
  const NONCE = JSON.stringify(nonce)
  const PANEL = JSON.stringify(panelId)
  const PARENT = JSON.stringify(parentOrigin)
  return `// Loreweaver panel bridge bootstrap (host-injected; contract v1).
(function () {
  "use strict";
  var NONCE = ${NONCE};
  var PANEL = ${PANEL};
  var PARENT = ${PARENT};
  var stateCbs = [];
  var eventCbs = [];
  var lastState;
  var hasState = false;
  var pendingEvents = [];
  var readyResolve;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });
  var announced = false;

  function post(message) {
    message.lw = "${BRIDGE_VERSION}";
    message.nonce = NONCE;
    window.parent.postMessage(message, PARENT || "*");
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.lw !== "${BRIDGE_VERSION}" || data.nonce !== NONCE) return;
    if (event.source !== window.parent) return;
    if (data.type === "ready_ack") {
      readyResolve({ panel: data.panel, locale: data.locale, theme: data.theme });
      return;
    }
    if (data.type === "state") {
      lastState = data.state;
      hasState = true;
      for (var i = 0; i < stateCbs.length; i++) {
        try { stateCbs[i](data.state); } catch (err) { /* author callback */ }
      }
      return;
    }
    if (data.type === "event") {
      if (eventCbs.length === 0) {
        pendingEvents.push(data.payload);
        if (pendingEvents.length > ${MAX_QUEUED_EVENTS}) pendingEvents.shift();
        return;
      }
      for (var j = 0; j < eventCbs.length; j++) {
        try { eventCbs[j](data.payload); } catch (err) { /* author callback */ }
      }
    }
  });

  window.loreweaver = {
    version: "${BRIDGE_VERSION}",
    ready: function () {
      if (!announced) { announced = true; post({ type: "ready", panel: PANEL }); }
      return readyPromise;
    },
    onState: function (cb) {
      stateCbs.push(cb);
      if (hasState) { try { cb(lastState); } catch (err) { /* author callback */ } }
    },
    onEvent: function (cb) {
      eventCbs.push(cb);
      var backlog = pendingEvents.splice(0, pendingEvents.length);
      for (var i = 0; i < backlog.length; i++) {
        try { cb(backlog[i]); } catch (err) { /* author callback */ }
      }
    },
    send: function (kind, value) {
      post({ type: "intent", kind: String(kind), value: String(value) });
    },
  };
})();
`
}
