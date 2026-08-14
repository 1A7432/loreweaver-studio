// The card-split (拆卡) workbench's session, persisted.
//
// This used to be a `useState` in `SplitView.tsx`, which meant a tab switch or a
// reload silently destroyed the work: prose edits on the character half, every
// promotion decision, the AI-filled labels. Nothing warned, nothing came back.
//
// What survives a reload, and what cannot:
//   - Everything the author TYPED or DECIDED is persisted verbatim.
//   - The dropped file's BYTES are not. A JSON card is text, so it is stored as
//     text and the bytes are rebuilt exactly on restore. A PNG card is not, so
//     the session comes back marked "re-attach needed": every edit is still
//     there, but the one action that needs the original bytes (handing the card
//     to the pack bench, which ships the file as-is) asks for the file again
//     rather than shipping something subtly different.
// The file's name, size and sha256 ride along either way, so a re-attach can be
// checked against what was originally opened.

import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { bytesToBase64, base64ToBytes, type PickedFile } from "../lib/native"
import type { SplitCardResult } from "../features/studio/split/cardSplit"
import type { StCharacterCard } from "../features/studio/split/charcard"
import type { MvuLeaf } from "../features/studio/split/mvu"
import type { PromotionDraft } from "../features/studio/split/promote"
import type { Issue } from "../features/studio/model"

/** What is remembered about the opened file itself. */
export interface SplitFileRef {
  name: string
  path: string | null
  size: number
  /** Hex sha256 of the opened bytes; "" where the platform has no WebCrypto. */
  sha256: string
}

export interface SplitSession {
  file: SplitFileRef
  /** Base64 of the original bytes. Present in a live session; dropped from the
   * persisted copy for a binary card, which is what `needsReattach` reports. */
  base64: string | null
  /** True when the persisted session came back without its bytes. */
  needsReattach: boolean
  /** The card exactly as parsed — what a keeper's world import would read. */
  original: StCharacterCard
  /** The (editable) character half. */
  character: StCharacterCard
  split: SplitCardResult
  leaves: MvuLeaf[]
  truncated: boolean
  /** `[InitVar]` blocks that did not parse — the card still opened. */
  initvarProblems: Issue[]
  drafts: PromotionDraft[]
}

interface SplitState {
  session: SplitSession | null
  setSession: (session: SplitSession | null) => void
  patchSession: (patch: Partial<SplitSession>) => void
  patchCharacter: (patch: Partial<StCharacterCard>) => void
  patchDraft: (uid: string, patch: Partial<PromotionDraft>) => void
  /** Re-attach the bytes of a session restored without them. */
  reattach: (file: PickedFile) => void
  clear: () => void
}

/** A JSON card's bytes ARE its text, so they survive persistence losslessly.
 * Anything else (PNG) does not, and pretending otherwise would ship a card the
 * author never opened. */
export function isTextCard(name: string): boolean {
  return name.toLowerCase().endsWith(".json")
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) return ""
  try {
    const digest = await subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer)
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  } catch {
    return ""
  }
}

/** Bytes for the actions that need them (handing the card to the pack bench),
 * or null when the session is waiting on a re-attach. */
export function sessionBytes(session: SplitSession): Uint8Array | null {
  return session.base64 === null ? null : base64ToBytes(session.base64)
}

export const useSplitStore = create<SplitState>()(
  persist(
    (set) => ({
      session: null,

      setSession: (session) => set({ session }),

      patchSession: (patch) =>
        set((state) => (state.session === null ? {} : { session: { ...state.session, ...patch } })),

      patchCharacter: (patch) =>
        set((state) =>
          state.session === null
            ? {}
            : { session: { ...state.session, character: { ...state.session.character, ...patch } } },
        ),

      patchDraft: (uid, patch) =>
        set((state) =>
          state.session === null
            ? {}
            : {
                session: {
                  ...state.session,
                  drafts: state.session.drafts.map((draft) =>
                    draft.uid === uid ? { ...draft, ...patch } : draft,
                  ),
                },
              },
        ),

      reattach: (file) =>
        set((state) =>
          state.session === null
            ? {}
            : {
                session: {
                  ...state.session,
                  base64: bytesToBase64(file.bytes),
                  needsReattach: false,
                  file: { ...state.session.file, path: file.path },
                },
              },
        ),

      clear: () => set({ session: null }),
    }),
    {
      name: "loreweaver-studio-split",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        session:
          state.session === null
            ? null
            : {
                ...state.session,
                // A text card's base64 is its own content, so keeping it costs
                // nothing beyond what the session already holds. A binary
                // card's would be megabytes of localStorage for bytes we can
                // ask for again in one click.
                base64: isTextCard(state.session.file.name) ? state.session.base64 : null,
                needsReattach: !isTextCard(state.session.file.name),
              },
      }),
    },
  ),
)
