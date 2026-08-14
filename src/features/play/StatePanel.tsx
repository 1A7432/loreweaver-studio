import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  stripControlChars,
  type CharacterState,
  type ModuleVariable,
  type ResourceState,
  type StateFrame,
} from "@loreweaver/protocol"
import { transportSend } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"
import { useSessionStore } from "../../store/session"
import AudioDeck from "./AudioDeck"
import Avatar from "./Avatar"
import MediaDeck from "./MediaDeck"
import Meter, { type MeterTone } from "./Meter"
import { addVarCommand, isWritable, setVarCommand, stepFor } from "./varCommands"
import UiBlocks from "./UiBlocks"

/**
 * Color a vital resource by its pack-declared id (protocol 2.0 `resources`).
 * The well-known vital ids keep their dedicated tones; anything else a rule
 * pack invents falls back to the generic accent.
 */
function resourceTone(id: string): MeterTone {
  if (id === "hp" || id === "mp" || id === "san") return id
  return "accent"
}

/**
 * Protocol 2.0 vitals: one generic `resources` entry each — bounded entries
 * render as meters, unbounded ones as plain stat rows, and a `max` of zero
 * means the pool does not apply to this character (hidden, like 1.x MP/SAN).
 * Labels arrive pre-localized to the room locale.
 */
export function ResourceRow({ resource }: { resource: ResourceState }) {
  const label = stripControlChars(resource.label)
  if (typeof resource.max === "number") {
    if (resource.max <= 0) return null
    return <Meter label={label} value={resource.value} max={resource.max} tone={resourceTone(resource.id)} />
  }
  return (
    <div className="var-row" data-kind="number">
      <span className="var-label">{label}</span>
      <span className="var-value">{resource.value}</span>
    </div>
  )
}

function CharacterCard({ character }: { character: CharacterState }) {
  const { t } = useTranslation()
  return (
    <section className="desk-card">
      <header className="desk-title">
        <Avatar ref={character.avatar} name={character.name} />
        {stripControlChars(character.name)}
        <span className="desk-tag">{stripControlChars(character.system)}</span>
      </header>
      {character.resources.map((resource) => (
        <ResourceRow key={resource.id} resource={resource} />
      ))}
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

/** On a KEEPER connection, unexposed variables arrive flagged `hidden:true`
 * instead of being filtered out (typed since protocol 1.9). */
function isHidden(variable: ModuleVariable): boolean {
  return variable.hidden === true
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

/** The keeper's write control for one tracker (UPSTREAM item 11).
 *
 * Everything goes through the ordinary command path — `.var set` / `.var add`
 * — so the same permission gate, the same `core.modvars` validation (bounds,
 * enum options, bool coercion) and the same state push apply as when a keeper
 * types it. Nothing here validates a value itself: guessing at a spec the
 * client cannot see would only produce a second, wronger opinion. */
function VariableWrite({ variable }: { variable: ModuleVariable }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState("")

  const run = (command: string | null) => {
    if (command === null) return
    void transportSend({ type: "input", text: command }).catch(() => {
      // The transport surfaces failures through status events.
    })
  }

  if (!isWritable(variable)) return null
  const down = stepFor(variable, -1)
  const up = stepFor(variable, 1)

  return (
    <div className="var-write">
      {variable.kind === "number" ? (
        <>
          <button
            type="button"
            className="ghost-button"
            disabled={down === null}
            aria-label={t("session.varDecrement", { label: variable.label })}
            onClick={() => run(addVarCommand(variable.id, down ?? -1))}
          >
            −
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={up === null}
            aria-label={t("session.varIncrement", { label: variable.label })}
            onClick={() => run(addVarCommand(variable.id, up ?? 1))}
          >
            +
          </button>
        </>
      ) : null}
      {variable.kind === "bool" ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() => run(setVarCommand(variable.id, variable.value !== true))}
        >
          {t("session.varToggle")}
        </button>
      ) : (
        <>
          <input
            className="var-set-input"
            value={draft}
            aria-label={t("session.varSet", { label: variable.label })}
            placeholder={String(variable.value)}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || draft.trim() === "") return
              run(setVarCommand(variable.id, draft))
              setDraft("")
            }}
          />
          <button
            type="button"
            className="ghost-button"
            disabled={draft.trim() === ""}
            onClick={() => {
              run(setVarCommand(variable.id, draft))
              setDraft("")
            }}
          >
            {t("session.varSetAction")}
          </button>
        </>
      )}
    </div>
  )
}

function VariablesCard({ game }: { game: StateFrame }) {
  const { t } = useTranslation()
  const isKeeper = useConnectionStore((s) => s.welcome?.you.role === "keeper")
  // Off by default: a keeper reads this panel far more often than they write
  // it, and thirty inline inputs would bury the numbers they came to read.
  const [editing, setEditing] = useState(false)
  if (!game.variables || game.variables.length === 0) return null
  return (
    <section className="desk-card">
      <header className="desk-title">
        {t("session.trackers")}
        {isKeeper ? (
          <button type="button" className="ghost-button" onClick={() => setEditing(!editing)}>
            {t(editing ? "session.varEditDone" : "session.varEdit")}
          </button>
        ) : null}
      </header>
      {isKeeper && editing ? <p className="studio-hint">{t("session.varEditHint")}</p> : null}
      <div className="var-list">
        {game.variables.map((variable) => {
          const row = isHidden(variable) ? (
            <div className="var-hidden-row" title={t("session.hiddenVar")}>
              <span className="var-lock" aria-label={t("session.hiddenVar")}>
                🔒
              </span>
              <VariableRow variable={variable} />
            </div>
          ) : (
            <VariableRow variable={variable} />
          )
          return (
            <div key={variable.id} className="var-entry">
              {row}
              {isKeeper && editing ? <VariableWrite variable={variable} /> : null}
            </div>
          )
        })}
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
            <Avatar ref={member.avatar} name={member.name} />
            <span className="party-name">{stripControlChars(member.name)}</span>
            {member.ai ? <span className="chip chip-ai">AI</span> : null}
            {(member.resources ?? []).map((resource) => (
              <span key={resource.id} className="party-stat">
                {stripControlChars(resource.label)} {resource.value}
                {typeof resource.max === "number" && resource.max > 0 ? `/${resource.max}` : ""}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The module's claimable cast (`state.pregens`, protocol 2.0). The roster was
 * already reaching the tier-2 panel bridge; nothing native rendered it, so a
 * player on the studio could not see — let alone claim — the characters the
 * module ships. Claiming goes through the ordinary command path (`.pc claim
 * <name>`, `gateway/commands.py::cmd_pc`), which is a PLAYER action: claiming
 * is the whole point of a pregen roster. */
function PregenCard({ game }: { game: StateFrame }) {
  const { t } = useTranslation()
  const you = useConnectionStore((s) => s.welcome?.you.name ?? "")
  const online = useConnectionStore((s) => s.status === "online")
  const pregens = game.pregens ?? []
  if (pregens.length === 0) return null

  return (
    <section className="desk-card">
      <header className="desk-title">{t("session.pregens")}</header>
      <ul className="party-list">
        {pregens.map((pregen) => {
          const claimedBy = pregen.claimed_by.trim()
          const mine = claimedBy !== "" && claimedBy === you
          return (
            <li key={pregen.name} className={`party-row${claimedBy ? " is-offline" : ""}`}>
              <span className="party-name">{stripControlChars(pregen.name)}</span>
              {claimedBy ? (
                <span className="chip">
                  {mine
                    ? t("session.pregenYours")
                    : t("session.pregenClaimed", { name: stripControlChars(claimedBy) })}
                </span>
              ) : (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!online}
                  onClick={() => {
                    void transportSend({ type: "input", text: `.pc claim ${pregen.name}` }).catch(() => {
                      // The transport surfaces failures through status events.
                    })
                  }}
                >
                  {t("session.pregenClaim")}
                </button>
              )}
            </li>
          )
        })}
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
      {game ? <PregenCard game={game} /> : null}
      {game ? <SceneCard game={game} /> : null}
      {game ? <InitiativeCard game={game} /> : null}
      <PresenceCard />
      <MediaDeck />
      <AudioDeck />
      {game ? <UsageCard game={game} /> : null}
    </div>
  )
}
