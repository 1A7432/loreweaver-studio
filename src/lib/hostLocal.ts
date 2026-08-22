// The typed face of the one-click local-hosting bridge (host_local.rs). Same
// shape as the transport bridge: commands in, a single event stream out.
//
// Every event carries `hostId`. The store's `ingest` is the single WebView
// filter: a Rust emit-before-check cannot see frames already in the Tauri/JS
// queue, which is how a late Ready after Exit (or a queued Exit after a new
// start) used to land on the wrong session.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

export const HOST_LOCAL_EVENT = "loreweaver://host-local"

export type HostLocalEventKind =
  | { kind: "log"; level: string; text: string }
  | { kind: "ready"; ticket: string; key: string }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; message: string }

export type HostLocalEvent = { hostId: string } & HostLocalEventKind

export interface HostLocalStatus {
  running: boolean
  home: string
  /** The server's `TRPG_DATA_DIR` (`<home>/data`) — where an installed pack
   * has to land for this server to resolve `<packId>/…` refs against it. */
  dataDir: string
  /** Host session id of the live child. Adopted after a WebView reload so
   * a later Exit still belongs to this table. */
  hostId: string | null
}

/** Mint a host session id. The WebView owns the mint so it can filter
 * queued events the moment `start` begins, before Rust has seated a child. */
export function mintHostId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `host-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Whether `ingest` should apply this event. Current id accepts everything;
 * the stopping id accepts only the confirming Exit (stop already left ready). */
export function hostEventApplies(
  event: HostLocalEvent,
  hostId: string | null,
  stoppingHostId: string | null,
): boolean {
  if (hostId !== null && event.hostId === hostId) return true
  return stoppingHostId !== null && event.hostId === stoppingHostId && event.kind === "exit"
}

/** `devSourceRoot` turns the engine's author dev-room surface on for this
 * server (`TRPG_DEV__SOURCE_ROOT`, `gateway/dev_room.py`): `.dev mount` resolves
 * only under it, and the surface is off entirely while it is unset. It is read
 * at startup, so switching it means starting a server, not reconfiguring one. */
export async function hostLocalStart(
  engineRepoDir?: string,
  homeOverride?: string,
  devSourceRoot?: string,
  hostId?: string,
): Promise<void> {
  await invoke("host_local_start", {
    engineRepoDir: engineRepoDir || null,
    homeOverride: homeOverride || null,
    devSourceRoot: devSourceRoot || null,
    hostId: hostId || null,
  })
}

export async function hostLocalStop(): Promise<boolean> {
  return invoke("host_local_stop")
}

export async function hostLocalStatus(homeOverride?: string): Promise<HostLocalStatus> {
  return invoke("host_local_status", { homeOverride: homeOverride || null })
}

export function onHostLocalEvent(handler: (event: HostLocalEvent) => void): Promise<UnlistenFn> {
  return listen<HostLocalEvent>(HOST_LOCAL_EVENT, (event) => handler(event.payload))
}
