// The typed face of the Rust transport bridge. All networking happens in the
// Tauri core; the WebView only invokes commands and consumes events.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { ClientFrame } from "@loreweaver/protocol"

export const TRANSPORT_EVENT = "loreweaver://transport"

/** Mirrors `ConnectionStatus` in @loreweaver/protocol and `ConnStatus` in Rust. */
export type TransportStatus = "connecting" | "online" | "reconnecting" | "offline"

export type TransportEvent =
  | { kind: "status"; status: TransportStatus; attempt: number; error?: string | null }
  | { kind: "frame"; frame: unknown }

export interface TransportConnectParams {
  ticket: string
  key: string
  name?: string
}

/** True when running inside the Tauri shell (false in vitest / plain browser). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

export async function transportConnect(params: TransportConnectParams): Promise<void> {
  await invoke("transport_connect", { ...params })
}

export async function transportDisconnect(): Promise<void> {
  await invoke("transport_disconnect")
}

export async function transportSend(frame: ClientFrame): Promise<void> {
  await invoke("transport_send", { frame })
}

export function onTransportEvent(handler: (event: TransportEvent) => void): Promise<UnlistenFn> {
  return listen<TransportEvent>(TRANSPORT_EVENT, (event) => handler(event.payload))
}
