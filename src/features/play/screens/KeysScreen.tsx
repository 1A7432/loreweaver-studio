// The room admin's access keys: this room's keys (the `admin/keys` view, subscribed only while
// this screen is open) and the `key` command for each change — mint, rename, change the role,
// revoke. A key just minted comes back in that one answer and nowhere else, ever: it is shown on
// its own panel, once, beside the ticket this client connected with (what the holder needs to
// join), and lives in that panel's state until it is dismissed or the screen is left — never in
// a store, the log or the console. The answer's own text carries the key too, so it is never
// shown as feedback.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars, type AdminKeysView, type Result, type Role } from "loreweaver-protocol/v3"
import { useConnection } from "../../../store/connection"
import CommandFeedback from "../CommandFeedback"
import { feedbackOf, useCommand, useOnline, useView, useViews, type Feedback } from "../room"
import ScreenShell from "./ScreenShell"

const ROLES: readonly Role[] = ["player", "admin", "observer"]
type KeyRow = AdminKeysView["keys"][number]

/** A key just minted, held by the panel that shows it and by nothing else. */
interface Minted {
  readonly name: string
  readonly role: Role
  readonly key: string
}

/** The new key out of a `key mint` answer's data (never its text). */
function mintedFrom(data: unknown, name: string, role: Role): Minted | null {
  if (typeof data !== "object" || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record.key !== "string" || record.key === "") return null
  const said = record.role
  return {
    name: typeof record.name === "string" ? record.name : name,
    role: said === "player" || said === "admin" || said === "observer" ? said : role,
    key: record.key,
  }
}

function MintedPanel({ minted, ticket, onDone }: { minted: Minted; ticket: string; onDone: () => void }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState<"key" | "ticket" | null>(null)
  const copy = (what: "key" | "ticket", text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(what))
      .catch(() => setCopied(null))
  }
  return (
    <div className="play-minted" role="region" aria-label={t("play.keys.mintedTitle")}>
      <p>
        {t("play.keys.mintedOnce", {
          name: stripControlChars(minted.name),
          role: t(`connect.role.${minted.role}`),
        })}
      </p>
      <p className="play-form-title">{t("play.keys.key")}</p>
      <code className="play-minted-key" data-testid="minted-key">
        {minted.key}
      </code>
      <button type="button" className="ghost-button" onClick={() => copy("key", minted.key)}>
        {copied === "key" ? t("play.keys.copied") : t("play.keys.copy")}
      </button>
      <p className="play-form-title">{t("play.keys.ticket")}</p>
      <code className="play-minted-key">{ticket}</code>
      <button type="button" className="ghost-button" onClick={() => copy("ticket", ticket)}>
        {copied === "ticket" ? t("play.keys.copied") : t("play.keys.copy")}
      </button>
      <button type="button" className="primary-button" onClick={onDone}>
        {t("play.keys.done")}
      </button>
    </div>
  )
}

function KeyLine({
  entry,
  busy,
  run,
}: {
  entry: KeyRow
  busy: boolean
  run: (args: Record<string, unknown>) => void
}) {
  const { t } = useTranslation()
  const online = useOnline()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const name = stripControlChars(entry.name)
  return (
    <tr>
      <td>
        {renaming === null ? (
          name
        ) : (
          <input
            value={renaming}
            aria-label={t("play.keys.newName", { name })}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                setRenaming(null)
              }
              if (e.key === "Enter" && renaming.trim() !== "") {
                run({ op: "rename", id: entry.id, name: renaming.trim() })
                setRenaming(null)
              }
            }}
          />
        )}
        {entry.online ? <span className="desk-tag">{t("play.keys.online")}</span> : null}
      </td>
      <td>
        <select
          value={entry.role}
          disabled={!online || busy}
          aria-label={t("play.keys.roleOf", { name })}
          onChange={(e) => run({ op: "role", id: entry.id, role: e.target.value })}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {t(`connect.role.${role}`)}
            </option>
          ))}
        </select>
      </td>
      <td>
        <code>{stripControlChars(entry.masked)}</code>
      </td>
      <td>
        {renaming === null ? (
          <button
            type="button"
            className="ghost-button"
            disabled={!online || busy}
            onClick={() => setRenaming(name)}
          >
            {t("play.keys.rename")}
          </button>
        ) : null}
        {confirmRevoke ? (
          <>
            <button
              type="button"
              className="primary-button"
              disabled={!online || busy}
              onClick={() => {
                run({ op: "revoke", id: entry.id })
                setConfirmRevoke(false)
              }}
            >
              {t("play.keys.revokeConfirm", { name })}
            </button>
            <button type="button" className="ghost-button" onClick={() => setConfirmRevoke(false)}>
              {t("play.keys.keep")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ghost-button"
            disabled={!online || busy}
            onClick={() => setConfirmRevoke(true)}
          >
            {t("play.keys.revoke")}
          </button>
        )}
      </td>
    </tr>
  )
}

export default function KeysScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  useViews(["admin/keys"])
  const connection = useConnection()
  const keys = useView("admin/keys")?.keys ?? []
  const online = useOnline()
  const usable = useCommand("key", ["op", "id", "name", "role"]) !== null
  const [name, setName] = useState("")
  const [role, setRole] = useState<Role>("player")
  const [minted, setMinted] = useState<Minted | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [busy, setBusy] = useState(false)

  const send = async (args: Record<string, unknown>): Promise<Result | null> => {
    if (connection === null) return null
    setBusy(true)
    setFeedback(null)
    try {
      return await connection.session.runCommand("key", args)
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "failed"
      setFeedback(feedbackOf({ failed: code }))
      return null
    } finally {
      setBusy(false)
    }
  }

  const change = (args: Record<string, unknown>) => {
    void send(args).then((result) => {
      if (result !== null) setFeedback(feedbackOf(result))
    })
  }

  const mint = async () => {
    const wanted = name.trim()
    if (wanted === "") return
    const result = await send({ op: "mint", name: wanted, role })
    if (result === null) return
    if (!result.ok) {
      setFeedback(feedbackOf(result))
      return
    }
    // The answer's text holds the key as well: only the data is read, and only this panel shows it.
    const made = mintedFrom(result.data, wanted, role)
    if (made !== null) {
      setMinted(made)
      setName("")
    }
  }

  return (
    <ScreenShell title={t("play.menu.keys")} onBack={onBack}>
      {!usable ? <p className="placeholder">{t("play.admin.unavailable")}</p> : null}
      {minted !== null && connection !== null ? (
        <MintedPanel minted={minted} ticket={connection.ticket} onDone={() => setMinted(null)} />
      ) : null}
      {usable ? (
        <>
          <div className="play-form">
            <h4 className="play-form-title">{t("play.keys.mintTitle")}</h4>
            <div className="play-mint-row">
              <label className="field">
                {t("play.keys.name")}
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                {t("play.keys.role")}
                <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {ROLES.map((entry) => (
                    <option key={entry} value={entry}>
                      {t(`connect.role.${entry}`)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="primary-button"
                disabled={!online || busy || name.trim() === ""}
                onClick={() => void mint()}
              >
                {t("play.keys.mint")}
              </button>
            </div>
            <p className="studio-hint">{t("play.keys.mintHint")}</p>
          </div>
          <CommandFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />
          {keys.length === 0 ? (
            <p className="placeholder">{t("play.keys.empty")}</p>
          ) : (
            <table className="play-table">
              <thead>
                <tr>
                  <th>{t("play.keys.name")}</th>
                  <th>{t("play.keys.role")}</th>
                  <th>{t("play.keys.key")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((entry) => (
                  <KeyLine key={entry.id} entry={entry} busy={busy} run={change} />
                ))}
              </tbody>
            </table>
          )}
          <p className="studio-hint">{t("play.keys.revokeHint")}</p>
        </>
      ) : null}
    </ScreenShell>
  )
}
