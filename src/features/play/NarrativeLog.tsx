import { useEffect, useRef } from "react"
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

function NarrativeEntry({ frame, draft }: { frame: NarrativeFrame; draft?: boolean }) {
  const { t } = useTranslation()
  const text = stripControlChars(frame.text)
  return (
    <article className={`log-entry speaker-${frame.speaker}`}>
      <header className="entry-speaker">{speakerLabel(frame, t("log.system"))}</header>
      <div className="entry-body">
        {frame.format === "markdown" ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        ) : (
          <p className="entry-plain">{text}</p>
        )}
        {draft ? <span className="stream-cursor" aria-hidden="true" /> : null}
      </div>
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
