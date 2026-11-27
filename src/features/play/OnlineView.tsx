// The room, once welcomed (protocol 3.0): the main menu, and the screens behind it — the
// game, my character, the client's settings (the TUI flow: the game is one menu item).
// Esc anywhere below the menu returns to it.
//
// The room admin's screens (`KeysScreen`, `ModelScreen`, `ModuleScreen`, `RulesScreen`,
// `SkillsScreen`, `RoomLifecycle`) still read the protocol 2.x stores and are not linked
// from here until each one moves to the session.

import { useEffect, useState } from "react"
import CharacterScreen from "./screens/CharacterScreen"
import MainMenuScreen from "./screens/MainMenuScreen"
import SettingsScreen from "./screens/SettingsScreen"
import SessionView from "./SessionView"

export type PlayScreen = "menu" | "game" | "character" | "settings"

export default function OnlineView() {
  const [screen, setScreen] = useState<PlayScreen>("menu")

  // Esc backs out of any screen to the menu — the TUI's navigation spine.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // A child that owns this key (a panel overlay, an in-progress sheet edit)
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
  }
}
