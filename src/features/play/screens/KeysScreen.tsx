// Rooms & invites — the TUI KeeperKeys screen's core loop: list every key,
// mint a new invite (the cleartext arrives exactly ONCE and is shown with a
// copy button), tweak a key's role inline, delete. Room-level operations
// (backup / restore / reset / delete, and the server's self-update) live in
// `RoomLifecycle` below the roster.

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { PlayerRole } from "@loreweaver/protocol"
import { useAdminStore } from "../../../store/admin"
import { useConnectionStore } from "../../../store/connection"
import RoomLifecycle from "./RoomLifecycle"
import ScreenShell from "./ScreenShell"

export default function KeysScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const keys = useAdminStore((s) => s.keys)
  const minted = useAdminStore((s) => s.minted)
  const listKeys = useAdminStore((s) => s.listKeys)
  const mintKey = useAdminStore((s) => s.mintKey)
  const updateKey = useAdminStore((s) => s.updateKey)
  const deleteKey = useAdminStore((s) => s.deleteKey)
  const clearMinted = useAdminStore((s) => s.clearMinted)
  const room = useConnectionStore((s) => s.welcome?.room ?? "")

  const [name, setName] = useState("")
  const [role, setRole] = useState<PlayerRole>("player")
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    listKeys()
    return () => clearMinted()
  }, [listKeys, clearMinted])

  const mint = () => {
    if (!name.trim()) return
    setCopied(false)
    mintKey(room, name.trim(), role)
    setName("")
  }

  const copyMinted = async () => {
    if (minted === null) return
    try {
      await navigator.clipboard.writeText(minted.key)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <ScreenShell title={t("play.menu.keys")} onBack={onBack} showAdminError>
      <div className="play-mint-row">
        <label className="field">
          {t("play.keys.name")}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field field-narrow">
          {t("play.keys.role")}
          <select value={role} onChange={(e) => setRole(e.target.value as PlayerRole)}>
            <option value="player">{t("play.menu.role.player")}</option>
            <option value="keeper">{t("play.menu.role.keeper")}</option>
          </select>
        </label>
        <button type="button" className="primary-button" disabled={!name.trim()} onClick={mint}>
          {t("play.keys.mint")}
        </button>
      </div>

      {minted !== null ? (
        <div className="play-minted" role="status">
          <p>{t("play.keys.mintedOnce", { name: minted.name })}</p>
          <code className="play-minted-key">{minted.key}</code>
          <button type="button" className="ghost-button" onClick={() => void copyMinted()}>
            {copied ? t("play.keys.copied") : t("play.keys.copy")}
          </button>
        </div>
      ) : null}

      <table className="play-table">
        <thead>
          <tr>
            <th>{t("play.keys.name")}</th>
            <th>{t("play.keys.room")}</th>
            <th>{t("play.keys.role")}</th>
            <th>{t("play.keys.key")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id}>
              <td>{key.name}</td>
              <td>{key.room}</td>
              <td>
                <select
                  value={key.role}
                  aria-label={t("play.keys.role")}
                  onChange={(e) => updateKey(key.id, { role: e.target.value as PlayerRole })}
                >
                  <option value="player">{t("play.menu.role.player")}</option>
                  <option value="keeper">{t("play.menu.role.keeper")}</option>
                </select>
              </td>
              <td>
                <code>{key.key_masked}</code>
              </td>
              <td>
                <button type="button" className="ghost-button" onClick={() => deleteKey(key.id)}>
                  {t("play.keys.delete")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {keys.length === 0 ? <p className="placeholder">{t("play.keys.empty")}</p> : null}

      <RoomLifecycle />
    </ScreenShell>
  )
}
