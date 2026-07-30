import { useTranslation } from "react-i18next"
import {
  stripControlChars,
  type CharacterState,
  type ModuleVariable,
  type StateFrame,
} from "@loreweaver/protocol"
import { useSessionStore } from "../../store/session"
import Meter from "./Meter"
import UiBlocks from "./UiBlocks"

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

/** v1.7-additive optional field the shared package has not typed yet (see
 * PROTOCOL_NOTES.md): on a KEEPER connection, unexposed variables arrive
 * flagged `hidden:true` instead of being filtered out. */
function isHidden(variable: ModuleVariable): boolean {
  return (variable as ModuleVariable & { hidden?: boolean }).hidden === true
}

/**
 * v1.6 module variables ("trackers"), rendered by kind in definition order:
 * bounded numbers become meters, unbounded numbers stat rows, bools badges,
 * text/enum values plain chips. Labels arrive pre-localized to the room locale.
 */
function VariableRow({ variable }: { variable: ModuleVariable }) {
  const label = stripControlChars(variable.label)
  if (variable.kind === "number") {
    const value = Number(variable.value)
    if (typeof variable.min === "number" && typeof variable.max === "number") {
      return <Meter label={label} value={value} min={variable.min} max={variable.max} />
    }
    return (
      <div className="var-row" data-kind="number">
        <span className="var-label">{label}</span>
        <span className="var-value">{value}</span>
      </div>
    )
  }
  if (variable.kind === "bool") {
    const on = variable.value === true
    return (
      <div className="var-row" data-kind="bool">
        <span className="var-label">{label}</span>
        <span className={`chip ${on ? "chip-on" : "chip-off"}`}>{on ? "●" : "○"}</span>
      </div>
    )
  }
  // "text" and "enum" both carry an opaque current value. The state frame has
  // no enum options list, so there is nothing selectable to render (see
  // PROTOCOL_NOTES.md).
  return (
    <div className="var-row" data-kind={variable.kind}>
      <span className="var-label">{label}</span>
      <span className="var-value">{stripControlChars(String(variable.value))}</span>
    </div>
  )
}

function VariablesCard({ game }: { game: StateFrame }) {
  const { t } = useTranslation()
  if (!game.variables || game.variables.length === 0) return null
  return (
    <section className="desk-card">
      <header className="desk-title">{t("session.trackers")}</header>
      <div className="var-list">
        {game.variables.map((variable) =>
          isHidden(variable) ? (
            <div key={variable.id} className="var-hidden-row" title={t("session.hiddenVar")}>
              <span className="var-lock" aria-label={t("session.hiddenVar")}>
                🔒
              </span>
              <VariableRow variable={variable} />
            </div>
          ) : (
            <VariableRow key={variable.id} variable={variable} />
          ),
        )}
      </div>
    </section>
  )
}

/** Persistent sidebar regions fed by hook-emitted `ui` frames. */
function UiPanelCards() {
  const panels = useSessionStore((s) => s.uiPanels)
  return (
    <>
      {panels.map((panel) => (
        <section key={panel.key} className="desk-card ui-panel" data-panel-id={panel.key}>
          <UiBlocks frame={panel.frame} />
        </section>
      ))}
    </>
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
      <UiPanelCards />
      {game?.character ? <CharacterCard character={game.character} /> : null}
      {game ? <VariablesCard game={game} /> : null}
      {game ? <PartyCard game={game} /> : null}
      {game ? <SceneCard game={game} /> : null}
      {game ? <InitiativeCard game={game} /> : null}
      <PresenceCard />
      {game ? <UsageCard game={game} /> : null}
    </div>
  )
}
