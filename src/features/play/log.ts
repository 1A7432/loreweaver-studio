// What the narrative log shows, derived — never stored — from the session snapshot: the
// room's events in `seq` order, then the drafts being streamed after everything else. A
// draft is replaced by its `narrative` event (same id) inside the session itself, and a
// `rewind` or `reset` has already been applied to `events` by the time it is read here.
//
// The one thing this derivation decides is `blocks` with `replace: true` (protocol 3.0
// §8.3): it updates the earlier `blocks` event with the same id IN PLACE — the earlier one
// is drawn with the newest content, the replacement is not drawn a second time.

import type { BlocksData, Draft, EventFrame } from "loreweaver-protocol/v3"

export type LogItem =
  | {
      readonly kind: "event"
      readonly key: string
      readonly event: EventFrame
      /** For a `blocks` event a later one replaced: the content to draw instead. */
      readonly blocks?: BlocksData
    }
  | { readonly kind: "draft"; readonly key: string; readonly draft: Draft }

function blockReplacements(events: readonly EventFrame[]): {
  shown: Map<number, BlocksData>
  skipped: Set<number>
} {
  const first = new Map<string, number>()
  const shown = new Map<number, BlocksData>()
  const skipped = new Set<number>()
  for (const event of events) {
    if (event.kind !== "blocks") continue
    const earlier = first.get(event.id)
    if (earlier !== undefined && event.data.replace === true) {
      shown.set(earlier, event.data)
      skipped.add(event.seq)
    } else if (earlier === undefined) {
      first.set(event.id, event.seq)
    }
  }
  return { shown, skipped }
}

export function logItems(events: readonly EventFrame[], drafts: readonly Draft[]): LogItem[] {
  const { shown, skipped } = blockReplacements(events)
  const items: LogItem[] = []
  for (const event of events) {
    if (skipped.has(event.seq)) continue
    const replaced = event.kind === "blocks" ? shown.get(event.seq) : undefined
    items.push(
      replaced
        ? { kind: "event", key: `e${event.seq}`, event, blocks: replaced }
        : { kind: "event", key: `e${event.seq}`, event },
    )
  }
  for (const draft of drafts) items.push({ kind: "draft", key: `d${draft.id}`, draft })
  return items
}

/** The blocks an item draws: the replacement's when one updated it in place. */
export function itemBlocks(item: Extract<LogItem, { kind: "event" }>): BlocksData | null {
  if (item.blocks) return item.blocks
  return item.event.kind === "blocks" ? item.event.data : null
}
