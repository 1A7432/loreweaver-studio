// Tier-1 panel body: resolve the template against the viewer's own variables
// and render with the shared v1.7 block renderer. Choices send `panel_intent`
// (kind "choice") instead of a plain input line — the server routes it as if
// this player typed the option's input.

import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import type { PanelTemplateBlock } from "@loreweaver/protocol"
import { transportSend } from "../../../lib/transport"
import { useConnectionStore } from "../../../store/connection"
import { useSessionStore } from "../../../store/session"
import { Block } from "../UiBlocks"
import { resolvePanelBlocks } from "./templates"

export default function Tier1Blocks({
  panelId,
  blocks,
}: {
  panelId: string
  blocks: readonly PanelTemplateBlock[] | undefined
}) {
  const { i18n } = useTranslation()
  const online = useConnectionStore((s) => s.status === "online")
  const variables = useSessionStore((s) => s.game?.variables)
  const locale = i18n.resolvedLanguage
  const resolved = useMemo(
    () => resolvePanelBlocks(blocks, variables ?? [], locale),
    [blocks, variables, locale],
  )
  if (resolved.length === 0) return null
  return (
    <div className="ui-blocks">
      {resolved.map((block, index) => (
        <Block
          key={index}
          block={block}
          online={online}
          onChoose={(option) =>
            void transportSend({
              type: "panel_intent",
              panel: panelId,
              kind: "choice",
              value: option.input,
            }).catch(() => {})
          }
        />
      ))}
    </div>
  )
}
