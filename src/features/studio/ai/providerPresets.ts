// Built-in provider presets for the settings dialog: picking one fills
// baseUrl + kind; the model list is a suggestion (datalist), never a lock.
// The single-provider + OS-credential-store architecture is untouched — a
// preset is just a form filler.

export type ProviderPresetId = "deepseek" | "openai" | "anthropic" | "custom"

export interface ProviderPreset {
  id: ProviderPresetId
  kind: "openai" | "anthropic"
  baseUrl: string
  /** Suggested model ids, best default first. Editable free-text in the UI. */
  models: string[]
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    id: "openai",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5", "gpt-5-mini", "gpt-4o"],
  },
  {
    id: "anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"],
  },
  { id: "custom", kind: "openai", baseUrl: "", models: [] },
]

/** Which preset the current settings look like (baseUrl match → custom). */
export function matchProviderPreset(baseUrl: string, kind: "openai" | "anthropic"): ProviderPresetId {
  const trimmed = baseUrl.trim().replace(/\/+$/, "")
  const hit = PROVIDER_PRESETS.find(
    (preset) => preset.id !== "custom" && preset.baseUrl === trimmed && preset.kind === kind,
  )
  return hit?.id ?? "custom"
}

/** deepseek v4-pro degrades its thinking mode when temperature is pinned —
 * the pairing deserves a warning, not a hard block. */
export function deepseekProTemperatureConflict(
  model: string,
  sampling: { temperature?: number } | undefined,
): boolean {
  const id = model.trim().toLowerCase()
  return id.includes("deepseek") && id.includes("pro") && sampling?.temperature !== undefined
}
