import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { applyTheme, DEFAULT_THEME, type ThemeName } from "../lib/themes"

export type AppMode = "play" | "studio"

interface AppState {
  mode: AppMode
  /** TUI-shared palette (lamplight is the Loreweaver identity and the default). */
  theme: ThemeName
  setMode: (mode: AppMode) => void
  setTheme: (theme: ThemeName) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      mode: "play",
      theme: DEFAULT_THEME,
      setMode: (mode) => set({ mode }),
      setTheme: (theme) => {
        applyTheme(theme)
        set({ theme })
      },
    }),
    {
      name: "loreweaver-studio-app",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ theme: s.theme }),
      onRehydrateStorage: () => (state) => {
        applyTheme(state?.theme ?? DEFAULT_THEME)
      },
    },
  ),
)
