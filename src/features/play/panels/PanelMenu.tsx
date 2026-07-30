// The panels menu in the session header: every manifest panel is listed here
// — modal panels open from it, closed sidebar/tray panels reopen from it —
// plus the blocks-only client setting. This menu is app chrome; module code
// never touches it.

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { UiManifestPanel } from "@loreweaver/protocol"
import { usePanelsStore } from "../../../store/panels"
import { pickText } from "./templates"

function MenuRow({ panel, onDone }: { panel: UiManifestPanel; onDone: () => void }) {
  const { t, i18n } = useTranslation()
  const closed = usePanelsStore((s) => Boolean(s.closed[panel.id]))
  const setClosed = usePanelsStore((s) => s.setClosed)
  const openModal = usePanelsStore((s) => s.openModal)
  const title = pickText(panel.title, i18n.resolvedLanguage) ?? panel.id
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
            openModal(panel.id)
            onDone()
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
  const manifest = usePanelsStore((s) => s.manifest)
  const blocksOnly = usePanelsStore((s) => s.blocksOnly)
  const setBlocksOnly = usePanelsStore((s) => s.setBlocksOnly)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener("pointerdown", onPointerDown)
    return () => window.removeEventListener("pointerdown", onPointerDown)
  }, [open])

  if (manifest.length === 0) return null
  return (
    <div className="panel-menu" ref={rootRef}>
      <button
        type="button"
        className="ghost-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {t("panels.menu", { n: manifest.length })}
      </button>
      {open ? (
        <div className="panel-menu-pop" role="menu" aria-label={t("panels.menuAria")}>
          <ul className="panel-menu-list">
            {manifest.map((panel) => (
              <MenuRow key={panel.id} panel={panel} onDone={() => setOpen(false)} />
            ))}
          </ul>
          <label className="panel-menu-setting">
            <input
              type="checkbox"
              checked={blocksOnly}
              onChange={(event) => setBlocksOnly(event.target.checked)}
            />
            <span>
              {t("panels.blocksOnly")}
              <small className="panel-menu-hint">{t("panels.blocksOnlyHint")}</small>
            </span>
          </label>
        </div>
      ) : null}
    </div>
  )
}
