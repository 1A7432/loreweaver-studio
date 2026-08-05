// My character — a read-only full-sheet view of the live CharacterState
// (meters, every attribute, status effects). Creation and point-buy stay in
// the TUI's guided flow for now; this screen is the sheet you check mid-game.

import { useTranslation } from "react-i18next"
import { stripControlChars } from "@loreweaver/protocol"
import { useSessionStore } from "../../../store/session"
import Meter from "../Meter"
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
            <Meter label="HP" value={character.hp} max={character.hpmax} tone="hp" />
            {character.mpmax > 0 ? (
              <Meter label="MP" value={character.mp} max={character.mpmax} tone="mp" />
            ) : null}
            {character.sanmax > 0 ? (
              <Meter label="SAN" value={character.san} max={character.sanmax} tone="san" />
            ) : null}
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
