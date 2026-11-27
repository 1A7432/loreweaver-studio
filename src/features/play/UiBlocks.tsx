// The eleven block kinds of protocol 3.0 §8.3 — the one vocabulary of a `blocks` event and
// of a panel template once it is instantiated. A block of a kind this version does not
// know is skipped (the session has already dropped an event whose known blocks were
// malformed). Pressing a `choices` option runs `command.run {id: command, args}` as the
// member pressing it; what comes back is shown under the blocks.

import { stripControlChars, type Block as WireBlock } from "loreweaver-protocol/v3"
import CommandFeedback from "./CommandFeedback"
import Meter from "./Meter"
import { useCommandRunner, useOnline } from "./room"
import {
  ClippingBlockView,
  ImageBlockView,
  LetterBlockView,
  MapPinBlockView,
  TitleCardBlockView,
} from "./UiRichBlocks"

export type ChoiceOption = Extract<WireBlock, { kind: "choices" }>["options"][number]

/** One concrete block. `onChoose` runs a `choices` option; without it the buttons are inert. */
export function Block({
  block,
  online,
  onChoose,
}: {
  block: WireBlock
  online: boolean
  onChoose?: (option: ChoiceOption) => void
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
                disabled={!online || onChoose === undefined}
                onClick={() => onChoose?.(option)}
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
      // Additive protocol: block kinds this version does not know are skipped.
      return null
  }
}

/** A list of blocks whose choices run as commands, with what came back beneath them. */
export default function UiBlocks({ blocks }: { blocks: readonly WireBlock[] }) {
  const online = useOnline()
  const { run, feedback, dismiss } = useCommandRunner()
  if (blocks.length === 0) return null
  return (
    <div className="ui-blocks">
      {blocks.map((block, index) => (
        <Block
          key={index}
          block={block}
          online={online}
          onChoose={(option) => void run(option.command, option.args ?? {})}
        />
      ))}
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </div>
  )
}
