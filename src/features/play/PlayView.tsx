// Play mode: connect screen → MAIN MENU (the TUI flow — the game is one menu
// item among character/settings and the keeper screens) → the chronicle or a
// management screen. Esc anywhere below the menu returns to it.

import { useEffect, useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { pickDirectory } from "../../lib/native"
import { isTauri } from "../../lib/transport"
import { useConnectionStore } from "../../store/connection"
import { useHostLocalStore } from "../../store/hostLocal"
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

/** The TUI's green button: bring a local server up and log straight in as
 * Keeper. While it's starting the real bring-up log streams below. */
function HostLocalBlock() {
  const { t } = useTranslation()
  const phase = useHostLocalStore((s) => s.phase)
  const log = useHostLocalStore((s) => s.log)
  const error = useHostLocalStore((s) => s.error)
  const homeOverride = useHostLocalStore((s) => s.homeOverride)
  const effectiveHome = useHostLocalStore((s) => s.effectiveHome)
  const setHomeOverride = useHostLocalStore((s) => s.setHomeOverride)
  const refreshHome = useHostLocalStore((s) => s.refreshHome)
  const start = useHostLocalStore((s) => s.start)
  const stop = useHostLocalStore((s) => s.stop)
  const native = isTauri()

  useEffect(() => {
    void refreshHome()
  }, [refreshHome])

  const browse = async () => {
    const dir = await pickDirectory()
    if (dir !== null) setHomeOverride(dir)
  }

  return (
    <div className="host-local">
      <button
        type="button"
        className="host-local-button"
        disabled={!native || phase === "starting"}
        onClick={() => void start()}
      >
        {phase === "starting" ? t("connect.hostLocal.starting") : t("connect.hostLocal.button")}
      </button>
      <p className="studio-hint">
        {native ? t("connect.hostLocal.hint") : t("connect.hostLocal.desktopOnly")}
      </p>
      <div className="host-local-home">
        <label className="field">
          {t("connect.hostLocal.home")}
          <input
            value={homeOverride}
            placeholder={effectiveHome || t("connect.hostLocal.homePlaceholder")}
            spellCheck={false}
            disabled={!native || phase === "starting"}
            onChange={(e) => setHomeOverride(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={!native || phase === "starting"}
          onClick={() => void browse()}
        >
          {t("studio.ai.browse")}
        </button>
      </div>
      {phase !== "idle" && (log.length > 0 || error !== null) ? (
        <div className="host-local-log" role="log">
          {log.slice(-12).map((line, index) => (
            <div key={index} className="host-local-line">
              {line}
            </div>
          ))}
          {error !== null ? (
            <p className="connect-error" role="alert">
              {error}
            </p>
          ) : null}
          {phase === "starting" ? (
            <button type="button" className="ghost-button" onClick={() => void stop()}>
              {t("connect.hostLocal.cancel")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function OnlineView() {
  const [screen, setScreen] = useState<PlayScreen>("menu")

  // Esc backs out of any screen to the menu — the TUI's navigation spine.
  // The game screen keeps Esc too (its input is a plain textarea; Esc there
  // is not otherwise meaningful).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // A child that owns this key (panel modal, an in-progress sheet edit)
      // preventDefault()s. InputBox does not — Esc from the chat field is
      // still the TUI's "back to the menu".
      if (event.defaultPrevented) return
      setScreen("menu")
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

        <HostLocalBlock />

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
