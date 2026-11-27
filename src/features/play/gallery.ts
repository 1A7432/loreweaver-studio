// The room's pictures, derived from the log the session holds — never a store of their own: the
// files shared with the table (`media` events, §8.4) and the pictures the story put in front of
// it (`image` and `map_pin` blocks, §8.3). Newest first, one entry per file. Sounds shared with
// the table are listed too (by name); they are not drawn.

import type { EventFrame } from "loreweaver-protocol/v3"

export interface GalleryItem {
  readonly hash: string
  readonly mime: string | undefined
  /** A file name, a caption, a pin's label, or empty. */
  readonly label: string
  /** The `seq` of the newest event that showed it. */
  readonly seq: number
  /** Shared by a member (`media`), rather than shown by the story (a block). */
  readonly shared: boolean
}

/** At most this many entries, newest first. */
export const GALLERY_CAP = 64

export function isPicture(mime: string | undefined): boolean {
  return mime === undefined || mime.startsWith("image/")
}

export function galleryOf(events: readonly EventFrame[]): GalleryItem[] {
  const seen = new Set<string>()
  const items: GalleryItem[] = []
  const add = (item: GalleryItem) => {
    if (seen.has(item.hash) || items.length >= GALLERY_CAP) return
    seen.add(item.hash)
    items.push(item)
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.kind === "media") {
      add({
        hash: event.data.hash,
        mime: event.data.mime,
        label: event.data.name,
        seq: event.seq,
        shared: true,
      })
    } else if (event.kind === "blocks") {
      for (const block of [...event.data.blocks].reverse()) {
        if (block.kind === "image") {
          add({
            hash: block.hash,
            mime: block.mime,
            label: block.caption ?? block.alt ?? "",
            seq: event.seq,
            shared: false,
          })
        } else if (block.kind === "map_pin") {
          add({ hash: block.hash, mime: block.mime, label: block.label, seq: event.seq, shared: false })
        }
      }
    }
  }
  return items
}
