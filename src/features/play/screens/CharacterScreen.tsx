// My character — the full sheet from the `me` view, and the things you actually do to it:
// make one, claim one, change one. Every action is a command (`command.run`), so the
// server's own validation against the rule system stays the only authority; what comes
// back is shown on this screen.
//
// This screen knows NOTHING about any rule system. The systems it offers come from the
// `characters` view, the attributes it edits from the live sheet (each with its label in
// the viewer's language and the key the `sheet` command writes). There is no point-buy
// mode for the same reason: its budgets live in a pack's constraints and no view carries
// them. A card file of your own is imported through the byte channel, which this screen
// does not offer yet; the cards a pack ships are importable below.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars, type ViewStat } from "loreweaver-protocol/v3"
import CommandFeedback from "../CommandFeedback"
import { useCommand, useCommandRunner, useOnline, useView } from "../room"
import { ClaimableCard, PackImportCard, ResourceRow } from "../StatePanel"
import ScreenShell from "./ScreenShell"
import { sheetSetArgs } from "./sheetWrite"

/** Make a character: the server rolls it in the chosen system (`new_character`). */
function CreateCharacter() {
  const { t } = useTranslation()
  const characters = useView("characters")
  const online = useOnline()
  const usable = useCommand("new_character", ["system", "name"]) !== null
  const { run, feedback, dismiss, pending } = useCommandRunner()
  const [system, setSystem] = useState("")
  const [name, setName] = useState("")
  const systems = characters?.systems ?? []

  if (!usable) return null
  if (systems.length === 0) {
    return <p className="placeholder">{t("play.character.noSystems")}</p>
  }
  // The pick defaults to the room's own system, else the first one offered.
  const chosen = systems.some((entry) => entry.id === system)
    ? system
    : (systems.find((entry) => entry.active) ?? systems[0]).id

  const submit = () => {
    const trimmed = name.trim()
    void run("new_character", trimmed ? { system: chosen, name: trimmed } : { system: chosen })
  }

  return (
    <div className="play-form">
      <p className="studio-hint">{t("play.character.rollHint")}</p>
      <label className="field">
        {t("play.character.system")}
        <select value={chosen} onChange={(e) => setSystem(e.target.value)}>
          {systems.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {stripControlChars(entry.label)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        {t("play.character.name")}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("play.character.namePlaceholder")}
        />
      </label>
      <button type="button" className="primary-button" disabled={!online || pending} onClick={submit}>
        {t("play.character.create")}
      </button>
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </div>
  )
}

/** One sheet value. A whole number can be edited: the write goes through the `sheet`
 * command, the server validates it, and the next `me` value is the truth — nothing is
 * assumed to have worked here. The label is shown; the key is what is written. */
function StatRow({
  stat,
  editable,
  onWrite,
}: {
  stat: ViewStat
  editable: boolean
  onWrite: (key: string, value: number) => void
}) {
  const { t } = useTranslation()
  const online = useOnline()
  const [draft, setDraft] = useState<string | null>(null)
  const key = stripControlChars(stat.key)
  const shown = stripControlChars(stat.label).trim() || key
  const nameCell = (
    <td className="play-attr-name" title={shown !== key ? key : undefined}>
      {shown}
    </td>
  )
  const value = stat.value
  if (!editable || typeof value !== "number" || !Number.isFinite(value)) {
    return (
      <tr>
        {nameCell}
        <td>{stripControlChars(String(value))}</td>
      </tr>
    )
  }

  const commit = () => {
    const next = (draft ?? "").trim()
    setDraft(null)
    if (!next || !Number.isFinite(Number(next)) || Number(next) === value) return
    onWrite(stat.key, Number(next))
  }

  return (
    <tr>
      {nameCell}
      <td>
        {draft === null ? (
          <button
            type="button"
            className="ghost-button"
            disabled={!online}
            title={t("play.character.editHint")}
            onClick={() => setDraft(String(value))}
          >
            {value}
          </button>
        ) : (
          <input
            autoFocus
            // NOT `type="number"`. Pasting into that input reloaded the whole WebView —
            // three times out of three, on a value as ordinary as `47`, while the same
            // paste into every other field in the app was fine (2026-08-20 play-test).
            // The crash is below our floor (WebKit's own native paste path for number
            // inputs), so this is a dodge rather than a diagnosis; it is also the better
            // control regardless — no spinner arrows, and no scroll wheel silently
            // rewriting a character's stat. `inputMode` keeps the numeric keypad on
            // touch, and `commit` already parses and validates whatever lands here.
            type="text"
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                setDraft(null)
              }
            }}
            aria-label={shown}
          />
        )}
      </td>
    </tr>
  )
}

export default function CharacterScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const character = useView("me")?.character ?? null
  const online = useOnline()
  const canWrite = useCommand("sheet", ["op", "writes"]) !== null
  const canSheet = useCommand("sheet", ["op"]) !== null
  const { run, feedback, dismiss, pending } = useCommandRunner()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const write = (key: string, value: number) => void run("sheet", sheetSetArgs(key, value))

  return (
    <ScreenShell title={t("play.menu.character")} onBack={onBack}>
      {character === null ? (
        <>
          <p className="placeholder">{t("play.character.none")}</p>
          <ClaimableCard />
          <CreateCharacter />
          <PackImportCard only="character" />
        </>
      ) : (
        <div className="play-character">
          <h3>
            {stripControlChars(character.name)}
            <span className="desk-tag">{stripControlChars(character.pack)}</span>
          </h3>
          <div className="play-character-meters">
            {character.resources.map((resource) => (
              <ResourceRow key={resource.id} resource={resource} />
            ))}
          </div>
          {character.status.length > 0 ? (
            <div className="chip-row">
              {character.status.map((effect) => (
                <span key={effect} className="chip">
                  {stripControlChars(effect)}
                </span>
              ))}
            </div>
          ) : null}
          {[character.attributes, character.skills].map((stats, index) =>
            stats.length > 0 ? (
              <table key={index} className="play-table">
                <tbody>
                  {stats.map((stat) => (
                    <StatRow key={stat.key} stat={stat} editable={canWrite} onWrite={write} />
                  ))}
                </tbody>
              </table>
            ) : null,
          )}
          {canWrite ? <p className="studio-hint">{t("play.character.editHint")}</p> : null}
          {canSheet ? (
            <div className="chip-row">
              <button
                type="button"
                className="ghost-button"
                disabled={!online || pending}
                title={t("play.character.finalizeHint")}
                onClick={() => void run("sheet", { op: "finalize" })}
              >
                {t("play.character.finalize")}
              </button>
              {confirmDelete ? (
                <>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!online || pending}
                    onClick={() => {
                      void run("sheet", { op: "clear" })
                      setConfirmDelete(false)
                    }}
                  >
                    {t("play.character.deleteConfirm")}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setConfirmDelete(false)}>
                    {t("play.character.deleteCancel")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ghost-button"
                  disabled={!online}
                  onClick={() => setConfirmDelete(true)}
                >
                  {t("play.character.delete")}
                </button>
              )}
            </div>
          ) : null}
          <CommandFeedback feedback={feedback} onDismiss={dismiss} />
        </div>
      )}
    </ScreenShell>
  )
}
