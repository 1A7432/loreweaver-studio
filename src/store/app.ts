import { create } from "zustand"

export type AppMode = "play" | "studio"

interface AppState {
  mode: AppMode
  setMode: (mode: AppMode) => void
}

export const useAppStore = create<AppState>((set) => ({
  mode: "play",
  setMode: (mode) => set({ mode }),
}))
