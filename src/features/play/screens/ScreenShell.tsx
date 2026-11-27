// Shared chrome for every play screen off the main menu: title row and back button (Esc also
// works — `OnlineView` owns that listener).

import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

export default function ScreenShell({
  title,
  onBack,
  children,
}: {
  title: string
  onBack: () => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="play-screen">
      <header className="play-screen-head">
        <button type="button" className="ghost-button" onClick={onBack}>
          {t("play.back")}
        </button>
        <h2>{title}</h2>
      </header>
      <div className="play-screen-body">{children}</div>
    </div>
  )
}
