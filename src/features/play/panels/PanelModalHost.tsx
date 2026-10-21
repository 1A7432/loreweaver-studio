// The `modal` slot: an on-demand overlay the player opens from the panels
// menu. One at a time; Esc, the × button, or a backdrop click closes it. The
// shell owns the overlay chrome — the panel only ever fills the body.
//
// Esc is heard on `window`, so it works wherever keyboard focus is in THIS
// document — which is why opening the overlay moves focus onto it (otherwise
// the key goes to whatever sat behind the backdrop) and closing it hands focus
// back. What no listener here can hear is Esc pressed while focus is INSIDE a
// tier-2 panel's sandboxed iframe: a sandbox without `allow-same-origin` is an
// opaque origin, its key events never leave its own document, and the bridge
// has no message for them. Two things keep that from being a trap: clicking the
// overlay's own chrome (title bar, padding) takes focus back out of the frame,
// and Shift+Tab from the frame's first control lands on the × button.

import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { usePanelsStore } from "../../../store/panels"
import { PanelBody } from "./PanelCard"
import { pickText } from "./templates"

export default function PanelModalHost() {
  const { t, i18n } = useTranslation()
  const manifest = usePanelsStore((s) => s.manifest)
  const modalOpen = usePanelsStore((s) => s.modalOpen)
  const closeModal = usePanelsStore((s) => s.closeModal)
  const panel = modalOpen ? manifest.find((candidate) => candidate.id === modalOpen) : undefined
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // Keyed on the id, not the panel object: a manifest refresh re-creates the
  // object, and a refresh must not yank focus out of a field the player is in.
  const openId = panel?.id

  useEffect(() => {
    if (openId === undefined) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => {
      // The opener may be gone by now (a menu row that closed with the menu);
      // then focus stays where the browser put it rather than guessing.
      if (opener?.isConnected && opener !== document.body) opener.focus()
    }
  }, [openId])

  useEffect(() => {
    if (!panel) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // Same target as OnlineView's menu listener (window). stopPropagation
      // cannot order those; stopImmediatePropagation + capture run before
      // the bubble menu handler, and closeModal is sync — a parent that
      // gated on `modalOpen` after this would already read null.
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      closeModal()
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [panel, closeModal])

  if (!panel) return null
  const title = pickText(panel.title, i18n.resolvedLanguage) ?? panel.id
  return (
    <div className="panel-modal-backdrop" onClick={closeModal}>
      <div
        ref={dialogRef}
        // Focusable by script and by a click on its chrome, not by Tab: that is
        // what lets a click on the title bar pull focus back out of a tier-2 frame.
        tabIndex={-1}
        className="panel-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-panel-id={panel.id}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="desk-title panel-card-head">
          <span className="panel-card-title">{title}</span>
          <button
            type="button"
            className="icon-button"
            aria-label={t("panels.close")}
            title={t("panels.close")}
            onClick={closeModal}
          >
            ×
          </button>
        </header>
        <div className="panel-modal-body">
          <PanelBody panel={panel} />
        </div>
      </div>
    </div>
  )
}
