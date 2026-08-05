// WebView ⇄ Rust bridge for the forge's native capabilities: file reads,
// pack-source writes, the engine CLI, the OS credential store, and the LLM
// proxy. Every function degrades sanely outside the Tauri shell (browser
// dev): file picking falls back to <input type=file>; everything that NEEDS
// the native side reports unavailability instead of pretending.

import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import { isTauri } from "./transport"

export interface PickedFile {
  name: string
  bytes: Uint8Array
  /** Absolute path when the file came from the native side; null in-browser. */
  path: string | null
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export async function readFileByPath(path: string): Promise<PickedFile> {
  const result = await invoke<{ name: string; base64: string }>("read_file_base64", { path })
  return { name: result.name, bytes: base64ToBytes(result.base64), path }
}

function pickViaBrowser(accept: string): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = accept
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      void file.arrayBuffer().then((buffer) => {
        resolve({ name: file.name, bytes: new Uint8Array(buffer), path: null })
      })
    }
    // Cancel never fires `change`; `cancel` is supported in modern WebViews.
    input.addEventListener("cancel", () => resolve(null))
    input.click()
  })
}

/** Pick + read one card file (JSON or PNG). */
export async function pickCardFile(): Promise<PickedFile | null> {
  if (isTauri()) {
    const path = await open({
      multiple: false,
      filters: [{ name: "Character card", extensions: ["json", "png"] }],
    })
    if (typeof path !== "string") return null
    return readFileByPath(path)
  }
  return pickViaBrowser(".json,.png,application/json,image/png")
}

/** Pick + read one JSON file (SillyTavern preset import). */
export async function pickJsonFile(): Promise<PickedFile | null> {
  if (isTauri()) {
    const path = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (typeof path !== "string") return null
    return readFileByPath(path)
  }
  return pickViaBrowser(".json,application/json")
}

/** Pick + read one PNG (the base/avatar image for the PNG-card export). */
export async function pickPngFile(): Promise<PickedFile | null> {
  if (isTauri()) {
    const path = await open({
      multiple: false,
      filters: [{ name: "PNG", extensions: ["png"] }],
    })
    if (typeof path !== "string") return null
    return readFileByPath(path)
  }
  return pickViaBrowser(".png,image/png")
}

/** Pick + read any number of files of any type (panel assets etc.). */
export async function pickAnyFiles(): Promise<PickedFile[]> {
  if (isTauri()) {
    const picked = await open({ multiple: true })
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : []
    const files: PickedFile[] = []
    for (const path of paths) files.push(await readFileByPath(path))
    return files
  }
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      void Promise.all(
        files.map(async (file) => ({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
          path: null,
        })),
      ).then(resolve)
    }
    input.addEventListener("cancel", () => resolve([]))
    input.click()
  })
}

/** Pick a directory (native only — the browser has no useful equivalent). */
export async function pickDirectory(): Promise<string | null> {
  if (!isTauri()) return null
  const path = await open({ directory: true, multiple: false })
  return typeof path === "string" ? path : null
}

export async function saveTextAs(defaultName: string, contents: string): Promise<boolean> {
  if (!isTauri()) {
    await navigator.clipboard.writeText(contents)
    return false
  }
  const path = await save({ defaultPath: defaultName })
  if (path === null) return false
  await invoke("write_text_file", { path, contents })
  return true
}

export interface PackWritePlan {
  files: { path: string; contents: string }[]
  binaries: { path: string; base64: string }[]
}

export async function writePackSource(
  rootDir: string,
  plan: PackWritePlan,
  overwrite: boolean,
): Promise<number> {
  return invoke<number>("write_pack_source", {
    rootDir,
    files: plan.files,
    binaries: plan.binaries,
    overwrite,
  })
}

export interface EngineCandidate {
  kind: "bundled-binary" | "python-module"
  program: string
  args: string[]
  cwd: string | null
}

export interface EngineRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function probeEngineCli(engineRepoDir: string | null): Promise<EngineCandidate[]> {
  if (!isTauri()) return []
  return invoke<EngineCandidate[]>("probe_engine_cli", { engineRepoDir })
}

export async function runEngineCli(candidate: EngineCandidate, args: string[]): Promise<EngineRunResult> {
  return invoke<EngineRunResult>("run_engine_cli", {
    program: candidate.program,
    args: [...candidate.args, ...args],
    cwd: candidate.cwd,
  })
}

/** Render the exact command line for display / copy-paste (when the engine
 * CLI is missing, the wizard shows this next to the source directory). */
export function formatCliCommand(candidate: EngineCandidate | null, args: string[]): string {
  const quote = (part: string) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)
  const program = candidate?.program ?? "python"
  const prefix = candidate?.args ?? ["-m", "app"]
  return [program, ...prefix, ...args].map(quote).join(" ")
}

// --- OS credential store (no secret_get on purpose: keys never come back) ---

export async function secretSet(account: string, value: string): Promise<void> {
  await invoke("secret_set", { account, value })
}

export async function secretExists(account: string): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>("secret_exists", { account })
}

export async function secretDelete(account: string): Promise<void> {
  await invoke("secret_delete", { account })
}

// --- LLM proxy ---

/** Optional sampling knobs forwarded to the provider. Every field is optional
 * and omitted from the wire payload when unset; the Rust side additionally
 * drops the keys a given API shape does not accept (seed/penalties are
 * OpenAI-only, topK is Anthropic-only). */
export interface LlmSamplingParams {
  temperature?: number
  topP?: number
  topK?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
}

export interface LlmProviderConfig {
  kind: "openai" | "anthropic"
  baseUrl: string
  model: string
  secretAccount: string
  maxTokens?: number
  sampling?: LlmSamplingParams
}

export interface LlmMessage {
  role: "user" | "assistant"
  content: string
}

export async function llmChat(
  config: LlmProviderConfig,
  system: string | null,
  messages: LlmMessage[],
): Promise<string> {
  return invoke<string>("llm_chat", { config, system, messages })
}

/** AI features need the native proxy + credential store. */
export function aiAvailable(): boolean {
  return isTauri()
}
