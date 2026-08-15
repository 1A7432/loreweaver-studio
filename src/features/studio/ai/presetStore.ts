// Imported ST prompt presets, kept as local assets (zustand → localStorage,
// the same persistence pattern as forge projects). The imported two-layer
// enable matrix is never mutated — preview-UI toggles live in a separate
// `overrides` map so every tweak is revertible and the original stays exact.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { guardedLocalStorage } from "../../../lib/persistStorage"
import { uid } from "../model"
import type { StPresetImport } from "./stPreset"

export interface StoredPreset extends StPresetImport {
  id: string
  importedAt: string
  /** identifier → forced effective-enabled; absent = follow the matrix. */
  overrides: Record<string, boolean>
}

interface PresetState {
  presets: StoredPreset[]
  /** Preset the card-forge conversation uses; null = built-in prompts. */
  activeId: string | null

  addPreset: (imported: StPresetImport, overrides?: Record<string, boolean>) => string
  removePreset: (id: string) => void
  renamePreset: (id: string, name: string) => void
  setActive: (id: string | null) => void
  setOverride: (id: string, identifier: string, enabled: boolean | null) => void
  clearOverrides: (id: string) => void
}

export const usePresetStore = create<PresetState>()(
  persist(
    (set) => ({
      presets: [],
      activeId: null,

      addPreset: (imported, overrides = {}) => {
        const id = uid()
        const stored: StoredPreset = {
          ...imported,
          id,
          importedAt: new Date().toISOString(),
          overrides: { ...overrides },
        }
        set((s) => ({ presets: [...s.presets, stored] }))
        return id
      },

      removePreset: (id) =>
        set((s) => ({
          presets: s.presets.filter((p) => p.id !== id),
          activeId: s.activeId === id ? null : s.activeId,
        })),

      renamePreset: (id, name) =>
        set((s) => ({
          presets: s.presets.map((p) => (p.id === id ? { ...p, name } : p)),
        })),

      setActive: (id) => set({ activeId: id }),

      setOverride: (id, identifier, enabled) =>
        set((s) => ({
          presets: s.presets.map((p) => {
            if (p.id !== id) return p
            const overrides = { ...p.overrides }
            if (enabled === null) delete overrides[identifier]
            else overrides[identifier] = enabled
            return { ...p, overrides }
          }),
        })),

      clearOverrides: (id) =>
        set((s) => ({
          presets: s.presets.map((p) => (p.id === id ? { ...p, overrides: {} } : p)),
        })),
    }),
    {
      name: "loreweaver-studio-prompt-presets",
      storage: guardedLocalStorage,
      partialize: (s) => ({ presets: s.presets, activeId: s.activeId }),
    },
  ),
)

export function useActivePreset(): StoredPreset | null {
  return usePresetStore((s) => s.presets.find((p) => p.id === s.activeId) ?? null)
}
