import { useTranslation } from "react-i18next"
import { stripControlChars, type CharacterState, type StateFrame } from "@loreweaver/protocol"
import { useSessionStore } from "../../store/session"

function Meter({
  label,
  value,
  max,
  tone,
}: {
  label: string
  value: number
  max: number
  tone: "hp" | "mp" | "san" | "context"
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  return (
    <div className={`meter meter-${tone}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-track" role="presentation">
        <span className="meter-fill" style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="meter-value">
        {value}/{max}
      </span>
    </div>
  )
}

function CharacterCard({ character }: { character: CharacterState }) {
  const { t } = useTranslation()
  return (
    <section className="desk-card">
      <header className="desk-title">
        {stripControlChars(character.name)}
        <span className="desk-tag">{stripControlChars(character.system)}</span>
      </header>
      <Meter label="HP" value={character.hp} max={character.hpmax} tone="hp" />
      {character.mpmax > 0 ? <Meter label="MP" value={character.mp} max={character.mpmax} tone="mp" /> : null}
      {character.sanmax > 0 ? (
        <Meter label="SAN" value={character.san} max={character.sanmax} tone="san" />
      ) : null}
      {character.status_effects.length > 0 ? (
        <div className="chip-row">
          {character.status_effects.map((effect) => (
            <span key={effect} className="chip chip-effect">
              {stripControlChars(effect)}
            </span>
          ))}
        </div>
      ) : null}
      <span className="visually-hidden">{t("session.character")}</span>
    </section>
  )
}

function PartyCard({ game }: { game: StateFrame }) {
  const { t } = useTranslation()
  if (game.party.length === 0) return null
  return (
    <section className="desk-card">
      <header className="desk-title">{t("session.party")}</header>
      <ul className="party-list">
        {game.party.map((member) => (
          <li
            key={member.name}
            className={`party-row${member.active ? " is-active" : ""}${member.online ? "" : " is-offline"}`}
          >
            <span className={`presence-dot ${member.online ? "online" : "offline"}`} aria-hidden="true" />
            <span className="party-name">{stripControlChars(member.name)}</span>
            {member.ai ? <span className="chip chip-ai">AI</span> : null}
            {typeof member.hp === "number" && typeof member.hpMax === "number" ? (
              <span className="party-stat">
                {member.hp}/{member.hpMax}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function SceneCard({ game }: { game: StateFrame }) {
  const { t } = useTranslation()
  if (!game.scene && !game.clock) return null
  return (
    <section className="desk-card">
      <header className="desk-title">{t("session.scene")}</header>
      {game.scene ? (
        <p className="scene-line">
          {stripControlChars(game.scene.name)}
          {game.scene.focus ? (
            <span className="scene-focus"> · {stripControlChars(game.scene.focus)}</span>
          ) : null}
        </p>
      ) : null}
      {game.clock ? (
        <p className="scene-line scene-clock">
          {stripControlChars(game.clock.time)}
          {typeof game.clock.round === "number" ? ` · ${t("session.round", { n: game.clock.round })}` : ""}
        </p>
      ) : null}
    </section>
  )
}

function InitiativeCard({ game }: { game: StateFrame }) {
  const { t } = useTranslation()
  if (game.initiative.length === 0) return null
  return (
    <section className="desk-card">
      <header className="desk-title">{t("session.initiative")}</header>
      <ol className="initiative-list">
        {game.initiative.map((entry) => (
          <li key={entry.name} className={entry.current ? "is-current" : ""}>
            <span className="initiative-value">{entry.value}</span>
            {stripControlChars(entry.name)}
          </li>
        ))}
      </ol>
    </section>
  )
}

function UsageCard({ game }: { game: StateFrame }) {
  const { t } = useTranslation()
  const usage = game.usage
  if (!usage || usage.context_window <= 0) return null
  return (
    <section className="desk-card desk-card-dim">
      <Meter
        label={t("session.context")}
        value={usage.context_tokens}
        max={usage.context_window}
        tone="context"
      />
    </section>
  )
}

function PresenceCard() {
  const { t } = useTranslation()
  const presence = useSessionStore((s) => s.presence)
  if (!presence) return null
  return (
    <section className="desk-card">
      <header className="desk-title">
        {t("session.presence")}
        <span className="desk-tag">{t("session.online", { n: presence.online })}</span>
      </header>
      <ul className="party-list">
        {presence.players.map((player) => (
          <li key={player.id} className={`party-row${player.online ? "" : " is-offline"}`}>
            <span className={`presence-dot ${player.online ? "online" : "offline"}`} aria-hidden="true" />
            <span className="party-name">{stripControlChars(player.name)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function StatePanel() {
  const game = useSessionStore((s) => s.game)
  return (
    <div className="desk-stack">
      {game?.character ? <CharacterCard character={game.character} /> : null}
      {game ? <PartyCard game={game} /> : null}
      {game ? <SceneCard game={game} /> : null}
      {game ? <InitiativeCard game={game} /> : null}
      <PresenceCard />
      {game ? <UsageCard game={game} /> : null}
    </div>
  )
}
