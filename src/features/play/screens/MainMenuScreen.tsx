// The main menu — the TUI's MainMenu, pixel-for-idea: the die glyph ⚄ as the
// selection cursor (the dice-first signature, not a generic ▶), the keeper
// section fenced off below the player rows, Quit last and visually separated.
// The right-hand side keeps the same character/party/scene panels as the game.

import { useTranslation } from "react-i18next"
import { transportSend } from "../../../lib/transport"
import { useConnectionStore } from "../../../store/connection"
import StatePanel from "../StatePanel"
import StatusPill from "../StatusPill"
import type { PlayScreen } from "../PlayView"

interface MenuRow {
  key: string
  screen?: PlayScreen
  action?: () => void
  keeper: boolean
}

export default function MainMenuScreen({ onNavigate }: { onNavigate: (screen: PlayScreen) => void }) {
  const { t } = useTranslation()
  const welcome = useConnectionStore((s) => s.welcome)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const isKeeper = welcome?.you.role === "keeper"
  const hasDemo = isKeeper && (welcome?.features ?? []).includes("demo")

  const startDemo = () => {
    // The server's demo responder treats this exact localized, human-readable
    // action as one guided transaction (same string the TUI sends).
    void transportSend({ type: "input", text: t("play.menu.demoAction") }).catch(() => {})
    onNavigate("game")
  }

  const rows: MenuRow[] = []
  if (hasDemo) rows.push({ key: "demo", action: startDemo, keeper: false })
  rows.push(
    { key: "enterGame", screen: "game", keeper: false },
    { key: "character", screen: "character", keeper: false },
    { key: "settings", screen: "settings", keeper: false },
  )
  if (isKeeper) {
    rows.push(
      { key: "keys", screen: "keys", keeper: true },
      { key: "module", screen: "module", keeper: true },
      { key: "rules", screen: "rules", keeper: true },
      { key: "skills", screen: "skills", keeper: true },
      { key: "model", screen: "model", keeper: true },
    )
  }

  const firstKeeper = rows.findIndex((row) => row.keeper)

  return (
    <div className="play-menu">
      <div className="play-menu-list" role="menu" aria-label={t("play.menu.label")}>
        <p className="play-menu-table">
          {t("play.menu.table", { room: welcome?.room ?? "…" })}
          <span className="play-menu-who">
            {" · "}
            {welcome?.you.name}
            {" · "}
            {welcome?.you.role === "keeper" ? t("play.menu.role.keeper") : t("play.menu.role.player")}
          </span>{" "}
          <StatusPill />
        </p>
        {rows.map((row, index) => (
          <div key={row.key}>
            {index === firstKeeper ? (
              <p className="play-menu-section">{t("play.menu.keeperSection")}</p>
            ) : null}
            <button
              type="button"
              role="menuitem"
              className="play-menu-item"
              onClick={() => (row.action ? row.action() : row.screen ? onNavigate(row.screen) : null)}
            >
              <span className="play-menu-cursor" aria-hidden="true">
                ⚄
              </span>
              {t(`play.menu.${row.key}`)}
            </button>
          </div>
        ))}
        <div className="play-menu-quit">
          <button type="button" className="play-menu-item" onClick={() => void disconnect()}>
            <span className="play-menu-cursor" aria-hidden="true">
              ⚄
            </span>
            {t("play.menu.quit")}
          </button>
        </div>
      </div>
      <aside className="desk-pane">
        <StatePanel />
      </aside>
    </div>
  )
}
