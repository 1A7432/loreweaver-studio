// The media family: uploads, the room's picture broadcasts, the keeper's
// upload switch, and avatars.
//
// The protocol splits an upload across two channels, and so does this store.
// The CONTROL half is frames — `media_offer` out, `media_accept` back — and it
// lives here. The BYTE half is a PUT on the media channel, which happens
// natively (`lib/media.ts` → `src-tauri/src/media.rs`) so a 128 MiB audio file
// never crosses the WebView boundary.
//
// Two shapes of accept, both documented and both real:
//   - `{upload_id}` — the room does not have these bytes; PUT them, and the
//     server broadcasts `media` / `audio_library_item` once it has verified the
//     size and sha256 itself.
//   - `{upload_id: "", existing: true, media|audio}` — the room already holds
//     this hash. Nothing to send; the metadata is in the accept.
//
// A pending upload is keyed by sha256, not by upload id: `existing` accepts
// carry no id, and the hash is the only thing both halves of the exchange
// agree on.

import { create } from "zustand"
import type { AudioLibraryItemFrame, MediaAcceptFrame, MediaFrame, ServerFrame } from "@loreweaver/protocol"
import { mediaPrepare, mediaUpload } from "../lib/media"
import { isTauri, transportSend } from "../lib/transport"

export type UploadPhase = "offering" | "sending" | "done" | "error"

export interface PendingUpload {
  /** Absolute path on disk — the native side re-reads it to PUT. */
  path: string
  name: string
  mime: string
  size: number
  sha256: string
  phase: UploadPhase
  /** An i18n key under `play.media.err.` or a verbatim native message. */
  error: string | null
}

/** Cap on the broadcast log this store keeps. The narrative log has its own
 * scrollback; this is the "what has been shared" index beside it. */
const MAX_ITEMS = 100

interface MediaState {
  /** Room picture broadcasts, oldest first. */
  images: MediaFrame[]
  /** Room audio-library entries, oldest first. */
  audio: AudioLibraryItemFrame[]
  /** The keeper's player-upload switch. Null until the server says. */
  uploadsEnabled: boolean | null
  /** In-flight and just-finished uploads, keyed by sha256. */
  uploads: Record<string, PendingUpload>

  ingest: (frame: ServerFrame) => boolean
  /** Offer a file, then PUT it if the server asks for the bytes. */
  upload: (path: string) => Promise<void>
  /** Keeper-only room switch for player uploads. */
  setUploadsEnabled: (enabled: boolean) => void
  /** Bind an already-uploaded image to the caller's own active character. The
   * result comes back on the next `state` frame as `character.avatar` /
   * `party[].avatar`, so nothing about it is tracked here. */
  setAvatar: (hash: string) => void
  clearUpload: (sha256: string) => void
  reset: () => void
}

const EMPTY = {
  images: [] as MediaFrame[],
  audio: [] as AudioLibraryItemFrame[],
  uploadsEnabled: null,
  uploads: {} as Record<string, PendingUpload>,
} satisfies Partial<MediaState>

function capped<T>(list: T[], item: T): T[] {
  return [...list.slice(-(MAX_ITEMS - 1)), item]
}

export const useMediaStore = create<MediaState>()((set, get) => ({
  ...EMPTY,

  ingest: (frame) => {
    switch (frame.type) {
      case "media":
        set((state) => ({ images: capped(state.images, frame) }))
        return true
      case "audio_library_item":
        set((state) => ({ audio: capped(state.audio, frame) }))
        return true
      case "media_enabled":
        set({ uploadsEnabled: frame.enabled })
        return true
      case "media_accept":
        void resolveAccept(frame, set, get)
        return true
      case "error":
        // The refusal side of an upload. `_handle_media_offer` replies with
        // `media_disabled` or `media_rate_limited` and sends nothing else, so
        // without this the offer would sit at "offering" forever and the deck
        // would keep inviting a player to try again.
        //
        // `media_disabled` also teaches this client something it has no other
        // way to learn: the engine unicasts `media_enabled` only to the keeper
        // who flipped it, and the welcome does not carry the flag, so a player
        // who joined afterwards has `uploadsEnabled: null` for the whole
        // session (UPSTREAM_TODO item 14). The refusal is the one moment the
        // server states the room's policy to them, so it is recorded.
        if (frame.code === "media_disabled") set({ uploadsEnabled: false })
        if (frame.code === "media_disabled" || frame.code === "media_rate_limited") {
          failOfferingUploads(set, get, `play.media.err.${frame.code}`)
        }
        // NOT consumed: an error still belongs in the chronicle, where every
        // other refusal the player sees is shown.
        return false
      default:
        return false
    }
  },

  upload: async (path) => {
    if (!isTauri()) return
    let offer
    try {
      offer = await mediaPrepare(path)
    } catch (cause) {
      // Nothing is pending yet, so there is no row to attach this to — the
      // caller surfaces it.
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
    set((state) => ({
      uploads: {
        ...state.uploads,
        [offer.sha256]: { ...offer, path, phase: "offering", error: null },
      },
    }))
    try {
      await transportSend({
        type: "media_offer",
        name: offer.name,
        mime: offer.mime,
        size: offer.size,
        sha256: offer.sha256,
      })
    } catch (cause) {
      set((state) => ({
        uploads: {
          ...state.uploads,
          [offer.sha256]: {
            ...state.uploads[offer.sha256],
            phase: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          },
        },
      }))
    }
  },

  setUploadsEnabled: (enabled) => {
    void transportSend({ type: "media_set_enabled", enabled }).catch(() => {
      // The transport surfaces failures through status events.
    })
  },

  setAvatar: (hash) => {
    void transportSend({ type: "avatar_set", hash }).catch(() => {
      // As above.
    })
  },

  clearUpload: (sha256) =>
    set((state) => {
      const uploads = { ...state.uploads }
      delete uploads[sha256]
      return { uploads }
    }),

  reset: () => set({ ...EMPTY }),
}))

/** Mark every offer still waiting for an answer as failed. The server replies
 * to a refused `media_offer` with one error frame and nothing else, and it
 * names no hash — so whatever is still `offering` is what it refused. */
function failOfferingUploads(
  set: (fn: (state: MediaState) => Partial<MediaState>) => void,
  get: () => MediaState,
  errorKey: string,
): void {
  const stalled = Object.keys(get().uploads).filter((key) => get().uploads[key].phase === "offering")
  if (stalled.length === 0) return
  set((state) => {
    const uploads = { ...state.uploads }
    for (const key of stalled) uploads[key] = { ...uploads[key], phase: "error", error: errorKey }
    return { uploads }
  })
}

/** Finish one accepted offer. Split out because it is the only async path in
 * `ingest`, and `ingest` must stay synchronous for the frame router. */
async function resolveAccept(
  frame: MediaAcceptFrame,
  set: (fn: (state: MediaState) => Partial<MediaState>) => void,
  get: () => MediaState,
): Promise<void> {
  // The accept names the blob only through the metadata it echoes back, so an
  // `existing` accept is matched by hash and a fresh one by whichever upload is
  // still waiting for bytes.
  const hash = frame.media?.hash ?? frame.audio?.hash ?? ""
  const uploads = get().uploads
  const sha256 =
    hash && uploads[hash] !== undefined
      ? hash
      : (Object.keys(uploads).find((key) => uploads[key].phase === "offering") ?? "")
  if (sha256 === "") return

  if (frame.existing === true || frame.upload_id === "") {
    // The room already holds these bytes; the metadata rode along with the
    // accept and the server has broadcast nothing new.
    set((state) => ({
      uploads: { ...state.uploads, [sha256]: { ...state.uploads[sha256], phase: "done" } },
      images: frame.media ? capped(state.images, frame.media) : state.images,
      audio: frame.audio ? capped(state.audio, frame.audio) : state.audio,
    }))
    return
  }

  const pending = uploads[sha256]
  set((state) => ({
    uploads: { ...state.uploads, [sha256]: { ...state.uploads[sha256], phase: "sending" } },
  }))
  try {
    await mediaUpload(pending.path, frame.upload_id, pending.sha256)
    set((state) => ({
      uploads: { ...state.uploads, [sha256]: { ...state.uploads[sha256], phase: "done" } },
    }))
  } catch (cause) {
    set((state) => ({
      uploads: {
        ...state.uploads,
        [sha256]: {
          ...state.uploads[sha256],
          phase: "error",
          error: cause instanceof Error ? cause.message : String(cause),
        },
      },
    }))
  }
}
