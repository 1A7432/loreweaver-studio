// The desk beside the story: the viewer's character, the room's variables, the party and
// who is at the table, what can be claimed or imported, the scene, the fight's order, the
// room's settings and the last turn's token figures — each card one built-in view of
// protocol 3.0 §10.4, read from the session snapshot as it is now.
//
// Every action is a command (`command.run`), offered only when the `commands` view lists
// it as available to this viewer with the arguments it passes; what comes back is shown
// on the card that ran it. Admin-only controls appear for the ROOM ADMIN (role `admin`).

import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
  stripControlChars,
  type CharactersView,
  type MeView,
  type PacksView,
  type PartyView,
  type ViewModuleVariable,
  type ViewResource,
  type ViewTreeLeaf,
} from "loreweaver-protocol/v3"
import CommandFeedback from "./CommandFeedback"
import Meter, { type MeterTone } from "./Meter"
import { useCommand, useCommandRunner, useOnline, useRole, useView } from "./room"
import { addVarArgs, isWritablePath, setVarArgs, stepFor } from "./varCommands"

/** What a character is kept by, for the tag beside its name: the module's id for a module's
 * character (it has no rule system), else its rule system; "" when neither is named. */
export function characterTag(character: { readonly pack: string; readonly module?: string }): string {
  return stripControlChars(character.module ?? character.pack).trim()
}

/** The well-known vital ids keep their dedicated tones; anything else a rule system
 * invents takes the generic accent. */
function resourceTone(id: string): MeterTone {
  if (id === "hp" || id === "mp" || id === "san") return id
  return "accent"
}

/** One resource (`{id, label, value, max?}`): a meter, or a plain value when it has no
 * positive maximum to fill against (a module's resource may have none at all). The label is
 * already in the viewer's language. */
export function ResourceRow({ resource }: { resource: ViewResource }) {
  const label = stripControlChars(resource.label)
  const max = resource.max ?? 0
  if (max > 0) {
    return <Meter label={label} value={resource.value} max={max} tone={resourceTone(resource.id)} />
  }
  return (
    <div className="var-row" data-kind="number">
      <span className="var-label">{label}</span>
      <span className="var-value">{resource.value}</span>
    </div>
  )
}

function StatusChips({ status }: { status: readonly string[] }) {
  if (status.length === 0) return null
  return (
    <div className="chip-row">
      {status.map((effect) => (
        <span key={effect} className="chip chip-effect">
          {stripControlChars(effect)}
        </span>
      ))}
    </div>
  )
}

function CharacterCard({ character }: { character: NonNullable<MeView["character"]> }) {
  const { t } = useTranslation()
  return (
    <section className="desk-card" aria-label={t("session.character")}>
      <header className="desk-title">
        {stripControlChars(character.name)}
        {characterTag(character) ? <span className="desk-tag">{characterTag(character)}</span> : null}
      </header>
      {character.resources.map((resource) => (
        <ResourceRow key={resource.id} resource={resource} />
      ))}
      <StatusChips status={character.status} />
    </section>
  )
}

/** A value of the variable tree as text: a list joined, nothing as a dash. */
function scalarText(value: ViewTreeLeaf["value"]): string {
  if (Array.isArray(value)) return value.map((item) => (item === null ? "—" : String(item))).join(", ")
  return value === null ? "—" : String(value)
}

/**
 * A declared variable, by kind: a bounded number is a meter, an unbounded one a value
 * row, a bool an on/off chip, a text or enum its value (an enum's option name when the
 * pack gives one, the raw option id as the tooltip — the id is what `var set` takes).
 */
function VariableRow({ variable }: { variable: ViewModuleVariable }) {
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
  const raw = stripControlChars(String(variable.value))
  const shown = typeof variable.valueLabel === "string" ? stripControlChars(variable.valueLabel).trim() : ""
  return (
    <div className="var-row" data-kind={variable.kind}>
      <span className="var-label">{label}</span>
      <span className="var-value" title={shown && shown !== raw ? raw : undefined}>
        {shown || raw}
      </span>
    </div>
  )
}

function LeafRow({ leaf }: { leaf: ViewTreeLeaf }) {
  const path = stripControlChars(leaf.path)
  const description = typeof leaf.description === "string" ? stripControlChars(leaf.description).trim() : ""
  return (
    <div className="var-row" data-kind="tree">
      <span className="var-label" title={description || undefined}>
        {path}
      </span>
      <span className="var-value">{stripControlChars(scalarText(leaf.value))}</span>
    </div>
  )
}

type Run = (id: string, args: Record<string, unknown>) => void

/** A free-text value for `var set`: the RAW value is the placeholder, never a display name. */
function SetField({
  label,
  current,
  onSet,
}: {
  label: string
  current: string
  onSet: (value: string) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState("")
  const commit = () => {
    if (draft.trim() === "") return
    onSet(draft)
    setDraft("")
  }
  return (
    <>
      <input
        className="var-set-input"
        value={draft}
        aria-label={t("session.varSet", { label })}
        placeholder={current}
        title={current}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
        }}
      />
      <button type="button" className="ghost-button" disabled={draft.trim() === ""} onClick={commit}>
        {t("session.varSetAction")}
      </button>
    </>
  )
}

/** The admin's write controls for one declared variable. */
function VariableWrite({
  variable,
  canSet,
  canAdd,
  run,
}: {
  variable: ViewModuleVariable
  canSet: boolean
  canAdd: boolean
  run: Run
}) {
  const { t } = useTranslation()
  if (!isWritablePath(variable.id)) return null
  const label = stripControlChars(variable.label)
  const down = stepFor(variable, -1)
  const up = stepFor(variable, 1)
  return (
    <div className="var-write">
      {variable.kind === "number" && canAdd ? (
        <>
          <button
            type="button"
            className="ghost-button"
            disabled={down === null}
            aria-label={t("session.varDecrement", { label })}
            onClick={() => {
              const args = addVarArgs(variable.id, down ?? 0)
              if (args) run("var", args)
            }}
          >
            −
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={up === null}
            aria-label={t("session.varIncrement", { label })}
            onClick={() => {
              const args = addVarArgs(variable.id, up ?? 0)
              if (args) run("var", args)
            }}
          >
            +
          </button>
        </>
      ) : null}
      {variable.kind === "bool" && canSet ? (
        <button
          type="button"
          className="ghost-button"
          onClick={() => run("var", setVarArgs(variable.id, variable.value !== true))}
        >
          {t("session.varToggle")}
        </button>
      ) : null}
      {variable.kind === "enum" && canSet && variable.options && variable.options.length > 0 ? (
        <select
          aria-label={t("session.varSet", { label })}
          value={String(variable.value)}
          onChange={(e) => run("var", setVarArgs(variable.id, e.target.value))}
        >
          {variable.options.map((option) => (
            <option key={option} value={option}>
              {stripControlChars(option)}
            </option>
          ))}
        </select>
      ) : null}
      {(variable.kind === "text" ||
        variable.kind === "number" ||
        (variable.kind === "enum" && !variable.options?.length)) &&
      canSet ? (
        <SetField
          label={label}
          current={stripControlChars(String(variable.value))}
          onSet={(value) => run("var", setVarArgs(variable.id, value))}
        />
      ) : null}
    </div>
  )
}

function HiddenMark({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="var-hidden-row" title={t("session.hiddenVar")}>
      <span className="var-lock" aria-label={t("session.hiddenVar")}>
        🔒
      </span>
      {children}
    </div>
  )
}

function VariablesCard() {
  const { t } = useTranslation()
  const variables = useView("variables")
  const admin = useRole() === "admin"
  const canSet = useCommand("var", ["op", "path", "value"]) !== null
  const canAdd = useCommand("var", ["op", "path", "delta"]) !== null
  const { run, feedback, dismiss } = useCommandRunner()
  // Off by default: an admin reads this card far more often than they write it, and
  // thirty inline inputs would bury the numbers they came to read.
  const [editing, setEditing] = useState(false)
  if (variables === null || (variables.module.length === 0 && variables.tree.length === 0)) return null
  const writable = admin && (canSet || canAdd)
  const send: Run = (id, args) => void run(id, args)
  return (
    <section className="desk-card">
      <header className="desk-title">
        {t("session.trackers")}
        {writable ? (
          <button type="button" className="ghost-button" onClick={() => setEditing(!editing)}>
            {t(editing ? "session.varEditDone" : "session.varEdit")}
          </button>
        ) : null}
      </header>
      {writable && editing ? <p className="studio-hint">{t("session.varEditHint")}</p> : null}
      <div className="var-list">
        {variables.module.map((variable) => (
          <div key={`m:${variable.id}`} className="var-entry">
            {variable.hidden ? (
              <HiddenMark>
                <VariableRow variable={variable} />
              </HiddenMark>
            ) : (
              <VariableRow variable={variable} />
            )}
            {writable && editing ? (
              <VariableWrite variable={variable} canSet={canSet} canAdd={canAdd} run={send} />
            ) : null}
          </div>
        ))}
        {variables.tree.map((leaf) => (
          <div key={`t:${leaf.path}`} className="var-entry">
            {leaf.hidden ? (
              <HiddenMark>
                <LeafRow leaf={leaf} />
              </HiddenMark>
            ) : (
              <LeafRow leaf={leaf} />
            )}
            {writable && editing && canSet && !Array.isArray(leaf.value) && isWritablePath(leaf.path) ? (
              <div className="var-write">
                <SetField
                  label={stripControlChars(leaf.path)}
                  current={stripControlChars(scalarText(leaf.value))}
                  onSet={(value) => send("var", setVarArgs(leaf.path, value))}
                />
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </section>
  )
}

function PartyCard({ party, mine }: { party: PartyView; mine: string | null }) {
  const { t } = useTranslation()
  if (party.characters.length === 0) return null
  return (
    <section className="desk-card">
      <header className="desk-title">{t("session.party")}</header>
      <ul className="party-list">
        {party.characters.map((character) => (
          <li key={character.id} className={`party-row${character.id === mine ? " is-active" : ""}`}>
            <span className="party-name">{stripControlChars(character.name)}</span>
            {character.player ? (
              <span className="desk-tag">{stripControlChars(character.player.name)}</span>
            ) : null}
            {/* A line of their own: beside the name they squeezed it to nothing in a narrow desk. */}
            {character.resources.length > 0 || character.status.length > 0 ? (
              <span className="party-stats">
                {character.resources.map((resource) => (
                  <span key={resource.id} className="party-stat">
                    {stripControlChars(resource.label)} {resource.value}
                    {resource.max !== undefined && resource.max > 0 ? `/${resource.max}` : ""}
                  </span>
                ))}
                {character.status.map((effect) => (
                  <span key={effect} className="chip chip-effect">
                    {stripControlChars(effect)}
                  </span>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function PresenceCard({ party }: { party: PartyView }) {
  const { t } = useTranslation()
  if (party.members.length === 0) return null
  const online = party.members.filter((member) => member.online).length
  return (
    <section className="desk-card">
      <header className="desk-title">
        {t("session.presence")}
        <span className="desk-tag">{t("session.online", { n: online })}</span>
      </header>
      <ul className="party-list">
        {party.members.map((member) => (
          <li key={member.id} className={`party-row${member.online ? "" : " is-offline"}`}>
            <span className={`presence-dot ${member.online ? "online" : "offline"}`} aria-hidden="true" />
            <span className="party-name">{stripControlChars(member.name)}</span>
            {member.role ? <span className="desk-tag">{t(`connect.role.${member.role}`)}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function InitiativeCard({ initiative }: { initiative: NonNullable<PartyView["initiative"]> }) {
  const { t } = useTranslation()
  if (initiative.order.length === 0) return null
  return (
    <section className="desk-card">
      <header className="desk-title">
        {t("session.initiative")}
        <span className="desk-tag">{t("session.round", { n: initiative.round })}</span>
      </header>
      <ol className="initiative-list">
        {initiative.order.map((entry, index) => (
          <li key={`${index}:${entry.name}`} className={entry.name === initiative.acting ? "is-current" : ""}>
            <span className="initiative-value">{entry.value}</span>
            {stripControlChars(entry.name)}
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * The characters on offer (`characters.claimable`): claim one to play it — a player's
 * action, through `pc {op: "claim", name: <id>}` — or release the one you hold.
 */
export function ClaimableCard() {
  const { t } = useTranslation()
  const characters: CharactersView | null = useView("characters")
  const me = useView("me")
  const online = useOnline()
  const pc = useCommand("pc", ["op", "name"])
  const { run, feedback, dismiss, pending } = useCommandRunner()
  const claimable = characters?.claimable ?? []
  if (claimable.length === 0) return null
  const myId = me?.member.id ?? null
  return (
    <section className="desk-card">
      <header className="desk-title">{t("session.pregens")}</header>
      <ul className="party-list">
        {claimable.map((entry) => {
          const mine = entry.id === characters?.mine || (entry.player !== null && entry.player.id === myId)
          const blurb = stripControlChars(entry.blurb).trim()
          return (
            <li
              key={entry.id}
              className={`party-row pregen-row${entry.player && !mine ? " is-offline" : ""}`}
            >
              <span className="pregen-text">
                <span className="party-name">{stripControlChars(entry.name)}</span>
                {blurb ? <span className="pregen-blurb">{blurb}</span> : null}
              </span>
              {mine ? (
                <>
                  <span className="chip">{t("session.pregenYours")}</span>
                  {pc ? (
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!online || pending}
                      onClick={() => void run("pc", { op: "release" })}
                    >
                      {t("session.pregenRelease")}
                    </button>
                  ) : null}
                </>
              ) : entry.player ? (
                <span className="chip">
                  {t("session.pregenClaimed", { name: stripControlChars(entry.player.name) })}
                </span>
              ) : pc ? (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!online || pending}
                  onClick={() => void run("pc", { op: "claim", name: entry.id })}
                >
                  {t("session.pregenClaim")}
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </section>
  )
}

/**
 * The card files the room's packs ship (`packs`): importing one runs
 * `import {pack, card, as}` with the card's own kind. A world card is module machinery:
 * only the room admin imports it (the server refuses anyone else), so a player is shown
 * it without a button.
 */
export function PackImportCard({ only }: { only?: "character" | "world" }) {
  const { t } = useTranslation()
  const packs: PacksView | null = useView("packs")
  const admin = useRole() === "admin"
  const online = useOnline()
  const usable = useCommand("import", ["pack", "card", "as"]) !== null
  const { run, feedback, dismiss, pending } = useCommandRunner()
  const [open, setOpen] = useState(false)
  if (!usable || packs === null) return null
  const cards = packs.packs.flatMap((pack) =>
    pack.cards.filter((card) => only === undefined || card.kind === only).map((card) => ({ pack, card })),
  )
  return (
    <section className="desk-card">
      <header className="desk-title">
        {t("session.packImport")}
        <button type="button" className="ghost-button" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? "session.packImportClose" : "session.packImportBrowse")}
        </button>
      </header>
      {open ? (
        cards.length === 0 ? (
          <p className="studio-hint">{t("session.packImportEmpty")}</p>
        ) : (
          <ul className="party-list">
            {cards.map(({ pack, card }) => {
              const world = card.kind === "world"
              const locked = world && !admin
              return (
                <li key={`${pack.id}/${card.file}`} className="party-row" title={card.file}>
                  <span className="party-name">{stripControlChars(card.name)}</span>
                  <span className="desk-tag">{stripControlChars(pack.name)}</span>
                  {world ? <span className="desk-tag">{t("session.packImportWorld")}</span> : null}
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={!online || locked || pending}
                    title={locked ? t("session.packImportAdminOnly") : undefined}
                    onClick={() => void run("import", { pack: pack.id, card: card.file, as: card.kind })}
                  >
                    {t("session.packImportAction")}
                  </button>
                </li>
              )
            })}
          </ul>
        )
      ) : null}
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </section>
  )
}

function SceneCard() {
  const { t } = useTranslation()
  const scene = useView("scene")
  if (scene === null) return null
  const empty = !scene.name && !scene.focus && scene.time === null && scene.established.length === 0
  if (empty) return null
  return (
    <section className="desk-card">
      <header className="desk-title">{t("session.scene")}</header>
      {scene.name || scene.focus ? (
        <p className="scene-line">
          {stripControlChars(scene.name)}
          {scene.focus ? <span className="scene-focus"> · {stripControlChars(scene.focus)}</span> : null}
        </p>
      ) : null}
      {scene.time !== null ? (
        <p className="scene-line scene-clock">
          {stripControlChars(scene.time)}
          {typeof scene.round === "number" ? ` · ${t("session.round", { n: scene.round })}` : ""}
        </p>
      ) : null}
      {scene.established.length > 0 ? (
        <ul className="scene-facts">
          {scene.established.map((fact, index) => (
            <li key={index}>
              {stripControlChars(fact.text)}
              {fact.at ? <span className="scene-focus"> · {stripControlChars(fact.at)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function RoomCard() {
  const { t } = useTranslation()
  const room = useView("room")
  if (room === null) return null
  return (
    <section className="desk-card desk-card-dim">
      <header className="desk-title">{t("session.room")}</header>
      <p className="scene-line">
        {room.system ? stripControlChars(room.system.label) : t("session.noSystem")}
        {room.variant ? <span className="scene-focus"> · {stripControlChars(room.variant)}</span> : null}
        <span className="scene-focus"> · {stripControlChars(room.localeLabel)}</span>
      </p>
      {room.keeperMuted ? <span className="chip badge-warn">{t("session.keeperMuted")}</span> : null}
    </section>
  )
}

function UsageCard() {
  const { t } = useTranslation()
  const last = useView("usage")?.last ?? null
  if (last === null) return null
  return (
    <section className="desk-card desk-card-dim">
      <p className="scene-line">
        {t("session.usage", {
          turn: last.turn,
          input: last.inputTokens,
          output: last.outputTokens,
          cached: last.cachedInputTokens,
        })}
        {last.estimated ? ` ${t("session.usageEstimated")}` : ""}
      </p>
    </section>
  )
}

export default function StatePanel() {
  const me = useView("me")
  const party = useView("party")
  return (
    <div className="desk-stack">
      {me?.character ? <CharacterCard character={me.character} /> : null}
      <VariablesCard />
      {party ? <PartyCard party={party} mine={me?.character?.id ?? null} /> : null}
      <ClaimableCard />
      <PackImportCard />
      <SceneCard />
      {party?.initiative ? <InitiativeCard initiative={party.initiative} /> : null}
      {party ? <PresenceCard party={party} /> : null}
      <RoomCard />
      <UsageCard />
    </div>
  )
}
