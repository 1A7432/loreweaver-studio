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

/** Nothing typed yet / the line reached the transport / it never left. */
type SendStatus = "idle" | "sent" | "failed"

export default function ModuleScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const generated = useAdminStore((s) => s.generated)
  const busy = useAdminStore((s) => s.busy)
  const generateModule = useAdminStore((s) => s.generateModule)

  const isKeeper = useConnectionStore((s) => s.welcome?.you.role === "keeper")

  const [path, setPath] = useState("")
  const [description, setDescription] = useState("")
  const [packRef, setPackRef] = useState("")
  // A send that never left the app must not say "submitted": the reply this
  // screen promises comes from the server, and there is no server in that case.
  // A failed send keeps what was typed, so the retry is one click.
  const [pathStatus, setPathStatus] = useState<SendStatus>("idle")
  const [packStatus, setPackStatus] = useState<SendStatus>("idle")

  const send = async (line: string, mark: (status: SendStatus) => void, clear: () => void): Promise<void> => {
    mark("idle")
    try {
      await transportSend({ type: "input", text: line })
    } catch {
      mark("failed")
      return
    }
    mark("sent")
    clear()
  }

  const install = () => {
    const value = path.trim()
    if (!value) return
    void send(`.module ${value}`, setPathStatus, () => setPath(""))
  }

  const installPack = () => {
    const value = packRef.trim()
    if (!value) return
    void send(`.pack install ${value}`, setPackStatus, () => setPackRef(""))
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
        {pathStatus === "sent" ? <p className="studio-hint">{t("play.module.sent")}</p> : null}
        {pathStatus === "failed" ? (
          <p className="connect-error" role="status">
            {t("play.sendFailed")}
          </p>
        ) : null}
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
          {packStatus === "sent" ? <p className="studio-hint">{t("play.pack.sent")}</p> : null}
          {packStatus === "failed" ? (
            <p className="connect-error" role="status">
              {t("play.sendFailed")}
            </p>
          ) : null}
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
