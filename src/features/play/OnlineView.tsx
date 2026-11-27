// The room, once welcomed (protocol 3.0): the main menu, and the screens behind it — the
// game, my character, the session report, the client's settings, and the room admin's keys,
// model, content and room lifecycle (the TUI flow: the game is one menu item). Esc anywhere
// below the menu returns to it. An admin screen is reached only by an admin: anyone else who
// lands on one (a role changed under them) is sent back to the menu.

import { useEffect, useState } from "react"
import CharacterScreen from "./screens/CharacterScreen"
import ContentScreen from "./screens/ContentScreen"
import KeysScreen from "./screens/KeysScreen"
import MainMenuScreen from "./screens/MainMenuScreen"
import ModelScreen from "./screens/ModelScreen"
import ReportScreen from "./screens/ReportScreen"
import RoomLifecycle from "./screens/RoomLifecycle"
import SettingsScreen from "./screens/SettingsScreen"
import SessionView from "./SessionView"
import { useRole } from "./room"

export type PlayScreen =
  "menu" | "game" | "character" | "report" | "settings" | "keys" | "model" | "content" | "room"

/** The screens only the room admin is shown. */
const ADMIN_SCREENS: ReadonlySet<PlayScreen> = new Set(["keys", "model", "content", "room"])

export default function OnlineView() {
  const [chosen, setScreen] = useState<PlayScreen>("menu")
  const admin = useRole() === "admin"
  const screen = ADMIN_SCREENS.has(chosen) && !admin ? "menu" : chosen

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
    case "report":
      return <ReportScreen onBack={back} />
    case "settings":
      return <SettingsScreen onBack={back} />
    case "keys":
      return <KeysScreen onBack={back} />
    case "model":
      return <ModelScreen onBack={back} />
    case "content":
      return <ContentScreen onBack={back} />
    case "room":
      return <RoomLifecycle onBack={back} />
  }
}
