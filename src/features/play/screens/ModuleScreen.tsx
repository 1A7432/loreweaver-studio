// Import module — the TUI KeeperModule pair of flows: install from a server
// path (`.module <path>` over the input channel; the reply is a system line in
// the chronicle) and describe→generate via the forge (admin_generate, answered
// by admin_generated with the per-room install outcome in `detail`) — plus the
// community-pack entry: installing a whole published work is the person who
// opened the table doing it, not the author in Studio, so `.pack install <ref>`
// goes out from HERE, as ordinary command text over the same input channel.
// Everything the player is told about the result — what it installed, what it
// is allowed to do — is the server's receipt; this screen invents none of it.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { transportSend } from "../../../lib/transport"
import { useAdminStore } from "../../../store/admin"
import { useConnectionStore } from "../../../store/connection"
import ScreenShell from "./ScreenShell"

export default function ModuleScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const generated = useAdminStore((s) => s.generated)
  const busy = useAdminStore((s) => s.busy)
  const generateModule = useAdminStore((s) => s.generateModule)

  const isKeeper = useConnectionStore((s) => s.welcome?.you.role === "keeper")

  const [path, setPath] = useState("")
  const [description, setDescription] = useState("")
  const [pathSent, setPathSent] = useState(false)
  const [packRef, setPackRef] = useState("")
  const [packSent, setPackSent] = useState(false)

  const install = () => {
    const value = path.trim()
    if (!value) return
    void transportSend({ type: "input", text: `.module ${value}` }).catch(() => {})
    setPathSent(true)
    setPath("")
  }

  const installPack = () => {
    const value = packRef.trim()
    if (!value) return
    void transportSend({ type: "input", text: `.pack install ${value}` }).catch(() => {})
    setPackSent(true)
    setPackRef("")
  }

  return (
    <ScreenShell title={t("play.menu.module")} onBack={onBack} showAdminError>
      <div className="play-form">
        <label className="field">
          {t("play.module.path")}
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("play.module.pathPlaceholder")}
            spellCheck={false}
          />
        </label>
        <button type="button" className="primary-button" disabled={!path.trim()} onClick={install}>
          {t("play.module.install")}
        </button>
        {pathSent ? <p className="studio-hint">{t("play.module.sent")}</p> : null}
      </div>

      {isKeeper ? (
        <div className="play-form">
          <h3 className="play-form-title">{t("play.pack.title")}</h3>
          <label className="field">
            {t("play.pack.ref")}
            <input
              value={packRef}
              onChange={(e) => setPackRef(e.target.value)}
              placeholder={t("play.pack.refPlaceholder")}
              spellCheck={false}
            />
          </label>
          <p className="studio-hint">{t("play.pack.hint")}</p>
          <button type="button" className="primary-button" disabled={!packRef.trim()} onClick={installPack}>
            {t("play.pack.install")}
          </button>
          {packSent ? <p className="studio-hint">{t("play.pack.sent")}</p> : null}
        </div>
      ) : null}

      <div className="play-form">
        <label className="field">
          {t("play.module.describe")}
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("play.module.describePlaceholder")}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={!description.trim() || busy}
          onClick={() => generateModule(description.trim())}
        >
          {busy ? t("play.busy") : t("play.module.generate")}
        </button>
        {generated !== null && generated.kind === "module" ? (
          <p className={generated.ok ? "studio-hint" : "connect-error"} role="status">
            {generated.ok
              ? t("play.module.generateOk", { name: generated.name, detail: generated.detail })
              : t("play.module.generateError", { error: generated.error })}
          </p>
        ) : null}
      </div>
    </ScreenShell>
  )
}
