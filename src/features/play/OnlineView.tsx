// The protocol 2.x play screens behind the main menu (the TUI flow — the game
// is one menu item among character/settings and the admin screens). Esc
// anywhere below the menu returns to it.
//
// NOT RENDERED since the 3.0 connection step: these screens read the 2.x
// stores, which nothing feeds any more, so the play view shows the 3.0 room
// line instead (`PlayView.tsx`). Kept, compiling, until the screens move to the
// protocol `Session` one by one (later steps), then wired back in.

import { useEffect, useState } from "react"
import CharacterScreen from "./screens/CharacterScreen"
import KeysScreen from "./screens/KeysScreen"
import MainMenuScreen from "./screens/MainMenuScreen"
import ModelScreen from "./screens/ModelScreen"
import ModuleScreen from "./screens/ModuleScreen"
import RulesScreen from "./screens/RulesScreen"
import SettingsScreen from "./screens/SettingsScreen"
import SkillsScreen from "./screens/SkillsScreen"
import SessionView from "./SessionView"

export type PlayScreen =
  "menu" | "game" | "character" | "settings" | "keys" | "module" | "rules" | "skills" | "model"

export default function OnlineView() {
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
