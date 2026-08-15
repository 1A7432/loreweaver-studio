// Room lifecycle: backup, restore, reset, delete — and the server's own
// self-update.
//
// `store/admin.ts` has ingested `admin_room_op` / `admin_update` replies since
// the beginning; nothing ever SENT the requests, so the whole family lived only
// in the TUI. These are the frames `docs/protocol.md` defines, consumed as
// written:
//   - `admin_export_room` writes a backup JSON server-side; omitting `path`
//     lets the server choose, under `<data_dir>/room_backups/`.
//   - `admin_import_room` restores one INTO THE CALLER'S OWN ROOM. There is no
//     remap: `net/admin.py::_import_room` refuses a `room` that is not the
//     caller's with `forbidden`, and `import_room` additionally requires the
//     file to be a backup of that same room. So the request carries no room.
//   - `admin_reset_room` restarts a campaign IN PLACE — keys, bindings, live
//     connections and room settings survive, no backup is taken, nobody is
//     evicted. `scope` decides how much of the campaign goes.
//   - `admin_delete_room` deletes the room's KEYS and leaves its data alone;
//     `admin_delete_room_data` is the other half, and takes a backup first
//     unless told not to.
//   - `admin_update_server` runs the OPERATOR's configured command and re-execs,
//     so it is gated on the `"update"` feature the welcome advertises.
//
// Every destructive control makes the operator type the room name first. Not a
// modal with an OK button: the thing being destroyed has a name, and typing it
// is the cheapest way to be sure the right one is in front of you.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { AdminResetScope } from "@loreweaver/protocol"
import { useAdminStore } from "../../../store/admin"
import { useConnectionStore } from "../../../store/connection"

const RESET_SCOPES: AdminResetScope[] = ["story", "chars", "all"]

/** A destructive action behind the room's own name. */
function DangerAction({
  room,
  label,
  hint,
  confirmLabel,
  onConfirm,
  children,
}: {
  room: string
  label: string
  hint: string
  confirmLabel: string
  onConfirm: () => void
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  const [typed, setTyped] = useState("")
  const armed = typed.trim() === room && room !== ""

  return (
    <div className="room-danger">
      <h4>{label}</h4>
      <p className="studio-hint">{hint}</p>
      {children}
      <div className="dialog-row">
        <label className="field">
          {t("play.rooms.typeName", { room })}
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={room}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          disabled={!armed}
          onClick={() => {
            onConfirm()
            setTyped("")
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}

export default function RoomLifecycle() {
  const { t } = useTranslation()
  const welcome = useConnectionStore((s) => s.welcome)
  const room = welcome?.room ?? ""
  const admin = useAdminStore()

  const [exportPath, setExportPath] = useState("")
  const [importPath, setImportPath] = useState("")
  const [scope, setScope] = useState<AdminResetScope>("story")
  const [backupBeforeDelete, setBackupBeforeDelete] = useState(true)

  const canUpdate = (welcome?.features ?? []).includes("update")

  return (
    <section className="play-room-lifecycle" aria-label={t("play.rooms.title")}>
      <h3>{t("play.rooms.title")}</h3>
      <p className="studio-hint">{t("play.rooms.hint", { room })}</p>

      {admin.roomOp !== null ? (
        <p className="studio-notice" role="status">
          {t(`play.rooms.done.${admin.roomOp.action}`, {
            room: admin.roomOp.room,
            keys: admin.roomOp.keys,
            rows: admin.roomOp.store_rows,
            points: admin.roomOp.vector_points,
            media: admin.roomOp.media_files ?? 0,
            scope: admin.roomOp.scope ?? "",
            path: admin.roomOp.path ?? "",
          })}{" "}
          <button type="button" className="ghost-button" onClick={() => admin.clearRoomOp()}>
            {t("play.rooms.dismiss")}
          </button>
        </p>
      ) : null}
      {admin.serverUpdate !== null ? (
        <p
          className={
            admin.serverUpdate.status === "restarting" ? "studio-notice" : "studio-notice split-error"
          }
          role="status"
        >
          {admin.serverUpdate.status === "restarting"
            ? t("play.rooms.updateRestarting")
            : t("play.rooms.updateFailed", { output: admin.serverUpdate.output ?? "" })}
        </p>
      ) : null}

      <div className="room-op">
        <h4>{t("play.rooms.backup")}</h4>
        <p className="studio-hint">{t("play.rooms.backupHint")}</p>
        <div className="dialog-row">
          <label className="field">
            {t("play.rooms.path")}
            <input
              value={exportPath}
              onChange={(e) => setExportPath(e.target.value)}
              placeholder={t("play.rooms.pathServerDefault")}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="ghost-button"
            disabled={admin.busy || !room}
            onClick={() => admin.exportRoom(room, exportPath.trim() || undefined)}
          >
            {t("play.rooms.export")}
          </button>
        </div>
      </div>

      <DangerAction
        room={room}
        label={t("play.rooms.restore")}
        hint={t("play.rooms.restoreHint")}
        confirmLabel={t("play.rooms.restoreConfirm")}
        onConfirm={() => admin.importRoom(importPath.trim())}
      >
        <div className="dialog-row">
          <label className="field">
            {t("play.rooms.path")}
            <input
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              placeholder="/…/room_backups/table-2026-08-15.json"
              spellCheck={false}
            />
          </label>
        </div>
      </DangerAction>

      <DangerAction
        room={room}
        label={t("play.rooms.reset")}
        hint={t(`play.rooms.resetHint.${scope}`)}
        confirmLabel={t("play.rooms.resetConfirm")}
        onConfirm={() => admin.resetRoom(room, scope)}
      >
        <label className="field field-narrow">
          {t("play.rooms.scope")}
          <select value={scope} onChange={(e) => setScope(e.target.value as AdminResetScope)}>
            {RESET_SCOPES.map((value) => (
              <option key={value} value={value}>
                {t(`play.rooms.scopes.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <p className="studio-hint">{t("play.rooms.resetKeepsHint")}</p>
      </DangerAction>

      <DangerAction
        room={room}
        label={t("play.rooms.deleteData")}
        hint={t("play.rooms.deleteDataHint")}
        confirmLabel={t("play.rooms.deleteDataConfirm")}
        onConfirm={() => admin.deleteRoomData(room, backupBeforeDelete)}
      >
        <label className="pack-checkbox">
          <input
            type="checkbox"
            checked={backupBeforeDelete}
            onChange={(e) => setBackupBeforeDelete(e.target.checked)}
          />
          {t("play.rooms.backupFirst")}
        </label>
        {!backupBeforeDelete ? (
          <p className="studio-hint split-error">{t("play.rooms.noBackupWarning")}</p>
        ) : null}
      </DangerAction>

      <DangerAction
        room={room}
        label={t("play.rooms.deleteKeys")}
        hint={t("play.rooms.deleteKeysHint")}
        confirmLabel={t("play.rooms.deleteKeysConfirm")}
        onConfirm={() => admin.deleteRoom(room)}
      />

      <div className="room-op">
        <h4>{t("play.rooms.selfUpdate")}</h4>
        <p className="studio-hint">
          {canUpdate ? t("play.rooms.selfUpdateHint") : t("play.rooms.selfUpdateUnavailable")}
        </p>
        <button
          type="button"
          className="ghost-button"
          disabled={!canUpdate || admin.busy}
          onClick={() => {
            if (window.confirm(t("play.rooms.selfUpdateConfirm"))) admin.updateServer()
          }}
        >
          {t("play.rooms.selfUpdateRun")}
        </button>
      </div>
    </section>
  )
}
