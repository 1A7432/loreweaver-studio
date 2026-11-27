// The typed face of the Rust link bridge (protocol 3.0). All networking happens
// in the Tauri core; the WebView only invokes commands and consumes events.
//
// The link is PLAIN: it dials a ticket, opens the control stream, carries one
// JSON object per line both ways and reports `connecting` / `up` / `closed`. It
// writes no frame of its own and never dials again — the protocol `Session`
// (`loreweaver-protocol/v3`) says `hello`, and the connection owner
// (`lib/connection.ts`) decides when to redial. One link = one bridge
// generation (`connectionId`), a redial included.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { ClientFrame } from "loreweaver-protocol/v3"

export const TRANSPORT_EVENT = "loreweaver://transport"

/** Mirrors `LinkStatus` in the Rust link. */
export type LinkStatus = "connecting" | "up" | "closed"

/** Why a link closed when the WebView did not close it — mirrors `CloseCode`
 * in the Rust link. The UI words each one (`connect.error.*`). */
export type LinkCloseCode =
  | "invalid_ticket"
  | "bind_failed"
  | "dial_timeout"
  | "dial_failed"
  | "protocol_violation"
  | "closed_by_peer"
  | "connection_lost"

/** How the endpoint finds the server: the public relays, or loopback only (a
 * server on this machine started with `serve --local`). Mirrors `NetworkProfile`. */
export type NetworkProfile = "n0" | "local"

/**
 * One event from the Tauri bridge. `connectionId` is a **bridge** generation —
 * not a protocol field, never written onto a wire frame.
 */
export type LinkEvent =
  | {
      kind: "status"
      connectionId: string
      status: LinkStatus
      /** English detail for logs, on a `closed` the WebView did not ask for. */
      reason?: string | null
      code?: LinkCloseCode | null
    }
  | { kind: "frame"; connectionId: string; frame: unknown }

/** One link's identity, and where it sits in the order the Rust slot refuses a
 * dial the WebView has already outrun by. Mirrors `SlotOwner`. */
export interface ConnectionGeneration {
  /** Bridge generation for this link; stamped on every forwarded event. */
  connectionId: string
  /** The page load that minted it. */
  session: string
  /** Its place in that page load's order. */
  seq: number
}

/** One page load = one transport session, with its own generation counter.
 *
 * The counter alone cannot be trusted across a reload: a fresh page starts at
 * 1 again while the Rust slot still holds an epoch from the page before it, so
 * a rule written on numbers alone would fence the live page out behind a dead
 * one and leave the app unable to connect to anything. The session id is what
 * tells the slot which of the two is the page that is actually here. */
const TRANSPORT_SESSION = globalThis.crypto.randomUUID()
let generations = 0

/** Fresh generation for one link. Not a protocol field. */
export function createGeneration(): ConnectionGeneration {
  generations += 1
  return {
    connectionId: globalThis.crypto.randomUUID(),
    session: TRANSPORT_SESSION,
    seq: generations,
  }
}

/** True when running inside the Tauri shell (false in vitest / plain browser). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

/** Seat a new link for `generation` (closing the one it replaces). Resolves once
 * the link is seated; its `connecting` / `up` / `closed` arrive as events. */
export async function linkConnect(params: {
  ticket: string
  network: NetworkProfile
  generation: ConnectionGeneration
}): Promise<void> {
  await invoke("transport_connect", { ...params })
}

/** Write one frame on the link `connectionId` names; refused when that link is
 * not the one seated. Resolves once the control stream accepted the line. */
export async function linkSend(connectionId: string, frame: ClientFrame): Promise<void> {
  await invoke("transport_send", { connectionId, frame })
}

/** Drop the link this generation seated. The slot tears down only its own
 * occupant, so a disconnect a newer dial has already outrun does nothing. */
export async function linkDisconnect(connectionId: string): Promise<void> {
  await invoke("transport_disconnect", { connectionId })
}

export function onLinkEvent(handler: (event: LinkEvent) => void): Promise<UnlistenFn> {
  return listen<LinkEvent>(TRANSPORT_EVENT, (event) => handler(event.payload))
}

/**
 * The 2.x screens' way to send a frame, kept so they compile until they move
 * to 3.0 (later steps). It sends NOTHING: a 2.x frame has no place on a 3.0
 * link, and anything on the wire must go through the protocol `Session` (which
 * says `hello` first and numbers every request). Callers already treat a
 * rejection as "not sent".
 */
export async function transportSend(frame: unknown): Promise<void> {
  void frame
  throw new Error("not_migrated: this screen still speaks protocol 2.x")
}
