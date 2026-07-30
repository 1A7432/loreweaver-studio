// A Tier-2 panel rendered without its code: the pack-declared tier-1
// `fallback` blocks, or — when the author explicitly opted out with
// `fallback: null` — one localized "rich client only" line.

import { useTranslation } from "react-i18next"
import type { UiManifestPanel } from "@loreweaver/protocol"
import Tier1Blocks from "./Tier1Blocks"

export default function PanelFallback({ panel }: { panel: UiManifestPanel }) {
  const { t } = useTranslation()
  if (Array.isArray(panel.fallback) && panel.fallback.length > 0) {
    return <Tier1Blocks panelId={panel.id} blocks={panel.fallback} />
  }
  return <p className="panel-fallback-null">{t("panels.richOnly")}</p>
}
