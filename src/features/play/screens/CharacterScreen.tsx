// My character — the full sheet, and the two things you actually do to it:
// make one, and change it. Both go through the ordinary command lane
// (`transportSend({type:"input"})`), the same one the chat box uses, so the
// server's own validation (`core.character_rules`) stays the only authority.
//
// This screen knows NOTHING about any rule system. The systems it offers come
// from `state.systems` (protocol 2.3) — the id plus the dialect word that makes
// a character in it — and the attributes it edits come from the live sheet.
// That is deliberate: the TUI's equivalent screen hard-codes CoC's and D&D's
// attribute tables, ranges, point-buy costs and budgets, which is exactly the
// per-system knowledge M16 deleted from the engine. Copying it here would put a
// second rule engine in a client and lock every community pack's own system out
// of this screen until the studio shipped a release.
//
// The one creation mode NOT offered is manual point-buy, for the same reason:
// its budgets and ranges live in a pack's `creation_constraints` and no frame
// carries them. Rolling, describing and importing all resolve server-side.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars, type RuleSystemEntry } from "@loreweaver/protocol"
import { transportSend } from "../../../lib/transport"
import { useConnectionStore } from "../../../store/connection"
import { useSessionStore } from "../../../store/session"
import { ResourceRow } from "../StatePanel"
import ScreenShell from "./ScreenShell"
import { sheetWrite } from "./sheetWrite"

function attrText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return stripControlChars(String(value))
}

/** Only whole numbers are `.st`-assignable; a derived object or a text field is shown
 * but not offered as an edit box, because the command would be nonsense. */
function isEditable(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function send(text: string): void {
  void transportSend({ type: "input", text }).catch(() => {
    // The transport surfaces failures through status events.
  })
}

/** The one empty list every "no systems" answer returns. A fresh `[]` per call makes
 * a zustand selector look changed on every render, which is an infinite re-render, not
 * a style point. */
const NO_SYSTEMS: RuleSystemEntry[] = []

type CreateMode = "roll" | "describe" | "import"

/** Make a character. Three modes, all resolved by the server: it rolls, it drafts from
 * a description, or it reads a card file. */
function CreateCharacter() {
  const { t } = useTranslation()
  const systems = useSessionStore((s) => s.game?.systems ?? NO_SYSTEMS)
  const online = useConnectionStore((s) => s.status === "online")
  const creatable = systems.filter((entry) => entry.make_char)
  const [mode, setMode] = useState<CreateMode>("roll")
  const [system, setSystem] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [path, setPath] = useState("")
  const [sent, setSent] = useState("")

  // The picker offers the CURRENT mode's list (roll needs a make-char word; describe
  // and import take any system) and defaults to its first entry rather than to a
  // hard-coded one; `systems` arrives with the first state frame. A pick that is not
  // in this mode's list (chosen in another mode) falls back the same way, so the box
  // never shows one system while the button is disabled for another.
  const offered = mode === "roll" ? creatable : systems
  const chosen = offered.some((entry) => entry.id === system) ? system : (offered[0]?.id ?? "")
  const makeCharWord = creatable.find((entry) => entry.id === chosen)?.make_char ?? ""

  if (systems.length === 0) {
    return <p className="placeholder">{t("play.character.noSystems")}</p>
  }

  const buildCommand = (): string => {
    const trimmedName = name.trim()
    if (mode === "roll") {
      if (!makeCharWord) return ""
      return trimmedName ? `.${makeCharWord} ${trimmedName}` : `.${makeCharWord}`
    }
    if (mode === "describe") {
      const trimmedDescription = description.trim()
      if (!trimmedDescription) return ""
      return trimmedName
        ? `.genchar ${chosen} ${trimmedName} | ${trimmedDescription}`
        : `.genchar ${chosen} | ${trimmedDescription}`
    }
    const trimmedPath = path.trim()
    return trimmedPath ? `.import ${trimmedPath} ${chosen} pc` : ""
  }

  const submit = () => {
    const command = buildCommand()
    if (!command) return
    send(command)
    setSent(command)
  }

  const ready =
    mode === "roll"
      ? Boolean(makeCharWord)
      : mode === "describe"
        ? Boolean(description.trim())
        : Boolean(path.trim())

  return (
    <div className="play-form">
      <div className="chip-row" role="group" aria-label={t("play.character.createMode")}>
        {(["roll", "describe", "import"] as CreateMode[]).map((value) => (
          <button
            key={value}
            type="button"
            className={value === mode ? "primary-button" : "ghost-button"}
            onClick={() => setMode(value)}
          >
            {t(`play.character.mode.${value}`)}
          </button>
        ))}
      </div>
      <p className="studio-hint">{t(`play.character.mode.${mode}.hint`)}</p>

      <label className="field">
        {t("play.character.system")}
        <select value={chosen} onChange={(e) => setSystem(e.target.value)}>
          {offered.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {stripControlChars(entry.id)}
            </option>
          ))}
        </select>
      </label>

      {mode === "import" ? (
        <label className="field">
          {t("play.character.cardPath")}
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={t("play.character.cardPathPlaceholder")}
            spellCheck={false}
          />
        </label>
      ) : (
        <label className="field">
          {t("play.character.name")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("play.character.namePlaceholder")}
          />
        </label>
      )}

      {mode === "describe" ? (
        <label className="field">
          {t("play.character.description")}
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("play.character.descriptionPlaceholder")}
          />
        </label>
      ) : null}

      <button type="button" className="primary-button" disabled={!online || !ready} onClick={submit}>
        {t("play.character.create")}
      </button>
      {sent ? <p className="studio-hint">{t("play.character.sent", { command: sent })}</p> : null}
    </div>
  )
}

/** One attribute row. Editing writes through `.st`, which the server validates
 * against the pack's constraints and answers in the chat log — nothing is assumed
 * to have worked here; the next `state` frame is the truth. */
function AttributeRow({ name, value }: { name: string; value: unknown }) {
  const { t } = useTranslation()
  const online = useConnectionStore((s) => s.status === "online")
  const [draft, setDraft] = useState<string | null>(null)

  if (!isEditable(value)) {
    return (
      <tr>
        <td className="play-attr-name">{stripControlChars(name)}</td>
        <td>{attrText(value)}</td>
      </tr>
    )
  }

  const commit = () => {
    const next = (draft ?? "").trim()
    setDraft(null)
    if (!next || Number(next) === value || !Number.isFinite(Number(next))) return
    send(sheetWrite(name, value, Number(next)))
  }

  return (
    <tr>
      <td className="play-attr-name">{stripControlChars(name)}</td>
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
            type="number"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit()
              if (e.key === "Escape") setDraft(null)
            }}
            aria-label={name}
          />
        )}
      </td>
    </tr>
  )
}

export default function CharacterScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const character = useSessionStore((s) => s.game?.character ?? null)
  const online = useConnectionStore((s) => s.status === "online")
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <ScreenShell title={t("play.menu.character")} onBack={onBack}>
      {character === null ? (
        <>
          <p className="placeholder">{t("play.character.none")}</p>
          <CreateCharacter />
        </>
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
                <AttributeRow key={key} name={key} value={value} />
              ))}
            </tbody>
          </table>
          <p className="studio-hint">{t("play.character.editHint")}</p>
          <div className="chip-row">
            <button
              type="button"
              className="ghost-button"
              disabled={!online}
              title={t("play.character.finalizeHint")}
              onClick={() => send(".st finalize")}
            >
              {t("play.character.finalize")}
            </button>
            {confirmDelete ? (
              <>
                <button
                  type="button"
                  className="primary-button"
                  disabled={!online}
                  onClick={() => {
                    send(".st delete")
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
        </div>
      )}
    </ScreenShell>
  )
}
