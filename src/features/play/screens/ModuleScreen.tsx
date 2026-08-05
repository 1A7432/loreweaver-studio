// Import module — the TUI KeeperModule pair of flows: install from a server
// path (`.module <path>` over the input channel; the reply is a system line in
// the chronicle) and describe→generate via the forge (admin_generate, answered
// by admin_generated with the per-room install outcome in `detail`).

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { transportSend } from "../../../lib/transport"
import { useAdminStore } from "../../../store/admin"
import ScreenShell from "./ScreenShell"

export default function ModuleScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const generated = useAdminStore((s) => s.generated)
  const busy = useAdminStore((s) => s.busy)
  const generateModule = useAdminStore((s) => s.generateModule)

  const [path, setPath] = useState("")
  const [description, setDescription] = useState("")
  const [pathSent, setPathSent] = useState(false)

  const install = () => {
    const value = path.trim()
    if (!value) return
    void transportSend({ type: "input", text: `.module ${value}` }).catch(() => {})
    setPathSent(true)
    setPath("")
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
