// The main menu — the TUI's MainMenu, pixel-for-idea: the die glyph ⚄ as the
// selection cursor (the dice-first signature, not a generic ▶), Quit last and
// visually separated. The right-hand side keeps the same desk cards as the game.
//
// It links only to screens that work on protocol 3.0: the game, the character
// screen and the client's own settings. The room admin's screens (keys, model,
// packs, rule systems, skills, the room's lifecycle) come back as they move.

import { useTranslation } from "react-i18next"
import { useSessionSnapshot } from "../../../store/connection"
import { quitTable } from "../../../store/hostLocal"
import StatePanel from "../StatePanel"
import StatusPill from "../StatusPill"
import type { PlayScreen } from "../OnlineView"

const ROWS: readonly { key: string; screen: PlayScreen }[] = [
  { key: "enterGame", screen: "game" },
  { key: "character", screen: "character" },
  { key: "report", screen: "report" },
  { key: "settings", screen: "settings" },
]

const ADMIN_ROWS: readonly { key: string; screen: PlayScreen }[] = [
  { key: "keys", screen: "keys" },
  { key: "model", screen: "model" },
  { key: "content", screen: "content" },
  { key: "room", screen: "room" },
]

export default function MainMenuScreen({ onNavigate }: { onNavigate: (screen: PlayScreen) => void }) {
  const { t } = useTranslation()
  const welcome = useSessionSnapshot()?.welcome ?? null

  return (
    <div className="play-menu">
      <div className="play-menu-list" role="menu" aria-label={t("play.menu.label")}>
        <p className="play-menu-table">
          {t("play.menu.table", { room: welcome?.room.id ?? "…" })}
          {welcome ? (
            <span className="play-menu-who">
              {" · "}
              {welcome.you.name}
              {" · "}
              {t(`connect.role.${welcome.you.role}`)}
            </span>
          ) : null}{" "}
          <StatusPill />
        </p>
        {[...ROWS, ...(welcome?.you.role === "admin" ? ADMIN_ROWS : [])].map((row) => (
          <button
            key={row.key}
            type="button"
            role="menuitem"
            className="play-menu-item"
            onClick={() => onNavigate(row.screen)}
          >
            <span className="play-menu-cursor" aria-hidden="true">
              ⚄
            </span>
            {t(`play.menu.${row.key}`)}
          </button>
        ))}
        <div className="play-menu-quit">
          <button type="button" className="play-menu-item" onClick={() => void quitTable()}>
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
