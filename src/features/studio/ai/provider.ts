// AI provider settings + the draft/validate/retry loop. Only CONFIG persists
// here (zustand → localStorage); the API key goes straight to the OS
// credential store via the Rust side and never touches JS-visible storage.

import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import {
  aiAvailable,
  llmChat,
  secretDelete,
  secretExists,
  secretSet,
  type LlmMessage,
  type LlmProviderConfig,
  type LlmSamplingParams,
} from "../../../lib/native"
import { extractJsonBlock } from "./schemas"

/** One fixed credential-store slot: the studio configures a single provider. */
export const SECRET_ACCOUNT = "llm-api-key"

export interface AiSettingsState {
  kind: "openai" | "anthropic"
  baseUrl: string
  model: string
  maxTokens: number
  /** Cached "a key exists in the credential store" flag (probed, never the key). */
  keyStored: boolean
  /** Path to a checkout of the main repo — enables the `python -m app` CLI route. */
  engineRepoDir: string

  setConfig: (
    patch: Partial<Pick<AiSettingsState, "kind" | "baseUrl" | "model" | "maxTokens" | "engineRepoDir">>,
  ) => void
  storeKey: (key: string) => Promise<void>
  forgetKey: () => Promise<void>
  probeKey: () => Promise<void>
}

export const useAiStore = create<AiSettingsState>()(
  persist(
    (set) => ({
      kind: "openai",
      baseUrl: "",
      model: "",
      maxTokens: 4096,
      keyStored: false,
      engineRepoDir: "",

      setConfig: (patch) => set(patch),

      storeKey: async (key) => {
        await secretSet(SECRET_ACCOUNT, key)
        set({ keyStored: true })
      },

      forgetKey: async () => {
        await secretDelete(SECRET_ACCOUNT)
        set({ keyStored: false })
      },

      probeKey: async () => {
        set({ keyStored: await secretExists(SECRET_ACCOUNT) })
      },
    }),
    {
      name: "loreweaver-studio-ai",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        kind: state.kind,
        baseUrl: state.baseUrl,
        model: state.model,
        maxTokens: state.maxTokens,
        engineRepoDir: state.engineRepoDir,
      }),
    },
  ),
)

/** Whether the AI buttons light up: native shell + endpoint + model + stored key. */
export function aiReady(state: Pick<AiSettingsState, "baseUrl" | "model" | "keyStored">): boolean {
  return aiAvailable() && state.baseUrl.trim() !== "" && state.model.trim() !== "" && state.keyStored
}

function currentConfig(sampling?: LlmSamplingParams): LlmProviderConfig {
  const state = useAiStore.getState()
  return {
    kind: state.kind,
    baseUrl: state.baseUrl.trim(),
    model: state.model.trim(),
    secretAccount: SECRET_ACCOUNT,
    maxTokens: state.maxTokens,
    sampling,
  }
}

/** Hard ceiling on ONE model call. The Rust side already timeouts the HTTP
 * request (180s) and the keychain read (60s), but a hung invoke must never
 * leave the UI in a busy state forever — this is the belt to those braces. */
export const CHAT_CALL_TIMEOUT_MS = 240_000

export async function chatOnce(
  system: string,
  messages: LlmMessage[],
  sampling?: LlmSamplingParams,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          "LLM call timed out — check for an OS keychain authorization dialog and the provider endpoint",
        ),
      )
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
