import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import {
  newLoreEntry,
  newProject,
  newVariable,
  type ForgeLoreEntry,
  type ForgeProject,
  type ForgeVariable,
} from "../features/studio/model"

export type StudioTab = "card" | "variables" | "worldbook" | "hooks"

interface StudioState {
  projects: ForgeProject[]
  activeUid: string | null
  tab: StudioTab
  selectedEntryUid: string | null

  setTab: (tab: StudioTab) => void
  createProject: (name: string) => void
  deleteProject: (uid: string) => void
  selectProject: (uid: string) => void
  updateProject: (patch: Partial<Omit<ForgeProject, "uid" | "variables" | "lorebook">>) => void

  addVariable: () => void
  updateVariable: (uid: string, patch: Partial<ForgeVariable>) => void
  removeVariable: (uid: string) => void

  addLoreEntry: () => void
  updateLoreEntry: (uid: string, patch: Partial<ForgeLoreEntry>) => void
  removeLoreEntry: (uid: string) => void
  selectLoreEntry: (uid: string | null) => void
}

function touch(project: ForgeProject): ForgeProject {
  return { ...project, updatedAt: Date.now() }
}

export const useStudioStore = create<StudioState>()(
  persist(
    (set, get) => {
      const mutateActive = (fn: (project: ForgeProject) => ForgeProject) => {
        const { activeUid } = get()
        if (!activeUid) return
        set((s) => ({
          projects: s.projects.map((p) => (p.uid === activeUid ? touch(fn(p)) : p)),
        }))
      }

      return {
        projects: [],
        activeUid: null,
        tab: "card",
        selectedEntryUid: null,

        setTab: (tab) => set({ tab }),

        createProject: (name) => {
          const project = newProject(name)
          set((s) => ({
            projects: [...s.projects, project],
            activeUid: project.uid,
            tab: "card",
            selectedEntryUid: null,
          }))
        },

        deleteProject: (uid) =>
          set((s) => {
            const projects = s.projects.filter((p) => p.uid !== uid)
            return {
              projects,
              activeUid: s.activeUid === uid ? (projects[0]?.uid ?? null) : s.activeUid,
              selectedEntryUid: null,
            }
          }),

        selectProject: (uid) => set({ activeUid: uid, selectedEntryUid: null }),

        updateProject: (patch) => mutateActive((p) => ({ ...p, ...patch })),

        addVariable: () => mutateActive((p) => ({ ...p, variables: [...p.variables, newVariable()] })),

        updateVariable: (uid, patch) =>
          mutateActive((p) => ({
            ...p,
            variables: p.variables.map((v) => (v.uid === uid ? { ...v, ...patch } : v)),
          })),

        removeVariable: (uid) =>
          mutateActive((p) => ({ ...p, variables: p.variables.filter((v) => v.uid !== uid) })),

        addLoreEntry: () => {
          const entry = newLoreEntry()
          mutateActive((p) => ({ ...p, lorebook: [...p.lorebook, entry] }))
          set({ selectedEntryUid: entry.uid })
        },

        updateLoreEntry: (uid, patch) =>
          mutateActive((p) => ({
            ...p,
            lorebook: p.lorebook.map((e) => (e.uid === uid ? { ...e, ...patch } : e)),
          })),

        removeLoreEntry: (uid) => {
          mutateActive((p) => ({ ...p, lorebook: p.lorebook.filter((e) => e.uid !== uid) }))
          set((s) => ({ selectedEntryUid: s.selectedEntryUid === uid ? null : s.selectedEntryUid }))
        },

        selectLoreEntry: (uid) => set({ selectedEntryUid: uid }),
      }
    },
    {
      name: "loreweaver-studio-projects",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ projects: s.projects, activeUid: s.activeUid }),
    },
  ),
)

export function useActiveProject(): ForgeProject | null {
  return useStudioStore((s) => s.projects.find((p) => p.uid === s.activeUid) ?? null)
}
