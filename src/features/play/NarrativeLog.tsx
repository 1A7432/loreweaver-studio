import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { stripControlChars, type NarrativeFrame, type SystemFrame } from "@loreweaver/protocol"
import { useSessionStore, type LogEntry } from "../../store/session"
import DiceLine from "./DiceLine"
import UiBlocks from "./UiBlocks"

function speakerLabel(frame: NarrativeFrame, systemLabel: string): string {
  if (frame.speaker === "kp") return "KP"
  if (frame.speaker === "npc") return stripControlChars(frame.name ?? "NPC")
  if (frame.speaker === "system") return systemLabel
  return stripControlChars(frame.name ?? "?")
}

function NarrativeEntry({ frame }: { frame: NarrativeFrame }) {
  const { t } = useTranslation()
  const text = stripControlChars(frame.text)
  const streaming = Boolean(frame.stream) && !frame.done
  return (
    <article className={`log-entry speaker-${frame.speaker}`}>
      <header className="entry-speaker">{speakerLabel(frame, t("log.system"))}</header>
      <div className="entry-body">
        {frame.format === "markdown" ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        ) : (
          <p className="entry-plain">{text}</p>
        )}
        {streaming ? <span className="stream-cursor" aria-hidden="true" /> : null}
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

function Entry({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case "narrative":
      return <NarrativeEntry frame={entry.frame} />
    case "dice":
      return <DiceLine frame={entry.frame} />
    case "system":
      return <SystemEntry frame={entry.frame} />
    case "ui":
      return (
        <div className="log-ui">
          <UiBlocks frame={entry.frame} />
        </div>
      )
  }
}

export default function NarrativeLog() {
  const { t } = useTranslation()
  const entries = useSessionStore((s) => s.entries)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <div className="narrative-log" ref={scroller}>
      {entries.length === 0 ? <p className="log-empty">{t("session.empty")}</p> : null}
      {entries.map((entry) => (
        <Entry key={entry.seq} entry={entry} />
      ))}
    </div>
  )
}
