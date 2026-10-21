import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  stripControlChars,
  type ErrorFrame,
  type NarrativeFrame,
  type SystemFrame,
} from "@loreweaver/protocol"
import { useSessionStore, type LogEntry, type PendingEcho } from "../../store/session"
import DiceLine from "./DiceLine"
import UiBlocks from "./UiBlocks"

function speakerLabel(frame: NarrativeFrame, systemLabel: string): string {
  if (frame.speaker === "kp") return "KP"
  if (frame.speaker === "npc") return stripControlChars(frame.name ?? "NPC")
  if (frame.speaker === "system") return systemLabel
  return stripControlChars(frame.name ?? "?")
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
function npcPreview(frame: NarrativeFrame, text: string): { text: string; mood: string; cut: boolean } {
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

function EntryBody({ frame, draft }: { frame: NarrativeFrame; draft?: boolean }) {
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
function NpcEntry({ frame, draft }: { frame: NarrativeFrame; draft?: boolean }) {
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

function NarrativeEntry({ frame, draft }: { frame: NarrativeFrame; draft?: boolean }) {
  const { t } = useTranslation()
  if (frame.speaker === "npc") return <NpcEntry frame={frame} draft={draft} />
  return (
    <article className={`log-entry speaker-${frame.speaker}`}>
      <header className="entry-speaker">{speakerLabel(frame, t("log.system"))}</header>
      <EntryBody frame={frame} draft={draft} />
    </article>
  )
}

/** A line this client sent, dimmed until the table reflects it back. */
function PendingEntry({ pending }: { pending: PendingEcho }) {
  const { t } = useTranslation()
  return (
    <article className={`log-entry speaker-player pending${pending.failed ? " failed" : ""}`}>
      <header className="entry-speaker">{stripControlChars(pending.speaker)}</header>
      <div className="entry-body">
        <p className="entry-plain">{stripControlChars(pending.text)}</p>
        <span className="pending-mark">
          {pending.failed ? t("session.echoFailed") : t("session.echoPending")}
        </span>
      </div>
    </article>
  )
}

function SystemEntry({ frame }: { frame: SystemFrame }) {
  return (
    <div className={`system-line level-${frame.level}`}>
      {frame.spinner ? <span className="spinner spinner-inline" aria-hidden="true" /> : null}
      <span>{stripControlChars(frame.text)}</span>
    </div>
  )
}

/** The server refusing something, told where the player is already looking. */
function ErrorEntry({ frame }: { frame: ErrorFrame }) {
  const { t } = useTranslation()
  const detail = stripControlChars(frame.message).trim()
  return (
    <div className="system-line level-error" role="status">
      <span>{t("session.serverRefused", { message: detail || frame.code })}</span>
    </div>
  )
}

function Entry({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case "narrative":
      return <NarrativeEntry frame={entry.frame} draft={entry.draft} />
    case "dice":
      return <DiceLine frame={entry.frame} />
    case "system":
      return <SystemEntry frame={entry.frame} />
    case "error":
      return <ErrorEntry frame={entry.frame} />
    case "ui":
      return (
        <div className="log-ui">
          <UiBlocks frame={entry.frame} />
        </div>
      )
    case "pending":
      return <PendingEntry pending={entry.pending} />
  }
}

/** How close to the bottom (px) still counts as "following the stream". */
export const FOLLOW_SLACK_PX = 48

/** How often the log checks whether an un-echoed line has run out of time. */
export const ECHO_SWEEP_MS = 5_000

export default function NarrativeLog() {
  const { t } = useTranslation()
  const entries = useSessionStore((s) => s.entries)
  const expireEchoes = useSessionStore((s) => s.expirePendingEchoes)
  const scroller = useRef<HTMLDivElement>(null)
  // Streaming turns one reply into dozens of updates; only follow when the
  // reader is already pinned at the bottom, so scrolling up to reread history
  // is never yanked back down mid-stream.
  const pinned = useRef(true)
  const lastTop = useRef(0)

  // Only the READER moving the scroll position re-decides whether we are following.
  // Content growing underneath — a Director image that finishes loading after its entry
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

  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) follow(el)
  }, [entries])

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

  // A line the table never reflected back has to say so rather than sit there
  // looking sent. The sweep only runs while something is actually waiting.
  const waiting = entries.some((entry) => entry.kind === "pending" && !entry.pending.failed)
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => expireEchoes(Date.now()), ECHO_SWEEP_MS)
    return () => clearInterval(timer)
  }, [waiting, expireEchoes])

  return (
    <div className="narrative-log" ref={scroller} onScroll={onScroll}>
      {entries.length === 0 ? <p className="log-empty">{t("session.empty")}</p> : null}
      {entries.map((entry) => (
        <Entry key={entry.seq} entry={entry} />
      ))}
    </div>
  )
}
