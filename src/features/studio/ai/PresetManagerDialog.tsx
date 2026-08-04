// ST prompt-preset import + management. Import parses/normalizes the file
// (nothing dropped — unknown fields ride in raw), previews it grouped by
// resolved enablement (slots / effective / disabled), and only "save" lands
// it as a local asset. Checkbox tweaks go to the overrides layer, so the
// imported two-layer matrix itself stays exact and revertible.

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { pickJsonFile, saveTextAs } from "../../../lib/native"
import { usePresetStore, type StoredPreset } from "./presetStore"
import {
  effectivePromptList,
  isEffectivelyEnabled,
  parseStPreset,
  unsentSamplingKeys,
  type EffectivePrompt,
  type StPresetImport,
} from "./stPreset"

const WARNING_DISPLAY_CAP = 8

function presetSizeKb(preset: StPresetImport): number {
  return Math.max(1, Math.round(JSON.stringify(preset).length / 1024))
}

function effectiveCount(preset: StPresetImport, overrides: Record<string, boolean>): number {
  return effectivePromptList(preset).filter((view) => isEffectivelyEnabled(view, overrides)).length
}

// --- one prompt row ---------------------------------------------------------

function EntryRow({
  view,
  effective,
  onToggle,
}: {
  view: EffectivePrompt
  effective: boolean
  onToggle: (identifier: string, enabled: boolean) => void
}) {
  const { t } = useTranslation()
  const { entry } = view
  const layers = `prompts: ${view.promptEnabled ? "on" : "off"} · order: ${
    view.orderEnabled === null ? t("studio.ai.presets.notInOrder") : view.orderEnabled ? "on" : "off"
  }`
  return (
    <li className="preset-entry" title={layers}>
      <label className="pack-checkbox">
        <input
          type="checkbox"
          checked={effective}
          onChange={(e) => onToggle(entry.identifier, e.target.checked)}
        />
        <span className="preset-entry-name">
          {entry.marker
            ? entry.slot !== null
              ? t(`studio.ai.presets.slots.${entry.slot}`)
              : entry.identifier
            : entry.name || entry.identifier}
        </span>
      </label>
      <span className="chip-row">
        {entry.marker ? <span className="chip chip-ai">{t("studio.ai.presets.slotChip")}</span> : null}
        <span className="chip">{entry.role}</span>
        {entry.injectionPosition === 1 ? <span className="chip">@{entry.injectionDepth}</span> : null}
        {!entry.marker ? (
          <span className="chip chip-off">{t("studio.ai.presets.chars", { n: entry.content.length })}</span>
        ) : null}
      </span>
    </li>
  )
}

function EntryGroup({
  title,
  views,
  overrides,
  onToggle,
}: {
  title: string
  views: EffectivePrompt[]
  overrides: Record<string, boolean>
  onToggle: (identifier: string, enabled: boolean) => void
}) {
  if (views.length === 0) return null
  return (
    <section className="preset-group">
      <h4>
        {title} ({views.length})
      </h4>
      <ul className="preset-entry-list">
        {views.map((view) => (
          <EntryRow
            key={view.entry.identifier}
            view={view}
            effective={isEffectivelyEnabled(view, overrides)}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </section>
  )
}

// --- full preset detail (shared by pending preview + stored assets) ---------

function PresetDetail({
  preset,
  overrides,
  onToggle,
}: {
  preset: StPresetImport
  overrides: Record<string, boolean>
  onToggle: (identifier: string, enabled: boolean) => void
}) {
  const { t } = useTranslation()
  const views = useMemo(() => effectivePromptList(preset), [preset])
  const markers = views.filter((view) => view.entry.marker)
  const plain = views.filter((view) => !view.entry.marker)
  const enabledViews = plain.filter((view) => isEffectivelyEnabled(view, overrides))
  const disabledViews = plain.filter((view) => !isEffectivelyEnabled(view, overrides))
  const samplingEntries = Object.entries(preset.sampling)
  const unsent = new Set<string>(unsentSamplingKeys(preset.sampling))
  const extensionKeys = Object.keys(preset.extensions)

  return (
    <div className="preset-detail">
      {samplingEntries.length > 0 ? (
        <section className="preset-group">
          <h4>{t("studio.ai.presets.sampling")}</h4>
          <div className="chip-row">
            {samplingEntries.map(([key, value]) => (
              <span key={key} className={unsent.has(key) ? "chip chip-off" : "chip chip-on"}>
                {key}={String(value)}
              </span>
            ))}
          </div>
          {samplingEntries.some(([key]) => unsent.has(key)) ? (
            <p className="studio-hint">{t("studio.ai.presets.samplingUnsentHint")}</p>
          ) : null}
        </section>
      ) : null}

      <section className="preset-group">
        <h4>{t("studio.ai.presets.macros")}</h4>
        {preset.macroReport.total === 0 ? (
          <p className="studio-hint">{t("studio.ai.presets.noMacros")}</p>
        ) : (
          <>
            <div className="chip-row">
              {preset.macroReport.uses.map((use) => (
                <span key={use.name} className={use.supported ? "chip chip-on" : "chip"}>
                  {`{{${use.name}}}`} ×{use.count}
                </span>
              ))}
            </div>
            <p className="studio-hint">
              {t("studio.ai.presets.macroHint", {
                total: preset.macroReport.total,
                supported: preset.macroReport.uses.filter((use) => use.supported).length,
                kinds: preset.macroReport.uses.length,
              })}
            </p>
          </>
        )}
      </section>

      {extensionKeys.length > 0 ? (
        <section className="preset-group">
          <h4>{t("studio.ai.presets.extensions")}</h4>
          <div className="chip-row">
            {extensionKeys.map((key) => (
              <span key={key} className="chip chip-off">
                {key}
              </span>
            ))}
          </div>
          <p className="studio-hint">{t("studio.ai.presets.extensionsHint")}</p>
        </section>
      ) : null}

      {preset.warnings.length > 0 ? (
        <section className="preset-group">
          <h4>{t("studio.ai.presets.warnings", { n: preset.warnings.length })}</h4>
          <ul className="issue-list">
            {preset.warnings.slice(0, WARNING_DISPLAY_CAP).map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
            {preset.warnings.length > WARNING_DISPLAY_CAP ? (
              <li>
                {t("studio.ai.presets.moreWarnings", { n: preset.warnings.length - WARNING_DISPLAY_CAP })}
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      <EntryGroup
        title={t("studio.ai.presets.groupSlots")}
        views={markers}
        overrides={overrides}
        onToggle={onToggle}
      />
      <EntryGroup
        title={t("studio.ai.presets.groupEnabled")}
        views={enabledViews}
        overrides={overrides}
        onToggle={onToggle}
      />
      <EntryGroup
        title={t("studio.ai.presets.groupDisabled")}
        views={disabledViews}
        overrides={overrides}
        onToggle={onToggle}
      />
      {preset.malformedPrompts.length > 0 ? (
        <p className="studio-hint">
          {t("studio.ai.presets.malformedKept", { n: preset.malformedPrompts.length })}
        </p>
      ) : null}
    </div>
  )
}

// --- the dialog -------------------------------------------------------------

interface PendingImport {
  preset: StPresetImport
  overrides: Record<string, boolean>
}

export default function PresetManagerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const presets = usePresetStore((s) => s.presets)
  const activeId = usePresetStore((s) => s.activeId)
  const addPreset = usePresetStore((s) => s.addPreset)
  const removePreset = usePresetStore((s) => s.removePreset)
  const renamePreset = usePresetStore((s) => s.renamePreset)
  const setActive = usePresetStore((s) => s.setActive)
  const setOverride = usePresetStore((s) => s.setOverride)

  const [pending, setPending] = useState<PendingImport | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const selected = presets.find((preset) => preset.id === selectedId) ?? null

  const importFile = async () => {
    setImportError(null)
    setNotice(null)
    const file = await pickJsonFile()
    if (file === null) return
    const text = new TextDecoder().decode(file.bytes)
    const fallbackName = file.name.replace(/\.json$/i, "")
    const { preset, error } = parseStPreset(text, fallbackName)
    if (preset === null) {
      setImportError(t("studio.ai.presets.parseFailed", { detail: error ?? "?" }))
      return
    }
    setPending({ preset, overrides: {} })
    setSelectedId(null)
  }

  const savePending = () => {
    if (pending === null) return
    const id = addPreset(pending.preset, pending.overrides)
    setPending(null)
    setSelectedId(id)
    setNotice(t("studio.ai.presets.saved"))
  }

  const exportPreset = async (preset: StoredPreset) => {
    const saved = await saveTextAs(`${preset.name}.stpreset.json`, JSON.stringify(preset, null, 2))
    setNotice(t(saved ? "studio.ai.presets.exported" : "studio.ai.presets.exportCopied"))
  }

  const body = () => {
    if (pending !== null) {
      return (
        <>
          <div className="dialog-row preset-head">
            <h3>{pending.preset.name}</h3>
            <span className="studio-hint">
              {t("studio.ai.presets.stats", {
                total: pending.preset.prompts.length,
                enabled: effectiveCount(pending.preset, pending.overrides),
                kb: presetSizeKb(pending.preset),
              })}
            </span>
          </div>
          <PresetDetail
            preset={pending.preset}
            overrides={pending.overrides}
            onToggle={(identifier, enabled) =>
              setPending((current) =>
                current === null
                  ? null
                  : { ...current, overrides: { ...current.overrides, [identifier]: enabled } },
              )
            }
          />
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={() => setPending(null)}>
              {t("studio.ai.presets.discard")}
            </button>
            <button type="button" className="primary-button" onClick={savePending}>
              {t("studio.ai.presets.save")}
            </button>
          </div>
        </>
      )
    }

    if (selected !== null) {
      return (
        <>
          <div className="dialog-row preset-head">
            <button type="button" className="ghost-button" onClick={() => setSelectedId(null)}>
              {t("studio.ai.presets.back")}
            </button>
            <input
              className="preset-name-input"
              value={selected.name}
              onChange={(e) => renamePreset(selected.id, e.target.value)}
              aria-label={t("studio.ai.presets.name")}
            />
            <span className="studio-hint">
              {t("studio.ai.presets.stats", {
                total: selected.prompts.length,
                enabled: effectiveCount(selected, selected.overrides),
                kb: presetSizeKb(selected),
              })}
            </span>
          </div>
          <PresetDetail
            preset={selected}
            overrides={selected.overrides}
            onToggle={(identifier, enabled) => setOverride(selected.id, identifier, enabled)}
          />
        </>
      )
    }

    return (
      <>
        {presets.length === 0 ? (
          <p className="studio-hint">{t("studio.ai.presets.empty")}</p>
        ) : (
          <ul className="preset-list">
            {presets.map((preset) => (
              <li key={preset.id} className="preset-row">
                <button type="button" className="link-button" onClick={() => setSelectedId(preset.id)}>
                  {preset.name || t("studio.untitled")}
                </button>
                <span className="studio-hint">
                  {t("studio.ai.presets.stats", {
                    total: preset.prompts.length,
                    enabled: effectiveCount(preset, preset.overrides),
                    kb: presetSizeKb(preset),
                  })}
                </span>
                <span className="header-spacer" />
                {activeId === preset.id ? (
                  <span className="split-badge ok">{t("studio.ai.presets.activeBadge")}</span>
                ) : (
                  <button type="button" className="ghost-button" onClick={() => setActive(preset.id)}>
                    {t("studio.ai.presets.setActive")}
                  </button>
                )}
                <button type="button" className="ghost-button" onClick={() => void exportPreset(preset)}>
                  {t("studio.ai.presets.export")}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => {
                    if (window.confirm(t("studio.ai.presets.deleteConfirm", { name: preset.name }))) {
                      removePreset(preset.id)
                      if (selectedId === preset.id) setSelectedId(null)
                    }
                  }}
                >
                  {t("studio.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {activeId !== null ? (
          <button type="button" className="link-button" onClick={() => setActive(null)}>
            {t("studio.ai.presets.deactivate")}
          </button>
        ) : null}
        <p className="studio-hint">{t("studio.ai.presets.packHint")}</p>
      </>
    )
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog dialog-wide preset-dialog"
        role="dialog"
        aria-label={t("studio.ai.presets.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t("studio.ai.presets.title")}</h2>
        <div className="dialog-row">
          <button
            type="button"
            className="primary-button"
            onClick={() => void importFile()}
            disabled={pending !== null}
          >
            {t("studio.ai.presets.import")}
          </button>
        </div>
        {importError !== null ? (
          <p className="studio-notice split-error" role="alert">
            {importError}
          </p>
        ) : null}
        {notice !== null ? (
          <p className="studio-notice" role="status">
            {notice}
          </p>
        ) : null}
        {body()}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>
            {t("studio.ai.done")}
          </button>
        </div>
      </div>
    </div>
  )
}
