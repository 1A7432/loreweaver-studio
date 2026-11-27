import { create } from "zustand"
import { persist } from "zustand/middleware"
import { guardedLocalStorage } from "../lib/persistStorage"
import {
  newLoreEntry,
  newProject,
  newVariable,
  type ForgeLoreEntry,
  type ForgeProject,
  type ForgeVariable,
} from "../features/studio/model"
import { useUndoStore } from "./undo"

export type StudioTab = "card" | "variables" | "worldbook"

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

        deleteProject: (uid) => {
          // Restoring at the SAME index, not at the end: a project list the
          // author has ordered should come back the way it was.
          const index = get().projects.findIndex((p) => p.uid === uid)
          const removed = get().projects[index]
          const previousActive = get().activeUid
          set((s) => {
            const projects = s.projects.filter((p) => p.uid !== uid)
            return {
              projects,
              activeUid: s.activeUid === uid ? (projects[0]?.uid ?? null) : s.activeUid,
              selectedEntryUid: null,
            }
          })
          if (removed === undefined) return
          useUndoStore.getState().push("project", removed.name, () => {
            set((s) => ({
              projects: [...s.projects.slice(0, index), removed, ...s.projects.slice(index)],
              activeUid: previousActive,
            }))
          })
        },

        selectProject: (uid) => set({ activeUid: uid, selectedEntryUid: null }),

        updateProject: (patch) => mutateActive((p) => ({ ...p, ...patch })),

        addVariable: () => mutateActive((p) => ({ ...p, variables: [...p.variables, newVariable()] })),

        updateVariable: (uid, patch) =>
          mutateActive((p) => ({
            ...p,
            variables: p.variables.map((v) => (v.uid === uid ? { ...v, ...patch } : v)),
          })),

        removeVariable: (uid) => {
          const owner = get().activeUid
          const project = get().projects.find((p) => p.uid === owner)
          const index = project?.variables.findIndex((v) => v.uid === uid) ?? -1
          const removed = index < 0 ? undefined : project?.variables[index]
          mutateActive((p) => ({ ...p, variables: p.variables.filter((v) => v.uid !== uid) }))
          if (removed === undefined) return
          useUndoStore.getState().push("variable", removed.id, () => {
            // Scoped to the project it came from, not to whatever is active
            // now — an undo must never write into a different card.
            set((s) => ({
              projects: s.projects.map((p) =>
                p.uid === owner
                  ? {
                      ...p,
                      variables: [...p.variables.slice(0, index), removed, ...p.variables.slice(index)],
                    }
                  : p,
              ),
            }))
          })
        },

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
          const owner = get().activeUid
          const project = get().projects.find((p) => p.uid === owner)
          const index = project?.lorebook.findIndex((e) => e.uid === uid) ?? -1
          const removed = index < 0 ? undefined : project?.lorebook[index]
          mutateActive((p) => ({ ...p, lorebook: p.lorebook.filter((e) => e.uid !== uid) }))
          set((s) => ({ selectedEntryUid: s.selectedEntryUid === uid ? null : s.selectedEntryUid }))
          if (removed === undefined) return
          useUndoStore.getState().push("loreEntry", removed.title, () => {
            set((s) => ({
              projects: s.projects.map((p) =>
                p.uid === owner
                  ? { ...p, lorebook: [...p.lorebook.slice(0, index), removed, ...p.lorebook.slice(index)] }
                  : p,
              ),
              selectedEntryUid: removed.uid,
            }))
          })
        },

        selectLoreEntry: (uid) => set({ selectedEntryUid: uid }),
      }
    },
    {
      name: "loreweaver-studio-projects",
      storage: guardedLocalStorage,
      partialize: (s) => ({ projects: s.projects, activeUid: s.activeUid }),
      // 1: hook scripts and the pregenerated cast left the project. A 3.0 engine counts a
      // card's hook scripts and never runs them (and they make it a world card), and reads no
      // pregens, so Studio stopped writing either; a stored project sheds both on load.
      version: 1,
      migrate: (stored) => {
        const state = (stored ?? {}) as { projects?: unknown; activeUid?: unknown }
        const projects = Array.isArray(state.projects)
          ? state.projects.map((project) => {
              const kept: Record<string, unknown> = { ...(project as Record<string, unknown>) }
              delete kept.hooks
              delete kept.pregens
              return kept as unknown as ForgeProject
            })
          : []
        return {
          projects,
          activeUid: typeof state.activeUid === "string" ? state.activeUid : null,
        } as unknown as StudioState
      },
    },
  ),
)

export function useActiveProject(): ForgeProject | null {
  return useStudioStore((s) => s.projects.find((p) => p.uid === s.activeUid) ?? null)
}
