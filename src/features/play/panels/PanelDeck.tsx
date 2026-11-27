// The two always-mounted slots: `sidebar` stacks into the desk column, `tray` is a
// horizontal strip pinned above the input line. Both render only open (non-closed)
// panels; the narrative log and input line never yield. The list is the `panels` view
// (protocol 3.0 §10.6), read from the session snapshot.

import type { PanelEntry, PanelSlot } from "loreweaver-protocol/v3"
import { usePanelsStore } from "../../../store/panels"
import PanelCard from "./PanelCard"
import { usePanelList } from "./panelList"

function useOpenPanels(slot: PanelSlot): PanelEntry[] {
  const panels = usePanelList()
  const closed = usePanelsStore((s) => s.closed)
  return panels.filter((panel) => panel.slot === slot && !closed[panel.id])
}

/** Sidebar slot: stacked, collapsible cards at the top of the desk column. */
export function PanelSidebar() {
  const panels = useOpenPanels("sidebar")
  if (panels.length === 0) return null
  return (
    <div className="desk-stack panel-deck" data-slot="sidebar">
      {panels.map((panel) => (
        <PanelCard key={panel.id} panel={panel} />
      ))}
    </div>
  )
}

/** Tray slot: a bottom strip of cards between the log and the input line. */
export function PanelTray() {
  const panels = useOpenPanels("tray")
  if (panels.length === 0) return null
  return (
    <div className="panel-tray" data-slot="tray">
      {panels.map((panel) => (
        <PanelCard key={panel.id} panel={panel} />
      ))}
    </div>
  )
}
