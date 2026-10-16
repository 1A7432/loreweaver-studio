// Session reports (protocol 2.4 `report` frame): `.report html` and the
// keeper-key-only `.report html reveal`.
//
// The frame reaches ONLY the connection that asked, and is never replayed, so
// this is the one place the offer exists — dismiss it and it is gone (the
// command can be run again). On arrival the bytes are pulled straight away
// through the verified native path (`lib/report.ts` → `src-tauri/src/report.rs`),
// so a Save or Open never waits on the network and never touches unverified
// bytes. The HTML itself is NEVER rendered here: the protocol forbids a client
// from displaying it inside its own UI. It leaves as a file the person saves,
// or as a file handed to the system browser.

import { create } from "zustand"
import { downloadDir, join } from "@tauri-apps/api/path"
import { save } from "@tauri-apps/plugin-dialog"
import type { ReportFrame, ServerFrame } from "@loreweaver/protocol"
import { reportFetch, reportOpen, reportSave, safeReportName } from "../lib/report"
import { isTauri } from "../lib/transport"

export type ReportPhase = "fetching" | "ready" | "error"
export type ReportVariant = ReportFrame["variant"]

export interface ReportOffer {
  hash: string
  /** The server's suggestion, already reduced to a safe base file name. */
  fileName: string
  size: number
  variant: ReportVariant
  phase: ReportPhase
  /** Why the fetch failed: an i18n key under `play.report.err.` or a verbatim
   * native message. Only set in phase `error`. */
  error: string | null
  /** A save or open that failed. The verified bytes are still good, so the
   * offer stays `ready` and the action can be tried again. */
  actionError: string | null
  /** Where the last Save put it. */
  savedPath: string | null
  /** A save dialog or open is in flight. */
  busy: boolean
}

/** A table that asks twice keeps both; one that asks a dozen times does not
 * need a dozen banners. */
const MAX_OFFERS = 3

interface ReportState {
  /** Bumped on every `reset`. Async completions from a prior session no-op. */
  epoch: number
  /** Newest last. */
  offers: ReportOffer[]
  ingest: (frame: ServerFrame) => boolean
  /** Native save dialog, then copy the verified file to the chosen path. */
  save: (hash: string) => Promise<void>
  /** Hand the verified file to the system browser. */
  openInBrowser: (hash: string) => Promise<void>
  dismiss: (hash: string) => void
  reset: () => void
}

/** Fail-safe on the spoiler cue: anything that is not explicitly the player
 * edition is shown as the reveal edition. A false warning costs a glance; a
 * missing one costs a campaign. */
export function reportVariant(variant: unknown): ReportVariant {
  return variant === "player" ? "player" : "reveal"
}

/** A native failure as an i18n key where the cause is one the person can act
 * on, else the message verbatim. */
export function reportErrorKey(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes("hash mismatch")) return "play.report.err.checksum"
  if (message.startsWith("media_not_found")) return "play.report.err.notFound"
  if (message.startsWith("not a report")) return "play.report.err.notHtml"
  if (message === "not connected") return "play.report.err.offline"
  return message
}

/** The save dialog opens in Downloads when the platform has one — where the
 * reference client saves too — and on the bare name otherwise. */
async function defaultSavePath(fileName: string): Promise<string> {
  try {
    return await join(await downloadDir(), fileName)
  } catch {
    return fileName
  }
}

export const useReportStore = create<ReportState>()((set, get) => {
  const patch = (epoch: number, hash: string, change: Partial<ReportOffer>) => {
    if (get().epoch !== epoch) return
    set((state) => ({
      offers: state.offers.map((offer) => (offer.hash === hash ? { ...offer, ...change } : offer)),
    }))
  }
  const find = (hash: string) => get().offers.find((offer) => offer.hash === hash)

  return {
    epoch: 0,
    offers: [],

    ingest: (frame) => {
      if (frame.type !== "report") return false
      const hash = String(frame.hash ?? "").toLowerCase()
      const offer: ReportOffer = {
        hash,
        fileName: safeReportName(frame.name, hash),
        size: typeof frame.size === "number" ? frame.size : 0,
        variant: reportVariant(frame.variant),
        phase: isTauri() ? "fetching" : "error",
        error: isTauri() ? null : "play.report.err.unavailable",
        actionError: null,
        savedPath: null,
        busy: false,
      }
      // The same bytes announced again replace their old row (and its state).
      set((state) => ({
        offers: [...state.offers.filter((o) => o.hash !== hash), offer].slice(-MAX_OFFERS),
      }))
      if (offer.phase === "fetching") {
        const epoch = get().epoch
        reportFetch(hash)
          .then(() => patch(epoch, hash, { phase: "ready" }))
          .catch((cause: unknown) => patch(epoch, hash, { phase: "error", error: reportErrorKey(cause) }))
      }
      return true
    },

    save: async (hash) => {
      const offer = find(hash)
      if (offer === undefined || offer.phase !== "ready" || offer.busy) return
      const epoch = get().epoch
      patch(epoch, hash, { busy: true, actionError: null })
      try {
        // The native dialog asks before replacing an existing file, so a
        // chosen path is one the person confirmed — nothing is overwritten
        // silently.
        const path = await save({
          defaultPath: await defaultSavePath(offer.fileName),
          filters: [{ name: "HTML", extensions: ["html"] }],
        })
        if (path === null) {
          patch(epoch, hash, { busy: false })
          return
        }
        await reportSave(hash, path)
        patch(epoch, hash, { busy: false, savedPath: path })
      } catch (cause) {
        patch(epoch, hash, { busy: false, actionError: reportErrorKey(cause) })
      }
    },

    openInBrowser: async (hash) => {
      const offer = find(hash)
      if (offer === undefined || offer.phase !== "ready" || offer.busy) return
      const epoch = get().epoch
      patch(epoch, hash, { busy: true, actionError: null })
      try {
        await reportOpen(hash, offer.fileName)
        patch(epoch, hash, { busy: false })
      } catch (cause) {
        patch(epoch, hash, { busy: false, actionError: reportErrorKey(cause) })
      }
    },

    dismiss: (hash) => set((state) => ({ offers: state.offers.filter((offer) => offer.hash !== hash) })),

    reset: () => set((state) => ({ offers: [], epoch: state.epoch + 1 })),
  }
})
