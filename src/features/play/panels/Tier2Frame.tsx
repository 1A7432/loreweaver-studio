// A page panel, running (LWF panels §7 "Pages"; the bridge is `docs/PAGE-BRIDGE.md`).
//
// Isolation, in layers:
//  1. `sandbox="allow-scripts"` and NOTHING else — the page runs in an opaque origin: no
//     same-origin access, no popups, no top navigation, no forms, no downloads, no modals.
//  2. Its own CSP, attached by the `panel://` handler (`panel_serve.rs` `PAGE_CSP`): inline
//     scripts, styles and `data:`/`blob:` media only, and no network at all.
//  3. This app's CSP `frame-src` pins where the frame itself may navigate (`panel:` only on
//     macOS and Linux, `http://panel.localhost` only on Windows).
//  4. The bridge (`bridge.ts`): nonce- and sender-checked messages; the page gets its
//     declared views and the new log events, and acts only through `command.run`.
//
// Mount order: bridge listener → the page's bytes pulled by hash into the verified cache →
// the scheme registration → THEN the frame gets its `src`. Until the page says `ready()`,
// and whenever it cannot run, the panel shows its fallback.

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { builtInView, panelViewNames, stripControlChars } from "loreweaver-protocol/v3"
import type { PanelEntry, ViewCommand } from "loreweaver-protocol/v3"
import { isTauri } from "../../../lib/transport"
import { useAppStore } from "../../../store/app"
import { useConnection } from "../../../store/connection"
import { useViews } from "../room"
import { ensurePage, panelEntryUrl, panelServeRegister, panelServeUnregister } from "./assets"
import {
  buildBootstrapJs,
  buildThemeCss,
  collectPanelTheme,
  HANDSHAKE_TIMEOUT_MS,
  mintSecret,
  PageBridge,
  pageViews,
} from "./bridge"
import { panelTitle } from "./panelList"
import Tier1Blocks from "./Tier1Blocks"

// "serving" = the frame has its src, the page has not said ready yet; "live" = it did.
// "stalled" = it never did in time, or it crashed first; "legacy" = it speaks bridge 1.
type Phase = "loading" | "serving" | "live" | "stalled" | "legacy" | "error"

interface Confirmation {
  command: ViewCommand
  answer: (agreed: boolean) => void
}

/** The theme as a page reads it: light or dark. */
function themeKind(theme: string): string {
  return theme === "paperwhite" ? "light" : "dark"
}

export default function Tier2Frame({ panel }: { panel: PanelEntry }) {
  const { t, i18n } = useTranslation()
  const locale = i18n.resolvedLanguage ?? "en"
  const theme = themeKind(useAppStore((s) => s.theme))
  const connection = useConnection()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const panelRef = useRef(panel)
  const [phase, setPhase] = useState<Phase>("loading")
  const [src, setSrc] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [crash, setCrash] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const hash = panel.page?.hash ?? null
  const runnable = hash !== null && connection !== null && isTauri()
  const title = panelTitle(panel)

  useEffect(() => {
    panelRef.current = panel
  }, [panel])

  // The page's views stay subscribed while it is mounted (the counted hold).
  useViews(runnable ? panelViewNames(panel) : [])

  useEffect(() => {
    if (!runnable || hash === null || connection === null) return
    const session = connection.session
    let cancelled = false
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    const token = mintSecret()
    const nonce = mintSecret()
    const themeVars = collectPanelTheme()
    const bridge = new PageBridge({
      panel: { id: panelRef.current.id, title: panelTitle(panelRef.current) },
      nonce,
      locale,
      theme,
      getSource: () => frameRef.current?.contentWindow ?? null,
      // An opaque origin matches no concrete target origin, so "*" is the only target that
      // delivers. The recipient is still pinned: the mounted frame's own window, which only
      // ever holds this page (its navigation is pinned by the app's frame-src), and what is
      // posted is this member's own view data anyway.
      post: (message) => frameRef.current?.contentWindow?.postMessage(message, "*"),
      member: () => {
        const you = session.getSnapshot().welcome?.you
        return you ? { name: you.name, role: you.role } : null
      },
      views: () => pageViews(panelRef.current, session.getSnapshot().views),
      log: () => {
        const snapshot = session.getSnapshot()
        return { events: snapshot.events, head: snapshot.head }
      },
      commands: () => builtInView(session.getSnapshot(), "commands")?.data.commands ?? null,
      run: (id, args) => session.runCommand(id, args),
      confirm: (command, signal) =>
        new Promise<boolean>((resolve) => {
          const answer = (agreed: boolean) => {
            signal.removeEventListener("abort", onAbort)
            if (!cancelled) setConfirmation(null)
            resolve(agreed)
          }
          const onAbort = () => answer(false)
          signal.addEventListener("abort", onAbort)
          setConfirmation({ command, answer })
        }),
      refusalText: (code, params) => t(`panels.page.refused.${code}`, params),
      onReady: () => {
        if (cancelled) return
        clearTimeout(handshakeTimer)
        setPhase("live")
      },
      // A crash before the handshake IS the stalled verdict, arriving early. After ready
      // the page owns its own recovery: one bad render must not yank a working panel.
      onPanelError: (message) => {
        if (cancelled) return
        if (bridge.isReady()) {
          console.warn(`panel ${panelRef.current.id}: ${message}`)
          return
        }
        clearTimeout(handshakeTimer)
        setCrash(message)
        setPhase("stalled")
      },
      onLegacy: () => {
        if (cancelled) return
        clearTimeout(handshakeTimer)
        setPhase("legacy")
      },
      warn: (text) => console.warn(text),
    })
    const onMessage = (event: MessageEvent) => bridge.handleMessage(event)
    window.addEventListener("message", onMessage)
    // The session replaces its views map and its event list when they change (and only
    // then), so a draft streaming in costs the page nothing.
    let seenViews = session.getSnapshot().views
    let seenEvents = session.getSnapshot().events
    const unsubscribe = session.subscribe(() => {
      const snapshot = session.getSnapshot()
      if (snapshot.views !== seenViews) {
        seenViews = snapshot.views
        bridge.syncViews()
      }
      if (snapshot.events !== seenEvents) {
        seenEvents = snapshot.events
        bridge.syncEvents()
      }
    })

    setPhase("loading")
    setSrc(null)
    setCrash(null)
    void (async () => {
      try {
        await ensurePage(hash)
        if (cancelled) return
        await panelServeRegister({
          token,
          hash,
          bootstrapJs: buildBootstrapJs(nonce),
          themeCss: buildThemeCss(themeVars),
        })
        if (cancelled) {
          void panelServeUnregister(token).catch(() => {})
          return
        }
        setSrc(panelEntryUrl(token))
        setPhase("serving")
        handshakeTimer = setTimeout(() => {
          if (!cancelled && !bridge.isReady()) setPhase((now) => (now === "serving" ? "stalled" : now))
        }, HANDSHAKE_TIMEOUT_MS)
      } catch {
        if (!cancelled) setPhase("error")
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(handshakeTimer)
      window.removeEventListener("message", onMessage)
      unsubscribe()
      bridge.dispose()
      setConfirmation(null)
      void panelServeUnregister(token).catch(() => {})
    }
    // A locale or theme switch re-mounts the page so its `ready()` answer stays true; the
    // panel is read through a ref (a `panels` refresh re-creates the entry object).
  }, [runnable, hash, connection, locale, theme, attempt, t])

  if (!runnable) return <Tier1Blocks panel={panel} />

  const retry = (
    <button type="button" className="ghost-button" onClick={() => setAttempt((n) => n + 1)}>
      {t("panels.retry")}
    </button>
  )
  const live = phase === "live"
  return (
    <>
      {phase === "loading" || phase === "serving" ? (
        <p className="panel-frame-loading">{t("panels.loading")}</p>
      ) : null}
      {phase === "error" ? (
        <p className="panel-frame-error-line" role="alert">
          {t("panels.pageError")}
          {retry}
        </p>
      ) : null}
      {phase === "stalled" ? (
        <p className="panel-frame-error-line" role="alert">
          {t("panels.stalled")}
          {crash ? (
            <span className="panel-frame-crash">
              {t("panels.crashDetail", { message: stripControlChars(crash) })}
            </span>
          ) : null}
          {retry}
        </p>
      ) : null}
      {phase === "legacy" ? (
        <p className="panel-frame-error-line" role="alert">
          {t("panels.legacyPage")}
        </p>
      ) : null}
      {src && phase !== "legacy" && phase !== "error" ? (
        <iframe
          ref={frameRef}
          className={live ? "panel-frame" : "panel-frame waiting"}
          src={src}
          // Exactly allow-scripts: adding allow-same-origin would collapse the opaque
          // origin and with it the whole isolation story.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={title}
        />
      ) : null}
      {/* Until the page runs, or when it cannot, it still owes the member its content. */}
      {live ? null : <Tier1Blocks panel={panel} />}
      {confirmation
        ? createPortal(<ConfirmRun panel={title} confirmation={confirmation} />, document.body)
        : null}
    </>
  )
}

/** The host's own question before a page runs a `danger` command: the page cannot click it. */
function ConfirmRun({ panel, confirmation }: { panel: string; confirmation: Confirmation }) {
  const { t } = useTranslation()
  const { command, answer } = confirmation
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopImmediatePropagation()
      answer(false)
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [answer])
  return (
    <div className="panel-modal-backdrop panel-confirm-backdrop">
      <div
        className="panel-modal panel-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={t("panels.page.confirm.title")}
      >
        <header className="desk-title panel-card-head">
          <span className="panel-card-title">{t("panels.page.confirm.title")}</span>
        </header>
        <div className="panel-modal-body">
          <p>
            {t("panels.page.confirm.body", {
              panel,
              command: command.title || command.id,
              id: command.id,
            })}
          </p>
          {command.description ? <p className="panel-confirm-detail">{command.description}</p> : null}
          <div className="chip-row">
            <button ref={cancelRef} type="button" className="ghost-button" onClick={() => answer(false)}>
              {t("panels.page.confirm.cancel")}
            </button>
            <button type="button" className="primary-button" onClick={() => answer(true)}>
              {t("panels.page.confirm.run")}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
