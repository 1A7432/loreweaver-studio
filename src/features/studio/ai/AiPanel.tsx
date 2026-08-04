// AI card drafting: natural language → validated draft → the SAME editor as
// hand-made cards. Drafts that fail deterministic validation never land; the
// panel shows what was rejected and lets the conversation continue.

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import type { LlmMessage } from "../../../lib/native"
import { useStudioStore } from "../../../store/studio"
import type { ForgeProject } from "../model"
import { useActivePreset, usePresetStore } from "./presetStore"
import { CHARACTER_CARD_SYSTEM, WORLD_CARD_SYSTEM } from "./prompts"
import { aiReady, draftWithRetries, useAiStore } from "./provider"
import { deepseekProTemperatureConflict } from "./providerPresets"
import { draftToProject } from "./schemas"
import { assembleSystemPrompt, toLlmSampling, type MarkerSlot } from "./stPreset"

type DraftMode = "world" | "character"

export default function AiPanel({
  onClose,
  onOpenSettings,
  onOpenPresets,
}: {
  onClose: () => void
  onOpenSettings: () => void
  onOpenPresets: () => void
}) {
  const { t } = useTranslation()
  const importProject = useStudioStore((s) => s.importProject)
  const settings = useAiStore()
  const ready = aiReady(settings)
  const presets = usePresetStore((s) => s.presets)
  const setActivePreset = usePresetStore((s) => s.setActive)
  const activePreset = useActivePreset()

  const [mode, setMode] = useState<DraftMode>("world")
  const [input, setInput] = useState("")
  const [history, setHistory] = useState<LlmMessage[]>([])
  const [draft, setDraft] = useState<ForgeProject | null>(null)
  const [problems, setProblems] = useState<string[]>([])
  const [attempts, setAttempts] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const builtinSystem = mode === "world" ? WORLD_CARD_SYSTEM : CHARACTER_CARD_SYSTEM

  // With a preset active, its assembled text leads and the built-in JSON
  // contract follows — the deterministic gate stays enforceable either way.
  // Marker slots are fed from THIS conversation's own context: the current
  // draft's prose (nothing on the first turn — anchors simply stay empty).
  const assembled = useMemo(() => {
    if (activePreset === null) return null
    const slots: Partial<Record<MarkerSlot, string>> = {}
    if (draft !== null) {
      slots.charDescription = draft.description
      slots.charPersonality = draft.personality
      slots.scenario = draft.scenario
    }
    return assembleSystemPrompt(activePreset, activePreset.overrides, slots)
  }, [activePreset, draft])

  const system =
    assembled === null || assembled.system === "" ? builtinSystem : `${assembled.system}\n\n${builtinSystem}`
  const sampling = useMemo(() => {
    if (activePreset === null) return undefined
    const params = toLlmSampling(activePreset.sampling)
    return Object.keys(params).length > 0 ? params : undefined
  }, [activePreset])
  const deepseekWarning = deepseekProTemperatureConflict(settings.model, sampling)

  const generate = async () => {
    const prompt = input.trim()
    if (!prompt || busy) return
    setBusy(true)
    setError(null)
    setProblems([])
    const messages: LlmMessage[] = [...history, { role: "user", content: prompt }]
    try {
      const result = await draftWithRetries(
        system,
        messages,
        (parsed) => {
          const gated = draftToProject(parsed)
          return { value: gated.project, problems: gated.problems }
        },
        3,
        sampling,
      )
      setAttempts(result.attempts)
      if (result.value !== null) {
        setDraft(result.value)
        setHistory([...messages, { role: "assistant", content: result.reply }])
        setInput("")
      } else {
        setProblems(result.problems)
        // Keep the failed exchange out of history: the next attempt restarts
        // from the user's description rather than a rejected reply.
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const apply = () => {
    if (draft === null) return
    importProject(draft)
    onClose()
  }

  const startOver = () => {
    setHistory([])
    setDraft(null)
    setProblems([])
    setAttempts(0)
    setError(null)
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog-wide"
        role="dialog"
        aria-label={t("studio.ai.panelTitle")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t("studio.ai.panelTitle")}</h2>
        {!ready ? (
          <p className="studio-notice">
            {t("studio.ai.needsSetup")}{" "}
            <button type="button" className="link-button" onClick={onOpenSettings}>
              {t("studio.ai.openSettings")}
            </button>
          </p>
        ) : null}

        <div className="dialog-row">
          <label className="field field-narrow">
            {t("studio.ai.mode")}
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as DraftMode)}
              disabled={history.length > 0}
            >
              <option value="world">{t("studio.ai.modes.world")}</option>
              <option value="character">{t("studio.ai.modes.character")}</option>
            </select>
          </label>
          <label className="field field-narrow">
            {t("studio.ai.promptPreset")}
            <select
              value={activePreset?.id ?? ""}
              onChange={(e) => setActivePreset(e.target.value === "" ? null : e.target.value)}
              disabled={history.length > 0}
            >
              <option value="">{t("studio.ai.builtinPrompts")}</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name || t("studio.untitled")}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="link-button" onClick={onOpenPresets}>
            {t("studio.ai.managePresets")}
          </button>
          {history.length > 0 ? (
            <button type="button" className="ghost-button" onClick={startOver}>
              {t("studio.ai.startOver")}
            </button>
          ) : null}
        </div>

        {activePreset !== null && assembled !== null ? (
          <p className="studio-hint">
            {t("studio.ai.presetInUse", {
              name: activePreset.name,
              segments: assembled.segmentCount,
              slots: assembled.usedSlots.length,
            })}
          </p>
        ) : null}
        {deepseekWarning ? (
          <p className="studio-notice" role="alert">
            {t("studio.ai.deepseekProTempWarning")}
          </p>
        ) : null}

        <label className="field">
          {draft === null ? t("studio.ai.describe") : t("studio.ai.refine")}
          <textarea
            rows={5}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t(
              mode === "world" ? "studio.ai.worldPlaceholder" : "studio.ai.characterPlaceholder",
            )}
          />
        </label>
        <div className="dialog-row">
          <button
            type="button"
            className="primary-button"
            onClick={() => void generate()}
            disabled={!ready || busy || !input.trim()}
          >
            {busy
              ? t("studio.ai.working")
              : draft === null
                ? t("studio.ai.generate")
                : t("studio.ai.regenerate")}
          </button>
        </div>

        {error !== null ? (
          <p className="studio-notice split-error" role="alert">
            {error}
          </p>
        ) : null}
        {problems.length > 0 ? (
          <div className="ai-problems">
            <p className="studio-notice" role="alert">
              {t("studio.ai.rejected", { n: attempts })}
            </p>
            <ul className="issue-list">
              {problems.slice(0, 8).map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {draft !== null ? (
          <div className="ai-draft-summary">
            <h3>{draft.name || t("studio.untitled")}</h3>
            <p className="studio-hint">
              {t("studio.ai.summary", {
                vars: draft.variables.length,
                lore: draft.lorebook.length,
                hooks: draft.hooks.trim() ? 1 : 0,
              })}
            </p>
            {draft.description ? <p className="ai-draft-description">{draft.description}</p> : null}
            <div className="dialog-actions">
              <button type="button" className="primary-button" onClick={apply}>
                {t("studio.ai.apply")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
