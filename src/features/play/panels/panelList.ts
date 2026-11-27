// This viewer's panel list — the `panels` view (protocol 3.0 §10.6), read from the
// session snapshot — and a panel's title for the chrome around it.

import type { PanelEntry } from "loreweaver-protocol/v3"
import { useView } from "../room"

const NO_PANELS: readonly PanelEntry[] = []

/** The `panels` view's list, empty until it arrives. */
export function usePanelList(): readonly PanelEntry[] {
  return useView("panels")?.panels ?? NO_PANELS
}

/** A panel's title (already in the viewer's language), its id when the title is blank. */
export function panelTitle(panel: PanelEntry): string {
  return panel.title.trim() || panel.id
}
