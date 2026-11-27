// One mounted panel with its shell chrome: its title (already in the viewer's language),
// collapse and close controls. The PLAYER always wins — any panel can be collapsed or
// closed whatever the pack wants, and closing never leaves the list (reopen lives in the
// panels menu).
//
// A page panel (`kind: "page"`) runs in its sandboxed frame (`Tier2Frame`), showing its
// `fallback` blocks while it loads and whenever it cannot run.

import { useTranslation } from "react-i18next"
import type { PanelEntry } from "loreweaver-protocol/v3"
import { usePanelsStore } from "../../../store/panels"
import { panelTitle } from "./panelList"
import Tier1Blocks from "./Tier1Blocks"
import Tier2Frame from "./Tier2Frame"

/** The panel body: the evaluated template, or the page (with its fallback). */
export function PanelBody({ panel }: { panel: PanelEntry }) {
  return panel.kind === "page" ? <Tier2Frame panel={panel} /> : <Tier1Blocks panel={panel} />
}

export default function PanelCard({ panel }: { panel: PanelEntry }) {
  const { t } = useTranslation()
  const collapsed = usePanelsStore((s) => Boolean(s.collapsed[panel.id]))
  const toggleCollapsed = usePanelsStore((s) => s.toggleCollapsed)
  const setClosed = usePanelsStore((s) => s.setClosed)

  return (
    <section className="desk-card panel-card" data-panel-id={panel.id} data-kind={panel.kind}>
      <header className="desk-title panel-card-head">
        <span className="panel-card-title">{panelTitle(panel)}</span>
        <span className="panel-card-actions">
          <button
            type="button"
            className="icon-button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("panels.expand") : t("panels.collapse")}
            title={collapsed ? t("panels.expand") : t("panels.collapse")}
            onClick={() => toggleCollapsed(panel.id)}
          >
            {collapsed ? "▸" : "▾"}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("panels.close")}
            title={t("panels.close")}
            onClick={() => setClosed(panel.id, true)}
          >
            ×
          </button>
        </span>
      </header>
      {collapsed ? null : <PanelBody panel={panel} />}
    </section>
  )
}
