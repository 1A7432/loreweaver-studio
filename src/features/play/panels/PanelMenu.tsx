// The panels menu in the session header: every listed panel is here — overlay
// panels open from it, closed sidebar/tray panels reopen from it. This menu is
// app chrome; pack content never touches it.

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { PanelEntry } from "loreweaver-protocol/v3"
import { usePanelsStore } from "../../../store/panels"
import { panelTitle, usePanelList } from "./panelList"

function MenuRow({ panel, onDone }: { panel: PanelEntry; onDone: () => void }) {
  const { t } = useTranslation()
  const closed = usePanelsStore((s) => Boolean(s.closed[panel.id]))
  const setClosed = usePanelsStore((s) => s.setClosed)
  const openModal = usePanelsStore((s) => s.openModal)
  const title = panelTitle(panel)
  const action = panel.slot === "modal" ? t("panels.open") : closed ? t("panels.reopen") : t("panels.close")
  return (
    <li className="panel-menu-row">
      <span className="panel-menu-slot">{t(`panels.slot.${panel.slot}`)}</span>
      <span className="panel-menu-title">{title}</span>
      <button
        type="button"
        className="ghost-button"
        onClick={() => {
          if (panel.slot === "modal") {
            // Close the menu first: that hands focus back to the "Panels" button,
            // which is what the overlay will return it to when it closes.
            onDone()
            openModal(panel.id)
          } else {
            setClosed(panel.id, !closed)
          }
        }}
      >
        {action}
      </button>
    </li>
  )
}

export default function PanelMenu() {
  const { t } = useTranslation()
  const panels = usePanelList()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    return () => window.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  if (panels.length === 0) return null
  return (
    <div className="panel-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="ghost-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {t("panels.menu", { n: panels.length })}
      </button>
      {open ? (
        <div className="panel-menu-pop" role="menu" aria-label={t("panels.menuAria")}>
          <ul className="panel-menu-list">
            {panels.map((panel) => (
              <MenuRow
                key={panel.id}
                panel={panel}
                onDone={() => {
                  triggerRef.current?.focus()
                  setOpen(false)
                }}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
