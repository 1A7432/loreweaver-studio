// The room admin's lifecycle controls (protocol 3.0 §6.7): keep the room in a file and bring it
// back (`save`), wipe the campaign (`reset`: arm, then confirm within the server's window), and
// take turns back (`undo`). All three are `danger` commands: each asks before it acts.
//
// An export answers the whole room — every secret of it — to this admin alone; it is written
// only to a file the admin picks, never anywhere else. An import replaces the room: the server
// then ends every member's connection, this one too, and the connection redials by itself and
// is handed the room as it now is.

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { saveSecretTextFile } from "../../../lib/files"
import { pickJsonFile } from "../../../lib/native"
import { useSessionSnapshot } from "../../../store/connection"
import CommandFeedback from "../CommandFeedback"
import { useCommand, useCommandRunner, useOnline } from "../room"
import ScreenShell from "./ScreenShell"

/** How long an armed reset waits for its confirmation (`docs/protocol.md` §6.7, §12.4). The
 * answer to the arming call does not carry it. */
export const RESET_CONFIRM_MS = 60_000

const SCOPES = ["story", "chars", "all"] as const
type Scope = (typeof SCOPES)[number]

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function SaveRoom() {
  const { t } = useTranslation()
  const online = useOnline()
  const room = useSessionSnapshot()?.welcome?.room.id ?? "room"
  const exporter = useCommandRunner()
  const importer = useCommandRunner()
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [bundle, setBundle] = useState<{ name: string; value: Record<string, unknown> } | null>(null)

  const exportRoom = async () => {
    setNote(null)
    const result = await exporter.run("save", { op: "export" })
    if (!result?.ok || typeof result.data !== "object" || result.data === null) return
    try {
      const outcome = await saveSecretTextFile(
        `loreweaver-${room}-${stamp(new Date())}.json`,
        JSON.stringify(result.data, null, 2),
      )
      if (outcome === "saved") setNote({ ok: true, text: t("play.rooms.exported") })
      else if (outcome === "unavailable") setNote({ ok: false, text: t("play.rooms.desktopOnly") })
    } catch {
      setNote({ ok: false, text: t("play.rooms.writeFailed") })
    }
  }

  const pick = async () => {
    setNote(null)
    const file = await pickJsonFile()
    if (file === null) return
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8").decode(file.bytes))
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("not an object")
      setBundle({ name: file.name, value: value as Record<string, unknown> })
    } catch {
      setNote({ ok: false, text: t("play.rooms.notABundle", { name: file.name }) })
    }
  }

  const importRoom = () => {
    if (bundle === null) return
    const value = bundle.value
    setBundle(null)
    void importer.run("save", { op: "import", bundle: value })
  }

  return (
    <div className="room-op">
      <h4>{t("play.rooms.saveTitle")}</h4>
      <p className="studio-hint">{t("play.rooms.exportHint")}</p>
      <button
        type="button"
        className="ghost-button"
        disabled={!online || exporter.pending}
        onClick={() => void exportRoom()}
      >
        {t("play.rooms.export")}
      </button>
      <CommandFeedback feedback={exporter.feedback} onDismiss={exporter.dismiss} />
      <p className="studio-hint">{t("play.rooms.importHint")}</p>
      {bundle === null ? (
        <button
          type="button"
          className="ghost-button"
          disabled={!online || importer.pending}
          onClick={() => void pick()}
        >
          {t("play.rooms.import")}
        </button>
      ) : (
        <div className="room-danger" role="alert">
          <p>{t("play.rooms.importWarning", { name: bundle.name })}</p>
          <div className="chip-row">
            <button type="button" className="primary-button" disabled={!online} onClick={importRoom}>
              {t("play.rooms.importConfirm")}
            </button>
            <button type="button" className="ghost-button" onClick={() => setBundle(null)}>
              {t("play.rooms.cancel")}
            </button>
          </div>
        </div>
      )}
      <CommandFeedback feedback={importer.feedback} onDismiss={importer.dismiss} />
      {note ? (
        <p className={note.ok ? "studio-hint" : "connect-error"} role={note.ok ? "status" : "alert"}>
          {note.text}
        </p>
      ) : null}
    </div>
  )
}

function ResetRoom() {
  const { t } = useTranslation()
  const online = useOnline()
  const { run, feedback, dismiss, pending } = useCommandRunner()
  const [scope, setScope] = useState<Scope>("story")
  const [armed, setArmed] = useState<{ scope: Scope; until: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (armed === null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [armed])

  const left = armed === null ? 0 : Math.max(0, Math.ceil((armed.until - now) / 1000))
  const live = armed !== null && left > 0

  const arm = async () => {
    setArmed(null)
    const result = await run("reset", { scope })
    const data = result?.ok ? (result.data as { armed?: unknown } | null) : null
    if (data !== null && typeof data === "object" && data.armed === scope) {
      const at = Date.now()
      setNow(at)
      setArmed({ scope, until: at + RESET_CONFIRM_MS })
    }
  }

  const confirm = async () => {
    setArmed(null)
    await run("reset", { confirm: true })
  }

  return (
    <div className="room-danger">
      <h4>{t("play.rooms.reset")}</h4>
      <label className="field field-narrow">
        {t("play.rooms.scope")}
        <select value={scope} disabled={live} onChange={(e) => setScope(e.target.value as Scope)}>
          {SCOPES.map((entry) => (
            <option key={entry} value={entry}>
              {t(`play.rooms.scopes.${entry}`)}
            </option>
          ))}
        </select>
      </label>
      <p className="studio-hint">{t(`play.rooms.resetHint.${scope}`)}</p>
      {live ? (
        <div className="chip-row">
          <button
            type="button"
            className="primary-button"
            disabled={!online || pending}
            onClick={() => void confirm()}
          >
            {t("play.rooms.resetConfirm", { seconds: left })}
          </button>
          <button type="button" className="ghost-button" onClick={() => setArmed(null)}>
            {t("play.rooms.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="ghost-button"
          disabled={!online || pending}
          onClick={() => void arm()}
        >
          {t("play.rooms.resetArm")}
        </button>
      )}
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </div>
  )
}

function UndoTurns() {
  const { t } = useTranslation()
  const online = useOnline()
  const { run, feedback, dismiss, pending } = useCommandRunner()
  const [turns, setTurns] = useState("1")
  const [asking, setAsking] = useState(false)
  const count = Number(turns)
  const valid = Number.isInteger(count) && count >= 1 && count <= 64
  return (
    <div className="room-danger">
      <h4>{t("play.rooms.undo")}</h4>
      <p className="studio-hint">{t("play.rooms.undoHint")}</p>
      <label className="field field-narrow">
        {t("play.rooms.turns")}
        <input
          type="text"
          inputMode="numeric"
          value={turns}
          disabled={asking}
          onChange={(e) => setTurns(e.target.value)}
        />
      </label>
      {asking ? (
        <div className="chip-row">
          <button
            type="button"
            className="primary-button"
            disabled={!online || pending}
            onClick={() => {
              setAsking(false)
              void run("undo", { turns: count })
            }}
          >
            {t("play.rooms.undoConfirm", { count })}
          </button>
          <button type="button" className="ghost-button" onClick={() => setAsking(false)}>
            {t("play.rooms.cancel")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="ghost-button"
          disabled={!online || pending || !valid}
          onClick={() => setAsking(true)}
        >
          {t("play.rooms.undoAsk")}
        </button>
      )}
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </div>
  )
}

export default function RoomLifecycle({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const canSave = useCommand("save", ["op", "bundle"]) !== null
  const canReset = useCommand("reset", ["scope", "confirm"]) !== null
  const canUndo = useCommand("undo", ["turns"]) !== null
  return (
    <ScreenShell title={t("play.menu.room")} onBack={onBack}>
      {!canSave && !canReset && !canUndo ? (
        <p className="placeholder">{t("play.admin.unavailable")}</p>
      ) : null}
      {canSave ? <SaveRoom /> : null}
      {canUndo ? <UndoTurns /> : null}
      {canReset ? <ResetRoom /> : null}
    </ScreenShell>
  )
}
