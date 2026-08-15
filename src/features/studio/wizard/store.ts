// Wizard session state: one session per forge project, persisted like the rest
// of the studio. The session owns answers, drafts and the card contract; the
// PROJECT stays the single source of truth for card content — confirming a
// stage writes through `applyStage` into the studio store.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { guardedLocalStorage } from "../../../lib/persistStorage"
import { useStudioStore } from "../../../store/studio"
import { applyStage } from "./apply"
import { emptyContract, type CardContract } from "./contract"
import {
  confirmBlocks,
  stageMeta,
  visibleStages,
  STAGE_ORDER,
  type StageDraft,
  type StageId,
  type WorldPath,
} from "./stages"

export interface WizardStageRecord {
  /** The author's raw answer text for the stage's guided questions. */
  answer: string
  /** The structured draft (AI-structured then author-edited, or hand-built). */
  draft: StageDraft | null
}

export interface WizardSession {
  projectUid: string
  nsfwEnabled: boolean
  /** The worldview-path choice (author's UI pick, feeds the stage gate). */
  worldPath: WorldPath
  stage: StageId
  records: Partial<Record<StageId, WizardStageRecord>>
  skipped: Partial<Record<StageId, boolean>>
  contract: CardContract
}

interface WizardState {
  sessions: Record<string, WizardSession>

  begin: (projectUid: string, nsfwEnabled: boolean) => void
  end: (projectUid: string) => void
  setNsfw: (projectUid: string, on: boolean) => void
  setWorldPath: (projectUid: string, path: WorldPath) => void
  gotoStage: (projectUid: string, stage: StageId) => void
  setAnswer: (projectUid: string, stage: StageId, answer: string) => void
  setDraft: (projectUid: string, stage: StageId, draft: StageDraft | null) => void
  skipStage: (projectUid: string, stage: StageId) => void
  /** Deterministic confirm: blocks → refuse; else applyStage + write-through. */
  confirmStage: (projectUid: string, stage: StageId) => void
}

function mutateSession(
  sessions: Record<string, WizardSession>,
  projectUid: string,
  fn: (session: WizardSession) => WizardSession,
): Record<string, WizardSession> {
  const session = sessions[projectUid]
  if (session === undefined) return sessions
  return { ...sessions, [projectUid]: fn(session) }
}

/** The next visible stage after `stage`, or null at the end of the walk. */
export function nextStage(session: WizardSession, stage: StageId): StageId | null {
  const order = visibleStages(session.nsfwEnabled).map((meta) => meta.id)
  const index = order.indexOf(stage)
  return index >= 0 && index + 1 < order.length ? order[index + 1] : null
}

export const useWizardStore = create<WizardState>()(
  persist(
    (set, get) => ({
      sessions: {},

      begin: (projectUid, nsfwEnabled) =>
        set((s) => ({
          sessions: {
            ...s.sessions,
            [projectUid]: {
              projectUid,
              nsfwEnabled,
              worldPath: "small",
              stage: "worldview",
              records: {},
              skipped: {},
              contract: emptyContract(),
            },
          },
        })),

      end: (projectUid) =>
        set((s) => {
          const sessions = { ...s.sessions }
          delete sessions[projectUid]
          return { sessions }
        }),

      setNsfw: (projectUid, on) =>
        set((s) => ({
          sessions: mutateSession(s.sessions, projectUid, (session) => {
            const stageHidden = !on && stageMeta(session.stage).nsfwGated
            return { ...session, nsfwEnabled: on, stage: stageHidden ? "npcs" : session.stage }
          }),
        })),

      setWorldPath: (projectUid, path) =>
        set((s) => ({
          sessions: mutateSession(s.sessions, projectUid, (session) => ({ ...session, worldPath: path })),
        })),

      gotoStage: (projectUid, stage) =>
        set((s) => ({
          sessions: mutateSession(s.sessions, projectUid, (session) => ({ ...session, stage })),
        })),

      setAnswer: (projectUid, stage, answer) =>
        set((s) => ({
          sessions: mutateSession(s.sessions, projectUid, (session) => ({
            ...session,
            records: {
              ...session.records,
              [stage]: { answer, draft: session.records[stage]?.draft ?? null },
            },
          })),
        })),

      setDraft: (projectUid, stage, draft) =>
        set((s) => ({
          sessions: mutateSession(s.sessions, projectUid, (session) => ({
            ...session,
            records: {
              ...session.records,
              [stage]: { answer: session.records[stage]?.answer ?? "", draft },
            },
          })),
        })),

      skipStage: (projectUid, stage) =>
        set((s) => ({
          sessions: mutateSession(s.sessions, projectUid, (session) => {
            if (!stageMeta(stage).optional) return session
            const next = nextStage(session, stage)
            return {
              ...session,
              skipped: { ...session.skipped, [stage]: true },
              stage: next ?? session.stage,
            }
          }),
        })),

      confirmStage: (projectUid, stage) => {
        const session = get().sessions[projectUid]
        if (session === undefined) return
        const draft = session.records[stage]?.draft ?? null
        if (confirmBlocks(draft).length > 0 || draft === null) return
        const project = useStudioStore.getState().projects.find((p) => p.uid === projectUid)
        if (project === undefined) return

        const result = applyStage(project, session.contract, draft, Date.now())
        useStudioStore.getState().replaceProject(result.project)
        set((s) => ({
          sessions: mutateSession(s.sessions, projectUid, (current) => {
            const advanced = nextStage(current, stage)
            return {
              ...current,
              contract: result.contract,
              skipped: { ...current.skipped, [stage]: false },
              stage: advanced ?? current.stage,
            }
          }),
        }))
      },
    }),
    {
      name: "loreweaver-studio-wizard",
      storage: guardedLocalStorage,
      partialize: (s) => ({ sessions: s.sessions }),
    },
  ),
)

export function useWizardSession(projectUid: string | null): WizardSession | null {
  return useWizardStore((s) => (projectUid !== null ? (s.sessions[projectUid] ?? null) : null))
}

/** Drafts of every CONFIRMED stage, in walk order — the context digest input. */
export function confirmedDrafts(session: WizardSession): StageDraft[] {
  const out: StageDraft[] = []
  for (const stage of STAGE_ORDER) {
    if (session.contract.confirmedAt[stage] === undefined) continue
    const draft = session.records[stage]?.draft
    if (draft !== undefined && draft !== null) out.push(draft)
  }
  return out
}
