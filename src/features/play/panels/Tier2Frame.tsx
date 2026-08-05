// The Tier-2 iframe host (spec M15, "Tier-2 runtime").
//
// Isolation, in layers:
//  1. `sandbox="allow-scripts"` and NOTHING else — the document runs in an
//     opaque origin: no same-origin access, no popups, no top navigation,
//     no forms, no pointer lock, no downloads.
//  2. Its own CSP (attached by the `panel://` handler on every response):
//     `default-src 'none'`, sub-resources only from the panel's secret token
//     namespace, and NO connect-src — a panel holds room state, so the
//     network is structurally unreachable.
//  3. The parent CSP's `frame-src` pins where the iframe itself may navigate.
//  4. postMessage is nonce-authenticated per mount, and the bridge forwards
//     only viewer-filtered data in and player-typeable intents out.
//
// Mount order matters: bridge listener → assets ensured (hash-verified pull)
// → serve registration → THEN the iframe gets its src.

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { UiManifestPanel } from "@loreweaver/protocol"
import { transportSend } from "../../../lib/transport"
import { useSessionStore } from "../../../store/session"
import { subscribePanelEvents } from "../../../store/panels"
import { ensurePanelAssets, panelEntryUrl, panelServeRegister, panelServeUnregister } from "./assets"
import {
  buildBootstrapJs,
  buildThemeCss,
  collectPanelTheme,
  mintSecret,
  PanelBridge,
  projectStateForPanel,
} from "./bridge"
import { pickText } from "./templates"
import PanelFallback from "./PanelFallback"

// "serving" = assets are served and the iframe has its src, but the panel has
// not completed the bridge handshake yet; "live" = it did. A panel that never
// speaks (document blocked, script threw at load) would otherwise sit as a
// silent blank box, so the host falls back to its declared blocks instead.
type Phase = "loading" | "serving" | "live" | "stalled" | "error"

/** How long a panel gets to say `ready` before the host assumes it is dead. */
const HANDSHAKE_TIMEOUT_MS = 6000

export default function Tier2Frame({ panel }: { panel: UiManifestPanel }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? "en"
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [phase, setPhase] = useState<Phase>("loading")
  const [src, setSrc] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    const token = mintSecret()
    const nonce = mintSecret()
    const theme = collectPanelTheme()
    const bridge = new PanelBridge({
      onReady: () => {
        if (cancelled) return
        clearTimeout(handshakeTimer)
        setPhase("live")
      },
      panelId: panel.id,
      nonce,
      locale,
      theme,
      getSource: () => iframeRef.current?.contentWindow ?? null,
      // The target origin must be "*": an opaque origin can never match a
      // concrete one. The recipient is still pinned — we post to the mounted
      // iframe's own window, and the payload is this viewer's data anyway.
      postToPanel: (message) => iframeRef.current?.contentWindow?.postMessage(message, "*"),
      sendIntent: (frame) => void transportSend(frame).catch(() => {}),
      getSnapshot: () => projectStateForPanel(useSessionStore.getState().game),
    })
    const onMessage = (event: MessageEvent) => bridge.handleMessage(event)
    window.addEventListener("message", onMessage)
    const unsubscribeState = useSessionStore.subscribe((state, previous) => {
      if (state.game !== previous.game) bridge.pushState(projectStateForPanel(state.game))
    })
    const unsubscribeEvents = subscribePanelEvents(panel.id, (payload) => bridge.pushEvent(payload))

    setPhase("loading")
    setSrc(null)
    void (async () => {
      try {
        await ensurePanelAssets(panel)
        if (cancelled) return
        await panelServeRegister({
          token,
          entryHash: panel.entry?.hash ?? "",
          assets: (panel.assets ?? []).map(({ path, hash, mime }) => ({ path, hash, mime })),
          bootstrapJs: buildBootstrapJs(nonce, panel.id, window.location.origin),
          themeCss: buildThemeCss(theme),
        })
        if (cancelled) {
          void panelServeUnregister(token).catch(() => {})
          return
        }
        setSrc(panelEntryUrl(token))
        setPhase("serving")
        handshakeTimer = setTimeout(() => {
          if (!cancelled && !bridge.isReady()) setPhase("stalled")
        }, HANDSHAKE_TIMEOUT_MS)
      } catch {
        if (!cancelled) setPhase("error")
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(handshakeTimer)
      window.removeEventListener("message", onMessage)
      unsubscribeState()
      unsubscribeEvents()
      void panelServeUnregister(token).catch(() => {})
    }
    // A locale switch re-mounts the panel so its bootstrap answer stays true.
  }, [panel, locale, attempt])

  if (phase === "error") {
    return (
      <div className="panel-frame-error">
        <p className="panel-frame-error-line" role="alert">
          {t("panels.assetError")}
          <button type="button" className="ghost-button" onClick={() => setAttempt((n) => n + 1)}>
            {t("panels.retry")}
          </button>
        </p>
        <PanelFallback panel={panel} />
      </div>
    )
  }
  return (
    <>
      {phase === "loading" || phase === "serving" ? (
        <p className="panel-frame-loading">{t("panels.loading")}</p>
      ) : null}
      {phase === "stalled" ? (
        <p className="panel-frame-error-line" role="alert">
          {t("panels.stalled")}
          <button type="button" className="ghost-button" onClick={() => setAttempt((n) => n + 1)}>
            {t("panels.retry")}
          </button>
        </p>
      ) : null}
      {src ? (
        <iframe
          ref={iframeRef}
          className={phase === "stalled" ? "panel-frame stalled" : "panel-frame"}
          src={src}
          // Exactly allow-scripts: adding allow-same-origin would collapse
          // the opaque origin and with it the whole isolation story.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={pickText(panel.title, locale) ?? panel.id}
        />
      ) : null}
      {/* A stalled panel still owes the player its content: render the same
          blocks every other client sees, and let a late handshake win. */}
      {phase === "stalled" ? <PanelFallback panel={panel} /> : null}
    </>
  )
}
