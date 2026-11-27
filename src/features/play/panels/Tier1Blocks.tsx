// A panel's body: its blocks evaluated against the views it reads, with the protocol
// package's `panelBlocks` — the ONE evaluation of panel templates every client shares
// (bindings, `visible_when`, `repeat`; protocol 3.0 §10.6). A template panel draws its
// blocks; a page panel draws its `fallback` (while its page loads, or when it cannot run);
// a page with no fallback says it needs a rich client. Choices run as commands.

import { useMemo } from "react"
import { panelBlocks, type PanelEntry } from "loreweaver-protocol/v3"
import { useSessionSnapshot } from "../../../store/connection"
import UiBlocks from "../UiBlocks"
import PanelFallback from "./PanelFallback"

export default function Tier1Blocks({ panel }: { panel: PanelEntry }) {
  const views = useSessionSnapshot()?.views
  const blocks = useMemo(() => {
    const values = new Map<string, unknown>()
    for (const [name, held] of views ?? []) values.set(name, held.data)
    return panelBlocks(panel, values)
  }, [panel, views])
  if (blocks === null) return <PanelFallback />
  return <UiBlocks blocks={blocks} />
}
