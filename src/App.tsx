import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import PlayView from "./features/play/PlayView"
import StudioView from "./features/studio/StudioView"
import UndoToast from "./features/studio/UndoToast"
import { usePersistenceDegraded } from "./lib/persistStorage"
import { isTauri, onLinkEvent } from "./lib/transport"
import { useAppStore, type AppMode } from "./store/app"
import { armGestureUnlock } from "./store/audio"
import { useConnectionStore } from "./store/connection"

const MODES: AppMode[] = ["play", "studio"]

export default function App() {
  const { t, i18n } = useTranslation()
  const mode = useAppStore((s) => s.mode)
  const setMode = useAppStore((s) => s.setMode)
  const persistFailed = usePersistenceDegraded()

  useEffect(() => {
    if (!isTauri()) return
    // The link's events go to the connection owner, and nowhere else: frames are
    // the protocol session's to read (the 2.x frame router into the old stores is
    // gone — those stores are migrated to 3.0 in later steps).
    const unlisten = onLinkEvent((event) => useConnectionStore.getState().handleEvent(event))
    return () => {
      void unlisten.then((dispose) => dispose())
    }
  }, [])

  // A gesture anywhere in the window starts the sound the WebView refused to start;
  // armed at the root so a click on the mode tab or the menu counts too.
  useEffect(() => armGestureUnlock(), [])

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
          {/* i18n-exempt: a language is offered in its OWN name, never translated. */}
          <option value="zh">中文</option>
        </select>
      </header>
      {persistFailed ? (
        <p className="persist-banner" role="alert">
          {t("app.persistDegraded")}
        </p>
      ) : null}
      <main className="app-main">{mode === "play" ? <PlayView /> : <StudioView />}</main>
      {/* App-root: a deletion made in one view stays undoable after switching to another. */}
      <UndoToast />
    </div>
  )
}
