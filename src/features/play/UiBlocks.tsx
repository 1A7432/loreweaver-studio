import { stripControlChars, type UiBlock, type UiChoiceOption, type UiFrame } from "@loreweaver/protocol"
import { transportSend } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"
import Meter from "./Meter"
import {
  ClippingBlockView,
  ImageBlockView,
  LetterBlockView,
  MapPinBlockView,
  TitleCardBlockView,
} from "./UiRichBlocks"

/**
 * One concrete v1.7 block. `onChoose` overrides what picking a choices option
 * sends: hook-emitted `ui` frames send a plain `input` (the default), while
 * tier-1 panel templates send a `panel_intent` (see panels/Tier1Blocks).
 */
export function Block({
  block,
  online,
  onChoose,
}: {
  block: UiBlock
  online: boolean
  onChoose?: (option: UiChoiceOption) => void
}) {
  switch (block.kind) {
    case "meter":
      return (
        <Meter label={stripControlChars(block.label)} value={block.value} min={block.min} max={block.max} />
      )
    case "stat":
      return (
        <div className="ui-stat">
          <span className="ui-stat-label">{stripControlChars(block.label)}</span>
          <span className="ui-stat-value">{stripControlChars(String(block.value))}</span>
        </div>
      )
    case "badge":
      return <span className={`chip badge-${block.tone ?? "info"}`}>{stripControlChars(block.label)}</span>
    case "text":
      return (
        <p className={`ui-text${block.style ? ` is-${block.style}` : ""}`}>{stripControlChars(block.text)}</p>
      )
    case "divider":
      return <hr className="ui-divider" />
    case "choices":
      return (
        <div className="ui-choices">
          {block.prompt ? <p className="ui-prompt">{stripControlChars(block.prompt)}</p> : null}
          <div className="choice-row">
            {block.options.map((option) => (
              <button
                key={option.id}
                type="button"
                className="choice-button"
                disabled={!online}
                // Picking a choice sends its `input` back verbatim as a NORMAL
                // input frame — there is no dedicated choice frame type.
                onClick={() =>
                  onChoose
                    ? onChoose(option)
                    : void transportSend({ type: "input", text: option.input }).catch(() => {})
                }
              >
                {stripControlChars(option.label)}
              </button>
            ))}
          </div>
        </div>
      )
    case "image":
      return <ImageBlockView block={block} />
    case "letter":
      return <LetterBlockView block={block} />
    case "clipping":
      return <ClippingBlockView block={block} />
    case "map_pin":
      return <MapPinBlockView block={block} />
    case "title_card":
      return <TitleCardBlockView block={block} />
    default:
      // Additive protocol: block kinds we don't know yet are skipped.
      return null
  }
}

export default function UiBlocks({ frame }: { frame: UiFrame }) {
  const online = useConnectionStore((s) => s.status === "online")
  return (
    <div className="ui-blocks">
      {frame.blocks.map((block, index) => (
        <Block key={index} block={block} online={online} />
      ))}
    </div>
  )
}
