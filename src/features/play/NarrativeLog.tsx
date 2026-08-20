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

  const onScroll = () => {
    const el = scroller.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX
  }

  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries])

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
