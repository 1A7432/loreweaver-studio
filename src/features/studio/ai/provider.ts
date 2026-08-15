// AI provider settings + the draft/validate/retry loop. Everything persists
// here (zustand → localStorage), the API key included.
//
// The key used to live in the OS credential store. That bought a real property
// — a compromised WebView could USE the key but never read it — at a price the
// app cannot pay: the `keyring` crate has no Android backend at all, and its
// Linux one needs a running Secret Service daemon, so the desktop-only path was
// a dead end for a Tauri app that means to ship on five platforms. On macOS it
// also re-prompted after every rebuild with a modal that could hang a draft for
// eighteen minutes. One path that works everywhere beats a stronger one that
// works in two places. The key is a local secret in a local app; treat this
// file's storage as no more private than the rest of the session.

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { guardedLocalStorage } from "../../../lib/persistStorage"
import {
  aiAvailable,
  llmChat,
  type LlmMessage,
  type LlmProviderConfig,
  type LlmSamplingParams,
} from "../../../lib/native"
import { extractJsonBlock } from "./schemas"

export interface AiSettingsState {
  kind: "openai" | "anthropic"
  baseUrl: string
  model: string
  maxTokens: number
  apiKey: string
  /** Path to a checkout of the main repo — enables the `python -m app` CLI route. */
  engineRepoDir: string

  setConfig: (
    patch: Partial<
      Pick<AiSettingsState, "kind" | "baseUrl" | "model" | "maxTokens" | "apiKey" | "engineRepoDir">
    >,
  ) => void
}

export const useAiStore = create<AiSettingsState>()(
  persist(
    (set) => ({
      kind: "openai",
      baseUrl: "",
      model: "",
      // 0 = no cap of our own: the OpenAI-compatible payload omits `max_tokens`
      // entirely and the provider applies ITS OWN maximum. That is the only
      // right answer from here — a number invented in this app truncates the
      // draft mid-JSON when it is low, and 400s when it is above a model's
      // output ceiling (which is NOT its context window: kimi-k3 is 1M context
      // and nothing like 1M output). The engine does the same: `max_tokens`
      // appears once in its whole provider layer, inside the Anthropic adapter,
      // because that API requires it.
      maxTokens: 0,
      apiKey: "",
      engineRepoDir: "",

      setConfig: (patch) => set(patch),
    }),
    {
      name: "loreweaver-studio-ai",
      storage: guardedLocalStorage,
      partialize: (state) => ({
        kind: state.kind,
        baseUrl: state.baseUrl,
        model: state.model,
        maxTokens: state.maxTokens,
        apiKey: state.apiKey,
        engineRepoDir: state.engineRepoDir,
      }),
    },
  ),
)

/** Whether the AI buttons light up: native shell + endpoint + model + key. */
export function aiReady(state: Pick<AiSettingsState, "baseUrl" | "model" | "apiKey">): boolean {
  return (
    aiAvailable() && state.baseUrl.trim() !== "" && state.model.trim() !== "" && state.apiKey.trim() !== ""
  )
}

function currentConfig(sampling?: LlmSamplingParams): LlmProviderConfig {
  const state = useAiStore.getState()
  return {
    kind: state.kind,
    baseUrl: state.baseUrl.trim(),
    model: state.model.trim(),
    apiKey: state.apiKey.trim(),
    ...(state.maxTokens > 0 ? { maxTokens: state.maxTokens } : {}),
    sampling,
  }
}

/** Hard ceiling on ONE model call. The Rust side already timeouts the HTTP
 * request (180s), but a hung invoke must never leave the UI in a busy state
 * forever — this is the belt to that brace. */
export const CHAT_CALL_TIMEOUT_MS = 240_000

export async function chatOnce(
  system: string,
  messages: LlmMessage[],
  sampling?: LlmSamplingParams,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("LLM call timed out — check the provider endpoint and model"))
    }, CHAT_CALL_TIMEOUT_MS)
  })
  try {
    return await Promise.race([llmChat(currentConfig(sampling), system, messages), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export interface DraftLoopResult<T> {
  value: T | null
  /** The raw model reply behind `value` (kept for the next conversation turn). */
  reply: string
  /** Problems from the last failed attempt (empty on success). */
  problems: string[]
  attempts: number
}

/** The draft → deterministic-validate → retry loop. `gate` is pure code; its
 * problem list is appended as a user turn so the model can self-correct. */
export async function draftWithRetries<T>(
  system: string,
  history: LlmMessage[],
  gate: (parsed: unknown) => { value: T | null; problems: string[] },
  maxAttempts = 3,
  sampling?: LlmSamplingParams,
): Promise<DraftLoopResult<T>> {
  const messages: LlmMessage[] = [...history]
  let problems: string[] = []
  let reply = ""
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    reply = await chatOnce(system, messages, sampling)
    const parsed = extractJsonBlock(reply)
    const gated =
      parsed === null
        ? { value: null, problems: ["reply did not contain a parseable JSON object"] }
        : gate(parsed)
    if (gated.value !== null) {
      return { value: gated.value, reply, problems: [], attempts: attempt }
    }
    problems = gated.problems
    messages.push({ role: "assistant", content: reply })
    messages.push({
      role: "user",
      content: `Validation rejected that draft. Fix these problems and output the corrected JSON object only:\n- ${problems.join("\n- ")}`,
    })
  }
  return { value: null, reply, problems, attempts: maxAttempts }
}
