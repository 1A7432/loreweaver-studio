// Shared chrome for every play screen off the main menu: title row, back
// button (Esc also works — PlayView owns that listener), and the admin error
// line every keeper screen needs.

import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useAdminStore } from "../../../store/admin"

export default function ScreenShell({
  title,
  onBack,
  children,
  showAdminError = false,
}: {
  title: string
  onBack: () => void
  children: ReactNode
  showAdminError?: boolean
}) {
  const { t } = useTranslation()
  const lastError = useAdminStore((s) => s.lastError)
  const busy = useAdminStore((s) => s.busy)
  return (
    <div className="play-screen">
      <header className="play-screen-head">
        <button type="button" className="ghost-button" onClick={onBack}>
          {t("play.back")}
        </button>
        <h2>{title}</h2>
        {showAdminError && busy ? <span className="play-busy">{t("play.busy")}</span> : null}
      </header>
      {showAdminError && lastError !== null ? (
        <p className="connect-error" role="alert">
          {lastError}
        </p>
      ) : null}
      <div className="play-screen-body">{children}</div>
    </div>
  )
}
