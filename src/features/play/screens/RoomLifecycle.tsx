// The room admin's lifecycle controls (protocol 3.0 §6.7): keep the room in a file and bring it
// back (`save`), wipe the campaign (`reset`: arm, then confirm within the server's window), and
// take turns back (`undo`). All three are `danger` commands: each asks before it acts.
//
// A save holds the whole room — every secret of it — and travels on the byte channel, never in a
// frame (`lib/roomSave.ts`). Saving asks where to write it first, then runs the export, and the
// native side fetches the file the answer names, checks it against that answer's hash and size,
// and writes it, private to this user, only there. Restoring reads the picked file natively,
// offers it with `purpose: "save"`, sends it, and runs `save {op: "import", file}`. Its bytes
// never enter this page either way. An import replaces the room: the server then ends every
// member's connection, this one too, and the connection redials by itself and is handed the room
// as it now is.

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { stripControlChars } from "loreweaver-protocol/v3"
import type { PreparedFile } from "../../../lib/media"
import { toByteFailure } from "../../../lib/media"
import {
  MAX_SAVE_BYTES,
  SAVE_LIMIT_MB,
  pickSaveDestination,
  pickSaveSource,
  saveFetch,
  savePrepare,
  savedFile,
  sizeLabel,
  uploadSave,
} from "../../../lib/roomSave"
import { isTauri } from "../../../lib/transport"
import { useConnection, useSessionSnapshot } from "../../../store/connection"
import CommandFeedback from "../CommandFeedback"
import { useCommand, useCommandRunner, useOnline } from "../room"
import { transferErrorText } from "../transfer"
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

/** What a person reads for a save that could not be fetched, written, read or sent: the
 * server's own words for its refusal, this client's words for the rest. */
function saveErrorText(error: unknown, t: TFunction, name = ""): string {
  const failure = toByteFailure(error)
  if (!failure.server) {
    if (failure.code === "too_large") return t("play.rooms.saveTooLarge", { mb: SAVE_LIMIT_MB })
    if (failure.code === "not_a_save" && name !== "")
      return t("play.rooms.notABundle", { name: stripControlChars(name) })
    if (failure.code === "write_failed") return t("play.rooms.writeFailed")
  }
  return transferErrorText(failure, t)
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function SaveRoom() {
  const { t } = useTranslation()
  const online = useOnline()
  const connection = useConnection()
  const room = useSessionSnapshot()?.welcome?.room.id ?? "room"
  const exporter = useCommandRunner()
  const importer = useCommandRunner()
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [sending, setSending] = useState(false)
  const [picked, setPicked] = useState<{ path: string; file: PreparedFile } | null>(null)

  const exportRoom = async () => {
    setNote(null)
    if (!isTauri()) {
      setNote({ ok: false, text: t("play.rooms.desktopOnly") })
      return
    }
    // Where first: the room keeps only its latest export, so the file is fetched the moment
    // the answer names it.
    const path = await pickSaveDestination(
      `loreweaver-${room}-${stamp(new Date())}.json`,
      t("play.rooms.fileFilter"),
    )
    if (path === null) return
    const result = await exporter.run("save", { op: "export" })
    if (!result?.ok) return
    const offer = savedFile(result)
    if (offer === null) {
      setNote({ ok: false, text: t("play.rooms.badAnswer") })
      return
    }
    if (offer.size > MAX_SAVE_BYTES) {
      setNote({ ok: false, text: t("play.rooms.saveTooLarge", { mb: SAVE_LIMIT_MB }) })
      return
    }
    setFetching(true)
    try {
      const bytes = await saveFetch(offer, path)
      setNote({ ok: true, text: t("play.rooms.exported", { size: sizeLabel(bytes) }) })
    } catch (error) {
      setNote({ ok: false, text: saveErrorText(error, t) })
    } finally {
      setFetching(false)
    }
  }

  const pick = async () => {
    setNote(null)
    if (!isTauri()) {
      setNote({ ok: false, text: t("play.rooms.desktopOnly") })
      return
    }
    const path = await pickSaveSource(t("play.rooms.fileFilter"))
    if (path === null) return
    try {
      setPicked({ path, file: await savePrepare(path) })
    } catch (error) {
      setNote({ ok: false, text: saveErrorText(error, t, baseName(path)) })
    }
  }

  const importRoom = async () => {
    if (picked === null || connection === null) return
    const { path, file } = picked
    setPicked(null)
    setNote(null)
    setSending(true)
    let hash: string
    try {
      hash = (await uploadSave(connection, path, file)).hash
    } catch (error) {
      // Refused or broken before the room was touched: the server's words, or this client's.
      setNote({ ok: false, text: saveErrorText(error, t, file.name) })
      return
    } finally {
      setSending(false)
    }
    await importer.run("save", { op: "import", file: hash })
  }

  const busyOut = !online || exporter.pending || fetching
  const busyIn = !online || importer.pending || sending
  return (
    <div className="room-op">
      <h4>{t("play.rooms.saveTitle")}</h4>
      <p className="studio-hint">{t("play.rooms.exportHint")}</p>
      <button type="button" className="ghost-button" disabled={busyOut} onClick={() => void exportRoom()}>
        {fetching ? t("play.rooms.fetching") : t("play.rooms.export")}
      </button>
      <CommandFeedback feedback={exporter.feedback} onDismiss={exporter.dismiss} />
      <p className="studio-hint">{t("play.rooms.importHint", { mb: SAVE_LIMIT_MB })}</p>
      {picked === null ? (
        <button type="button" className="ghost-button" disabled={busyIn} onClick={() => void pick()}>
          {sending ? t("play.rooms.sending") : t("play.rooms.import")}
        </button>
      ) : (
        <div className="room-danger" role="alert">
          <p>
            {t("play.rooms.importWarning", {
              name: stripControlChars(picked.file.name),
              size: sizeLabel(picked.file.size),
            })}
          </p>
          <div className="chip-row">
            <button
              type="button"
              className="primary-button"
              disabled={busyIn}
              onClick={() => void importRoom()}
            >
              {t("play.rooms.importConfirm")}
            </button>
            <button type="button" className="ghost-button" onClick={() => setPicked(null)}>
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
  const canSave = useCommand("save", ["op", "file"]) !== null
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
