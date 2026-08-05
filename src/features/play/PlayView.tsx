// Play mode: connect screen → MAIN MENU (the TUI flow — the game is one menu
// item among character/settings and the keeper screens) → the chronicle or a
// management screen. Esc anywhere below the menu returns to it.

import { useEffect, useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useConnectionStore } from "../../store/connection"
import CharacterScreen from "./screens/CharacterScreen"
import KeysScreen from "./screens/KeysScreen"
import MainMenuScreen from "./screens/MainMenuScreen"
import ModelScreen from "./screens/ModelScreen"
import ModuleScreen from "./screens/ModuleScreen"
import RulesScreen from "./screens/RulesScreen"
import SettingsScreen from "./screens/SettingsScreen"
import SkillsScreen from "./screens/SkillsScreen"
import SessionView from "./SessionView"
import StatusPill from "./StatusPill"

export type PlayScreen =
  "menu" | "game" | "character" | "settings" | "keys" | "module" | "rules" | "skills" | "model"

function OnlineView() {
  const [screen, setScreen] = useState<PlayScreen>("menu")

  // Esc backs out of any screen to the menu — the TUI's navigation spine.
  // The game screen keeps Esc too (its input is a plain textarea; Esc there
  // is not otherwise meaningful).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setScreen("menu")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const back = () => setScreen("menu")

  switch (screen) {
    case "menu":
      return <MainMenuScreen onNavigate={setScreen} />
    case "game":
      return <SessionView onMenu={back} />
    case "character":
      return <CharacterScreen onBack={back} />
    case "settings":
      return <SettingsScreen onBack={back} />
    case "keys":
      return <KeysScreen onBack={back} />
    case "module":
      return <ModuleScreen onBack={back} />
    case "rules":
      return <RulesScreen onBack={back} />
    case "skills":
      return <SkillsScreen onBack={back} />
    case "model":
      return <ModelScreen onBack={back} />
  }
}

export default function PlayView() {
  const { t } = useTranslation()
  const status = useConnectionStore((s) => s.status)
  const lastError = useConnectionStore((s) => s.lastError)
  const connect = useConnectionStore((s) => s.connect)

  const [ticket, setTicket] = useState("")
  const [key, setKey] = useState("")
  const [name, setName] = useState("")

  // The session stays visible through reconnects; the form only returns once
  // the transport has given up (offline) or is dialing the very first time.
  if (status === "online" || status === "reconnecting") {
    return <OnlineView />
  }

  const offline = status === "offline"
  const canSubmit = offline && ticket.trim().length > 0 && key.trim().length > 0

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    void connect({
      ticket: ticket.trim(),
      key: key.trim(),
      name: name.trim() ? name.trim() : undefined,
    })
  }

  return (
    <div className="play-view">
      <section className="connect-card">
        <header className="connect-head">
          <h2>{t("connect.title")}</h2>
          <StatusPill />
        </header>

        <form className="connect-form" onSubmit={onSubmit}>
          <label>
            {t("connect.ticket")}
            <textarea
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder={t("connect.ticketPlaceholder")}
              rows={3}
              spellCheck={false}
              disabled={!offline}
            />
          </label>
          <label>
            {t("connect.key")}
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("connect.keyPlaceholder")}
              spellCheck={false}
              disabled={!offline}
            />
          </label>
          <label>
            {t("connect.name")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("connect.namePlaceholder")}
              disabled={!offline}
            />
          </label>
          <button type="submit" disabled={!canSubmit}>
            {t("connect.submit")}
          </button>
        </form>

        {lastError ? (
          <p className="connect-error" role="alert">
            {lastError}
          </p>
        ) : null}
      </section>
    </div>
  )
}
