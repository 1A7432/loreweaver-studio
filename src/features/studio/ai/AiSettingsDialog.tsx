// Provider settings: endpoint + model persist locally; the API key goes
// straight to the OS credential store and is never displayed back.

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { aiAvailable, pickDirectory } from "../../../lib/native"
import { useActivePreset } from "./presetStore"
import { useAiStore } from "./provider"
import {
  deepseekProTemperatureConflict,
  matchProviderPreset,
  PROVIDER_PRESETS,
  type ProviderPresetId,
} from "./providerPresets"

export default function AiSettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const settings = useAiStore()
  const activePreset = useActivePreset()
  const [keyInput, setKeyInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerPresetId = matchProviderPreset(settings.baseUrl, settings.kind)
  const modelSuggestions = PROVIDER_PRESETS.find((preset) => preset.id === providerPresetId)?.models ?? []
  const deepseekWarning = deepseekProTemperatureConflict(settings.model, activePreset?.sampling)

  const applyProviderPreset = (id: ProviderPresetId) => {
    const preset = PROVIDER_PRESETS.find((candidate) => candidate.id === id)
    if (preset === undefined || preset.id === "custom") return
    settings.setConfig({
      kind: preset.kind,
      baseUrl: preset.baseUrl,
      // Keep a hand-typed model; only fill the blank.
      ...(settings.model.trim() === "" && preset.models.length > 0 ? { model: preset.models[0] } : {}),
    })
  }

  useEffect(() => {
    void settings.probeKey()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- probe once on open
  }, [])

  const saveKey = async () => {
    if (!keyInput.trim()) return
    setSaving(true)
    setError(null)
    try {
      await settings.storeKey(keyInput.trim())
      setKeyInput("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const forgetKey = async () => {
    setSaving(true)
    setError(null)
    try {
      await settings.forgetKey()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const browseRepo = async () => {
    const dir = await pickDirectory()
    if (dir !== null) settings.setConfig({ engineRepoDir: dir })
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label={t("studio.ai.settingsTitle")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t("studio.ai.settingsTitle")}</h2>
        {!aiAvailable() ? <p className="studio-notice">{t("studio.ai.desktopOnly")}</p> : null}

        <label className="field">
          {t("studio.ai.providerPreset")}
          <select
            value={providerPresetId}
            onChange={(e) => applyProviderPreset(e.target.value as ProviderPresetId)}
          >
            {PROVIDER_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {t(`studio.ai.providerPresets.${preset.id}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("studio.ai.kind")}
          <select
            value={settings.kind}
            onChange={(e) => settings.setConfig({ kind: e.target.value as "openai" | "anthropic" })}
          >
            <option value="openai">{t("studio.ai.kinds.openai")}</option>
            <option value="anthropic">{t("studio.ai.kinds.anthropic")}</option>
          </select>
        </label>
        <label className="field">
          {t("studio.ai.baseUrl")}
          <input
            value={settings.baseUrl}
            onChange={(e) => settings.setConfig({ baseUrl: e.target.value })}
            placeholder={
              settings.kind === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"
            }
            spellCheck={false}
          />
        </label>
        <label className="field">
          {t("studio.ai.model")}
          <input
            value={settings.model}
            onChange={(e) => settings.setConfig({ model: e.target.value })}
            placeholder={settings.kind === "openai" ? "gpt-4o" : "claude-sonnet-5"}
            spellCheck={false}
            list="ai-model-suggestions"
          />
          <datalist id="ai-model-suggestions">
            {modelSuggestions.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          {deepseekWarning ? (
            <p className="studio-notice" role="alert">
              {t("studio.ai.deepseekProTempWarning")}
            </p>
          ) : null}
        </label>
        <label className="field">
          {t("studio.ai.maxTokens")}
          <input
            type="number"
            min={256}
            max={32000}
            value={settings.maxTokens}
            onChange={(e) => settings.setConfig({ maxTokens: Number(e.target.value) || 4096 })}
          />
        </label>

        <div className="field">
          <span>
            {t("studio.ai.apiKey")}{" "}
            {settings.keyStored ? (
              <span className="split-badge ok">{t("studio.ai.keyStored")}</span>
            ) : (
              <span className="split-badge">{t("studio.ai.keyMissing")}</span>
            )}
          </span>
          <div className="dialog-row">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={t("studio.ai.keyPlaceholder")}
              autoComplete="off"
            />
            <button
              type="button"
              className="ghost-button"
              onClick={() => void saveKey()}
              disabled={saving || !keyInput.trim() || !aiAvailable()}
            >
              {t("studio.ai.saveKey")}
            </button>
            {settings.keyStored ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => void forgetKey()}
                disabled={saving}
              >
                {t("studio.ai.forgetKey")}
              </button>
            ) : null}
          </div>
          <p className="studio-hint">{t("studio.ai.keyHint")}</p>
        </div>

        <label className="field">
          {t("studio.ai.engineRepo")}
          <div className="dialog-row">
            <input
              value={settings.engineRepoDir}
              onChange={(e) => settings.setConfig({ engineRepoDir: e.target.value })}
              placeholder="…/loreweaver"
              spellCheck={false}
            />
            <button
              type="button"
              className="ghost-button"
              onClick={() => void browseRepo()}
              disabled={!aiAvailable()}
            >
              {t("studio.ai.browse")}
            </button>
          </div>
          <p className="studio-hint">{t("studio.ai.engineRepoHint")}</p>
        </label>

        {error !== null ? (
          <p className="studio-notice split-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            {t("studio.ai.done")}
          </button>
        </div>
      </div>
    </div>
  )
}
