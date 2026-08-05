// The typed face of the one-click local-hosting bridge (host_local.rs). Same
// shape as the transport bridge: commands in, a single event stream out.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

export const HOST_LOCAL_EVENT = "loreweaver://host-local"

export type HostLocalEvent =
  | { kind: "log"; level: string; text: string }
  | { kind: "ready"; ticket: string; key: string }
  | { kind: "exit"; code: number | null }
  | { kind: "error"; message: string }

export interface HostLocalStatus {
  running: boolean
  home: string
}

export async function hostLocalStart(engineRepoDir?: string, homeOverride?: string): Promise<void> {
  await invoke("host_local_start", {
    engineRepoDir: engineRepoDir || null,
    homeOverride: homeOverride || null,
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
