import { useTranslation } from "react-i18next"
import { useAppStore, type AppMode } from "./store/app"

const MODES: AppMode[] = ["play", "studio"]

export default function App() {
  const { t, i18n } = useTranslation()
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">{t("app.title")}</h1>
        <nav className="mode-nav" aria-label={t("nav.label")}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={m === mode ? "mode-tab active" : "mode-tab"}
              onClick={() => setMode(m)}
            >
              {t(`nav.${m}`)}
            </button>
          ))}
        </nav>
        <div className="header-spacer" />
        <select
          className="lang-select"
          aria-label={t("lang.label")}
          value={i18n.resolvedLanguage}
          onChange={(e) => void i18n.changeLanguage(e.target.value)}
        >
          <option value="en">English</option>
          <option value="zh">中文</option>
        </select>
      </header>
      <main className="app-main">
        {mode === "play" ? (
          <p className="placeholder">{t("play.placeholder")}</p>
        ) : (
          <p className="placeholder">{t("studio.placeholder")}</p>
        )}
      </main>
    </div>
  )
}
