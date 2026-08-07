// My character — a read-only full-sheet view of the live CharacterState
// (meters, every attribute, status effects). Creation and point-buy stay in
// the TUI's guided flow for now; this screen is the sheet you check mid-game.

import { useTranslation } from "react-i18next"
import { stripControlChars } from "@loreweaver/protocol"
import { useSessionStore } from "../../../store/session"
import { ResourceRow } from "../StatePanel"
import ScreenShell from "./ScreenShell"

function attrText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return stripControlChars(String(value))
}

export default function CharacterScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const character = useSessionStore((s) => s.game?.character ?? null)

  return (
    <ScreenShell title={t("play.menu.character")} onBack={onBack}>
      {character === null ? (
        <p className="placeholder">{t("play.character.none")}</p>
      ) : (
        <div className="play-character">
          <h3>
            {stripControlChars(character.name)}
            <span className="desk-tag">{stripControlChars(character.system)}</span>
          </h3>
          <div className="play-character-meters">
            {character.resources.map((resource) => (
              <ResourceRow key={resource.id} resource={resource} />
            ))}
          </div>
          {character.status_effects.length > 0 ? (
            <div className="chip-row">
              {character.status_effects.map((effect) => (
                <span key={effect} className="chip">
                  {stripControlChars(effect)}
                </span>
              ))}
            </div>
          ) : null}
          <table className="play-table">
            <tbody>
              {Object.entries(character.attributes).map(([key, value]) => (
                <tr key={key}>
                  <td className="play-attr-name">{stripControlChars(key)}</td>
                  <td>{attrText(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="studio-hint">{t("play.character.readonlyHint")}</p>
        </div>
      )}
    </ScreenShell>
  )
}
