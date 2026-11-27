// The story as the table saw it (protocol 3.0 §7–§8), derived from the session snapshot
// on every render: its events in `seq` order, then the Keeper's reply as it streams (a
// draft bubble, replaced by its `narrative` event inside the session). The session also
// applies `rewind` and `reset` before this reads anything, so the log is simply what
// `snapshot.events` holds — plus a "load earlier" control while older history exists
// (`complete` is false) and a marker where a resume could not replay everything (`gap`).

import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { stripControlChars, type EventFrame, type NarrativeData } from "loreweaver-protocol/v3"
import { useConnection, useSessionSnapshot } from "../../store/connection"
import DiceLine from "./DiceLine"
import { itemBlocks, logItems, type LogItem } from "./log"
import UiBlocks from "./UiBlocks"
import { ImageBlockView } from "./UiRichBlocks"

/**
 * The header over a line, or `null` for none. A player line carries the
 * speaker's name when the server sends one; a label invented for a line
 * without it is worse than none.
 */
function speakerLabel(frame: NarrativeData, systemLabel: string): string | null {
  if (frame.speaker === "kp") return "KP"
  if (frame.speaker === "npc") return stripControlChars(frame.name ?? "NPC")
  if (frame.speaker === "system") return systemLabel
  return stripControlChars(frame.name ?? "").trim() || null
}

/** How much of an NPC line the collapsed row shows. */
export const NPC_PREVIEW_CHARS = 24

/** The engine's NPC table line usually opens with a mood parenthetical, full-width
 * or ASCII — `（嘴上嫌他手笨…）“哎哟哟，停手！…”`. */
const NPC_MOOD = /^\s*[（(]([^）)]*)[）)]\s*/
const NPC_OPEN_QUOTES = /^[“"「『‘]+/
const NPC_CLOSE_QUOTES = /[”"」』’]+$/

/** One line of plain text from the start of an NPC line, cut by characters
 * (not UTF-16 units — a line in zh must not be split inside a pair).
 *
 * A leading mood parenthetical is not the line: the preview starts at the
 * spoken words (without their opening quote) and the mood comes back apart, so
 * the row shows what was SAID rather than the stage direction. */
function npcPreview(frame: NarrativeData, text: string): { text: string; mood: string; cut: boolean } {
  const flat = (frame.format === "markdown" ? text.replace(/[*_`~]|^[>#\s]+/g, "") : text)
    .replace(/\s+/g, " ")
    .trim()
  const parsed = NPC_MOOD.exec(flat)
  const spoken = parsed ? flat.slice(parsed[0].length).replace(NPC_OPEN_QUOTES, "").trim() : ""
  // No parenthetical — or one with no words after it — leaves the line whole.
  const mood = spoken === "" ? "" : (parsed?.[1] ?? "").trim()
  const words = spoken === "" ? flat.replace(NPC_OPEN_QUOTES, "") : spoken
  const chars = Array.from(words)
  return chars.length > NPC_PREVIEW_CHARS
    ? { text: chars.slice(0, NPC_PREVIEW_CHARS).join(""), mood, cut: true }
    : { text: words.replace(NPC_CLOSE_QUOTES, ""), mood, cut: false }
}

function EntryBody({ frame, draft }: { frame: NarrativeData; draft?: boolean }) {
  const text = stripControlChars(frame.text)
  return (
    <div className="entry-body">
      {frame.format === "markdown" ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      ) : (
        <p className="entry-plain">{text}</p>
      )}
      {draft ? <span className="stream-cursor" aria-hidden="true" /> : null}
    </div>
  )
}

/** The line's mood, muted after the words. It takes only the room the words
 * leave (CSS), and its full text is the tooltip. */
function NpcMood({ mood }: { mood: string }) {
  if (mood === "") return null
  return (
    <span className="npc-line-mood" title={mood}>
      {mood}
    </span>
  )
}

/** An NPC's spoken line, folded to an attribution row until the reader opens it.
 *
 * The engine has the Keeper restate every line it voices through an NPC inside
 * its own narration — by contract, because only the narration is persisted into
 * the Keeper's memory. So the full line arrives twice, first as this bubble and
 * then woven into the narration. The narration stays the reading surface; this
 * keeps who spoke (and how it began) in place without making the table read a
 * 300-character speech twice. Nothing is dropped and the order is untouched.
 * The unfolded view is always the original line, mood and quotes included. */
function NpcEntry({ frame, draft }: { frame: NarrativeData; draft?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const preview = npcPreview(frame, stripControlChars(frame.text))
  // A line that fits the preview has nothing to unfold.
  if (!preview.cut) {
    return (
      <article className="log-entry speaker-npc npc-line">
        <div className="npc-line-toggle">
          <span className="entry-speaker">{speakerLabel(frame, t("log.system"))}</span>
          <span className="npc-line-preview">{preview.text}</span>
          <NpcMood mood={preview.mood} />
          {draft ? <span className="stream-cursor" aria-hidden="true" /> : null}
        </div>
      </article>
    )
  }
  return (
    <article className="log-entry speaker-npc npc-line">
      <button
        type="button"
        className="npc-line-toggle"
        aria-expanded={open}
        title={t(open ? "session.npcLine.hide" : "session.npcLine.show")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="entry-speaker">{speakerLabel(frame, t("log.system"))}</span>
        {open ? null : <span className="npc-line-preview">{preview.text}…</span>}
        {open ? null : <NpcMood mood={preview.mood} />}
        <span className="npc-line-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? <EntryBody frame={frame} draft={draft} /> : null}
    </article>
  )
}

function NarrativeEntry({ frame, draft }: { frame: NarrativeData; draft?: boolean }) {
  const { t } = useTranslation()
  if (frame.speaker === "npc") return <NpcEntry frame={frame} draft={draft} />
  const label = speakerLabel(frame, t("log.system"))
  return (
    <article className={`log-entry speaker-${frame.speaker}`}>
      {label ? <header className="entry-speaker">{label}</header> : null}
      <EntryBody frame={frame} draft={draft} />
    </article>
  )
}

function SystemLine({ text, level = "info" }: { text: string; level?: "info" | "warn" }) {
  return (
    <div className={`system-line level-${level}`}>
      <span>{text}</span>
    </div>
  )
}

/** A file shared with the table: a picture is drawn, anything else is named. */
function MediaEntry({ event }: { event: Extract<EventFrame, { kind: "media" }> }) {
  const { t } = useTranslation()
  const name = stripControlChars(event.data.name)
  if (event.data.mime.startsWith("image/")) {
    return (
      <div className="log-ui">
        <ImageBlockView
          block={{ kind: "image", hash: event.data.hash, mime: event.data.mime, caption: name }}
        />
      </div>
    )
  }
  return <SystemLine text={t("session.mediaShared", { name })} />
}

const Entry = memo(function Entry({ item }: { item: LogItem }) {
  const { t } = useTranslation()
  if (item.kind === "draft") {
    return <NarrativeEntry frame={{ speaker: "kp", text: item.draft.text, format: "markdown" }} draft />
  }
  const event = item.event
  switch (event.kind) {
    case "narrative":
      return <NarrativeEntry frame={event.data} />
    case "dice":
      return <DiceLine data={event.data} />
    case "blocks":
      return (
        <div className="log-ui">
          <UiBlocks blocks={itemBlocks(item)?.blocks ?? []} />
        </div>
      )
    case "media":
      return <MediaEntry event={event} />
    case "rewind":
      return <SystemLine text={t("session.rewound")} />
    case "reset":
      return <SystemLine text={t(`session.reset.${event.data.scope}`)} />
  }
}, sameItem)

/** The log is re-derived on every snapshot (each draft slice among them), but its frames
 * are immutable: an entry whose event (or draft, or replacement) is the same object need
 * not render again. */
function sameItem(before: { item: LogItem }, after: { item: LogItem }): boolean {
  const a = before.item
  const b = after.item
  if (a.kind === "draft") return b.kind === "draft" && a.draft === b.draft
  if (b.kind === "draft") return false
  return a.event === b.event && a.blocks === b.blocks
}

/** How close to the bottom (px) still counts as "following the stream". */
export const FOLLOW_SLACK_PX = 48

/** History before the window, or a hole a resume left: one control loads the next page. */
function OlderControl({
  label,
  loading,
  onLoad,
  online,
}: {
  label: string
  loading: boolean
  onLoad: () => void
  online: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="log-older">
      <button type="button" className="ghost-button" disabled={!online || loading} onClick={onLoad}>
        {loading ? (
          <>
            <span className="spinner spinner-inline" aria-hidden="true" />
            {t("session.loadingOlder")}
          </>
        ) : (
          label
        )}
      </button>
    </div>
  )
}

export default function NarrativeLog() {
  const { t } = useTranslation()
  const connection = useConnection()
  const snapshot = useSessionSnapshot()
  const events = snapshot?.events
  const drafts = snapshot?.drafts
  const gap = snapshot?.gap ?? null
  const complete = snapshot?.complete ?? true
  const online = snapshot?.status === "online"
  const [loading, setLoading] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  // Streaming turns one reply into dozens of updates; only follow when the
  // reader is already pinned at the bottom, so scrolling up to reread history
  // is never yanked back down mid-stream.
  const pinned = useRef(true)
  const lastTop = useRef(0)
  // Older events land ABOVE what the reader is looking at: keep their distance
  // from the bottom so the page does not jump.
  const anchor = useRef<number | null>(null)

  // Only the READER moving the scroll position re-decides whether we are following.
  // Content growing underneath — a picture that finishes loading after its entry
  // was placed — leaves the position alone; it used to count as "scrolled away", and the
  // log stopped following every later turn. Our own follow records where it put the
  // position, because its scroll event arrives a frame later: an image that learned its
  // size in between made that event read as "far from the bottom", and unpinned the log.
  const follow = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight
    lastTop.current = el.scrollTop
  }

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    if (el.scrollTop !== lastTop.current) {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX
    }
    lastTop.current = el.scrollTop
  }

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current
      lastTop.current = el.scrollTop
      anchor.current = null
      return
    }
    if (pinned.current) follow(el)
  }, [events, drafts])

  // Media loads after its entry is laid out and grows the log; keep a following reader at
  // the bottom when it does. `load` does not bubble, so listen in the capture phase.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onMediaLoad = () => {
      if (pinned.current) follow(el)
    }
    el.addEventListener("load", onMediaLoad, true)
    return () => el.removeEventListener("load", onMediaLoad, true)
  }, [])

  const loadOlder = () => {
    if (connection === null) return
    const el = scroller.current
    if (el) anchor.current = el.scrollHeight - el.scrollTop
    setLoading(true)
    void connection.session
      .loadOlder()
      .catch(() => 0)
      .then((added) => {
        if (added === 0) anchor.current = null
        setLoading(false)
      })
  }

  const items = logItems(events ?? [], drafts ?? [])
  // Where the hole a resume left sits: after the last event at or before its start.
  const gapAt =
    gap === null ? -1 : items.findIndex((item) => item.kind === "event" && item.event.seq >= gap.before)

  return (
    <div className="narrative-log" ref={scroller} onScroll={onScroll}>
      {gap === null && !complete ? (
        <OlderControl label={t("session.loadOlder")} loading={loading} onLoad={loadOlder} online={online} />
      ) : null}
      {gap !== null && gapAt < 0 ? (
        <OlderControl label={t("session.loadGap")} loading={loading} onLoad={loadOlder} online={online} />
      ) : null}
      {items.length === 0 && complete ? <p className="log-empty">{t("session.empty")}</p> : null}
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index === gapAt ? (
            <OlderControl label={t("session.loadGap")} loading={loading} onLoad={loadOlder} online={online} />
          ) : null}
          <Entry item={item} />
        </Fragment>
      ))}
    </div>
  )
}
