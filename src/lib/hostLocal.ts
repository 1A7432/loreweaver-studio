// The typed face of "Host locally & play" (`src-tauri/src/host_local.rs`): start a
// protocol 3.0 server on this machine and get back what it takes to sit down at it
// as the room admin; stop it; hear about it if it dies on its own.
//
// `start` resolves once the server printed its ready line (a bounded wait in Rust)
// and rejects with a `HostFailure` — a code and its details, worded by the screen.

import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"

export const HOST_LOCAL_EVENT = "loreweaver://host-local"

/** Where the admin key came from: the server's first key, the one this app kept, or
 * a new one made because the app had lost the key of a folder already in use. */
export type KeySource = "first" | "kept" | "minted"

export interface HostReady {
  hostId: string
  ticket: string
  /** The room admin's access key. A secret: it goes to the connection and nowhere else. */
  key: string
  room: string
  keySource: KeySource
  /** The server's start-up notes, as its codes (`model_not_configured`, …). */
  notes: string[]
  version: string
  dataDir: string
  /** The server was already running for this folder; this is its ready again. */
  reused: boolean
}

export interface ConfigProblem {
  variable: string
  problem: string
}

export interface EngineProblem {
  kind: string
  program: string
  problem: string
}

export type HostFailure =
  | { code: "no_engine"; engines: EngineProblem[] }
  | { code: "already_running"; dataDir: string }
  | { code: "refused"; refusal: string; problems: ConfigProblem[]; detail?: string | null }
  | { code: "exited"; exitCode: number | null; stderr: string[] }
  | { code: "timeout"; stderr: string[] }
  | { code: "cancelled" }
  | { code: "mint_failed"; refusal: string | null; stderr: string[] }
  | { code: "no_key" }
  | { code: "io"; detail: string }

/** A hosted server that died on its own. */
export interface HostExited {
  hostId: string
  code: number | null
  stderr: string[]
}

export interface HostLocalStatus {
  /** The folder a start would use now. */
  home: string
  dataDir: string
  running: boolean
}

const FAILURE_CODES: ReadonlySet<string> = new Set([
  "no_engine",
  "already_running",
  "refused",
  "exited",
  "timeout",
  "cancelled",
  "mint_failed",
  "no_key",
  "io",
])

/** What `start` rejected with, as a `HostFailure` (anything else becomes `io`). */
export function asHostFailure(cause: unknown): HostFailure {
  if (
    typeof cause === "object" &&
    cause !== null &&
    typeof (cause as { code?: unknown }).code === "string" &&
    FAILURE_CODES.has((cause as { code: string }).code)
  ) {
    return cause as HostFailure
  }
  return { code: "io", detail: cause instanceof Error ? cause.message : String(cause) }
}

export async function hostLocalStart(params: {
  engineRepoDir?: string
  homeOverride?: string
  locale?: string
}): Promise<HostReady> {
  return invoke<HostReady>("host_local_start", {
    engineRepoDir: params.engineRepoDir || null,
    homeOverride: params.homeOverride || null,
    locale: params.locale || null,
  })
}

/** Stop the server (or the start in progress); resolves once it is gone. */
export async function hostLocalStop(): Promise<boolean> {
  return invoke<boolean>("host_local_stop")
}

export async function hostLocalStatus(homeOverride?: string): Promise<HostLocalStatus> {
  return invoke<HostLocalStatus>("host_local_status", { homeOverride: homeOverride || null })
}

/** Forget the admin key kept for a folder: the next start makes a new one. */
export async function hostLocalForgetKey(homeOverride?: string): Promise<boolean> {
  return invoke<boolean>("host_local_forget_key", { homeOverride: homeOverride || null })
}

export function onHostLocalExit(handler: (event: HostExited) => void): Promise<UnlistenFn> {
  return listen<HostExited>(HOST_LOCAL_EVENT, (event) => handler(event.payload))
}
