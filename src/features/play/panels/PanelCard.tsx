// One mounted panel with its shell chrome: localized title, collapse and
// close controls. The PLAYER always wins — any panel can be collapsed or
// closed regardless of what the module wants, and closing never leaves the
// manifest (reopen lives in the panels menu).

import { useTranslation } from "react-i18next"
import type { UiManifestPanel } from "@loreweaver/protocol"
import { usePanelsStore } from "../../../store/panels"
import { pickText } from "./templates"
import PanelFallback from "./PanelFallback"
import Tier1Blocks from "./Tier1Blocks"
import Tier2Frame from "./Tier2Frame"

/** The panel body per tier, honoring blocks-only mode for Tier 2. */
export function PanelBody({ panel }: { panel: UiManifestPanel }) {
  const blocksOnly = usePanelsStore((s) => s.blocksOnly)
  if (panel.tier === 2) {
    if (blocksOnly) return <PanelFallback panel={panel} />
    return <Tier2Frame panel={panel} />
  }
  return <Tier1Blocks panelId={panel.id} blocks={panel.blocks} />
}

export default function PanelCard({ panel }: { panel: UiManifestPanel }) {
  const { t, i18n } = useTranslation()
  const collapsed = usePanelsStore((s) => Boolean(s.collapsed[panel.id]))
  const toggleCollapsed = usePanelsStore((s) => s.toggleCollapsed)
  const setClosed = usePanelsStore((s) => s.setClosed)
  const title = pickText(panel.title, i18n.resolvedLanguage) ?? panel.id

  return (
    <section className="desk-card panel-card" data-panel-id={panel.id} data-tier={panel.tier}>
      <header className="desk-title panel-card-head">
        <span className="panel-card-title">{title}</span>
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
