import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import {
  newLoreEntry,
  newPregen,
  newProject,
  newVariable,
  type ForgeLoreEntry,
  type ForgePregen,
  type ForgeProject,
  type ForgeVariable,
} from "../features/studio/model"

export type StudioTab = "card" | "variables" | "worldbook" | "pregens" | "hooks"

/** Studio sub-views: the forge editor, the co-creation wizard, the card
 * splitter, the pack wizard. */
export type StudioViewName = "forge" | "wizard" | "split" | "pack"

interface StudioState {
  projects: ForgeProject[]
  activeUid: string | null
  tab: StudioTab
  view: StudioViewName
  selectedEntryUid: string | null

  setTab: (tab: StudioTab) => void
  setView: (view: StudioViewName) => void
  createProject: (name: string) => void
  /** Land an externally built project (card split / AI draft) and focus it. */
  importProject: (project: ForgeProject) => void
  /** Replace a project wholesale by uid (the wizard's confirm write-through). */
  replaceProject: (project: ForgeProject) => void
  deleteProject: (uid: string) => void
  selectProject: (uid: string) => void
  updateProject: (patch: Partial<Omit<ForgeProject, "uid" | "variables" | "lorebook" | "pregens">>) => void

  addVariable: () => void
  updateVariable: (uid: string, patch: Partial<ForgeVariable>) => void
  removeVariable: (uid: string) => void

  addLoreEntry: () => void
  updateLoreEntry: (uid: string, patch: Partial<ForgeLoreEntry>) => void
  removeLoreEntry: (uid: string) => void
  selectLoreEntry: (uid: string | null) => void

  addPregen: () => void
  updatePregen: (uid: string, patch: Partial<ForgePregen>) => void
  removePregen: (uid: string) => void
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
        view: "forge",
        selectedEntryUid: null,

        setTab: (tab) => set({ tab }),

        setView: (view) => set({ view }),

        createProject: (name) => {
          const project = newProject(name)
          // No `view` change on purpose: the forge button already sits in the
          // forge view, and the wizard's start page must stay in the wizard.
          set((s) => ({
            projects: [...s.projects, project],
            activeUid: project.uid,
            tab: "card",
            selectedEntryUid: null,
          }))
        },

        importProject: (project) =>
          set((s) => ({
            projects: [...s.projects, touch(project)],
            activeUid: project.uid,
            tab: "card",
            view: "forge",
            selectedEntryUid: null,
          })),

        replaceProject: (project) =>
          set((s) => ({
            projects: s.projects.map((p) => (p.uid === project.uid ? touch(project) : p)),
          })),

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

        addPregen: () => mutateActive((p) => ({ ...p, pregens: [...(p.pregens ?? []), newPregen()] })),

        updatePregen: (uid, patch) =>
          mutateActive((p) => ({
            ...p,
            pregens: (p.pregens ?? []).map((g) => (g.uid === uid ? { ...g, ...patch } : g)),
          })),

        removePregen: (uid) =>
          mutateActive((p) => ({ ...p, pregens: (p.pregens ?? []).filter((g) => g.uid !== uid) })),
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
