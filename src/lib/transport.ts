// The typed face of the Rust transport bridge. All networking happens in the
// Tauri core; the WebView only invokes commands and consumes events.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { ClientFrame } from "@loreweaver/protocol"

export const TRANSPORT_EVENT = "loreweaver://transport"

/** Mirrors `ConnectionStatus` in @loreweaver/protocol and `ConnStatus` in Rust. */
export type TransportStatus = "connecting" | "online" | "reconnecting" | "offline"

/** Why a connection that never came online gave up — mirrors `ErrorCode` in
 * the Rust transport. Only these three are worded by the UI; any other failure
 * arrives as `error` text alone and is shown as it came. */
export type TransportErrorCode = "connect_timeout" | "join_timeout" | "connect_failed"

/**
 * One event from the Tauri bridge. `connectionId` is a **bridge** generation
 * — it is not a protocol field and must never be written onto a wire frame.
 * Auto-reconnects keep the same id; only an explicit connect mints a new one.
 */
export type TransportEvent =
  | {
      kind: "status"
      connectionId: string
      status: TransportStatus
      attempt: number
      error?: string | null
      /** The machine-readable twin of `error` for the failures above. */
      errorCode?: TransportErrorCode | null
    }
  | { kind: "frame"; connectionId: string; frame: unknown }

/** One explicit dial's identity, and where it sits in the order the Rust slot
 * refuses a dial the WebView has already outrun by. Mirrors `SlotOwner`. */
export interface ConnectionGeneration {
  /** Bridge generation for this dial; stamped on every forwarded event. */
  connectionId: string
  /** The page load that minted it. */
  session: string
  /** Its place in that page load's order. */
  seq: number
}

export interface TransportConnectParams {
  ticket: string
  key: string
  name?: string
  generation: ConnectionGeneration
}

/** What a caller supplies for one dial. The generation is not theirs to mint:
 * the connection store owns it, because it owns what the generation gates. */
export type DialParams = Omit<TransportConnectParams, "generation">

/** One page load = one transport session, with its own generation counter.
 *
 * The counter alone cannot be trusted across a reload: a fresh page starts at
 * 1 again while the Rust slot still holds an epoch from the page before it, so
 * a rule written on numbers alone would fence the live page out behind a dead
 * one and leave the app unable to connect to anything. The session id is what
 * tells the slot which of the two is the page that is actually here. */
const TRANSPORT_SESSION = globalThis.crypto.randomUUID()
let generations = 0

/** Fresh generation for one explicit `transport_connect`. Not a protocol field. */
export function createConnection(): ConnectionGeneration {
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

export async function transportConnect(params: TransportConnectParams): Promise<void> {
  await invoke("transport_connect", { ...params })
}

/** Drop the actor this generation seated. The slot tears down only its own
 * occupant, so a disconnect a newer dial has already outrun does nothing —
 * and `null` (a page holding no generation of its own) drops nothing at all. */
export async function transportDisconnect(connectionId: string | null): Promise<void> {
  await invoke("transport_disconnect", { connectionId })
}

export async function transportSend(frame: ClientFrame): Promise<void> {
  await invoke("transport_send", { frame })
}

export function onTransportEvent(handler: (event: TransportEvent) => void): Promise<UnlistenFn> {
  return listen<TransportEvent>(TRANSPORT_EVENT, (event) => handler(event.payload))
}
