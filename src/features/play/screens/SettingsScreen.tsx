// Settings — the TUI's theme cycle (F1–F5 order, lamplight first) as swatch
// cards, plus the language switch. The theme applies app-wide instantly and
// persists across restarts.

import { useTranslation } from "react-i18next"
import { themeOrder, themes } from "../../../lib/themes"
import { useAppStore } from "../../../store/app"
import ScreenShell from "./ScreenShell"

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)

  return (
    <ScreenShell title={t("play.menu.settings")} onBack={onBack}>
      <p className="studio-hint">{t("play.settings.themeHint")}</p>
      <div className="play-theme-grid">
        {themeOrder.map((name, index) => {
          const palette = themes[name]
          return (
            <button
              key={name}
              type="button"
              className={name === theme ? "play-theme-card active" : "play-theme-card"}
              style={{ background: palette.bg, color: palette.fg, borderColor: palette.border }}
              onClick={() => setTheme(name)}
            >
              <span className="play-theme-slot">F{index + 1}</span>
              <span className="play-theme-name" style={{ color: palette.accent }}>
                {t(`play.settings.themes.${name}`)}
              </span>
              <span className="play-theme-swatches" aria-hidden="true">
                {[
                  palette.accent,
                  palette.kp,
                  palette.player,
                  palette.npc,
                  palette.success,
                  palette.fumble,
                ].map((color, i) => (
                  <i key={i} style={{ background: color }} />
                ))}
              </span>
            </button>
          )
        })}
      </div>

      <label className="field field-narrow">
        {t("lang.label")}
        <select value={i18n.language} onChange={(e) => void i18n.changeLanguage(e.target.value)}>
          <option value="en">English</option>
          {/* i18n-exempt: a language is offered in its OWN name, never translated. */}
          <option value="zh">中文</option>
        </select>
      </label>
    </ScreenShell>
  )
}
