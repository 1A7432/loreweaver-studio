// The `modal` slot: an on-demand overlay the player opens from the panels
// menu. One at a time; Esc, the × button, or a backdrop click closes it. The
// shell owns the overlay chrome — the panel only ever fills the body.

import { useEffect } from "react"
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
