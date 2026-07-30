// The auto-import pipeline wizard (③): files in → deterministic classify /
// split → promotion → AI-drafted metadata (human-confirmed) → source tree on
// disk → the ENGINE builds (and optionally installs) the .lwpack. Every step
// can be paused, edited, or re-done — the pipeline is glass, not a black box.

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import {
  aiAvailable,
  formatCliCommand,
  pickCardFile,
  pickDirectory,
  probeEngineCli,
  readFileByPath,
  runEngineCli,
  writePackSource,
  type PickedFile,
} from "../../../lib/native"
import { isTauri } from "../../../lib/transport"
import {
  buildDraftFromState,
  packExposeLines,
  packValidationIssues,
  usePackStore,
  type PackItem,
  type PackStep,
  PACK_STEPS,
} from "../../../store/pack"
import { aiFillLabels } from "../ai/labels"
import { PACK_METADATA_SYSTEM } from "../ai/prompts"
import { aiReady, draftWithRetries, useAiStore } from "../ai/provider"
import { draftToPackMetadata } from "../ai/schemas"
import { payloadsAny } from "../split/cardSplit"
import { buildPackSourcePlan } from "../split/packSource"
import PromoteTable from "../split/PromoteTable"

function ItemRow({ item }: { item: PackItem }) {
  const { t } = useTranslation()
  const updateItem = usePackStore((s) => s.updateItem)
  const removeItem = usePackStore((s) => s.removeItem)
  const kindLocked = item.payloads !== null && payloadsAny(item.payloads)

  return (
    <div className="pack-item">
      <div className="pack-item-head">
        <span className="pack-item-name" title={item.sourceName}>
          {item.sourceName}
        </span>
        <select
          value={item.kind}
          aria-label={t("studio.pack.itemKind")}
          onChange={(e) => updateItem(item.uid, { kind: e.target.value as PackItem["kind"] })}
          disabled={item.card !== null}
        >
          <option value="card">{t("studio.pack.kinds.card")}</option>
          <option value="lorebook">{t("studio.pack.kinds.lorebook")}</option>
          <option value="asset">{t("studio.pack.kinds.asset")}</option>
        </select>
        {item.kind === "card" ? (
          <select
            value={item.cardKind}
            aria-label={t("studio.pack.cardKind")}
            onChange={(e) => updateItem(item.uid, { cardKind: e.target.value as "character" | "world" })}
            disabled={kindLocked}
            title={kindLocked ? t("studio.pack.kindLocked") : undefined}
          >
            <option value="character">{t("studio.pack.cardKinds.character")}</option>
            <option value="world">{t("studio.pack.cardKinds.world")}</option>
          </select>
        ) : null}
        <button type="button" className="ghost-button" onClick={() => removeItem(item.uid)}>
          {t("studio.remove")}
        </button>
      </div>

      {item.kind === "card" && item.payloads !== null ? (
        <p className="studio-hint">
          {t("studio.split.counts", {
            hooks: item.payloads.hooks,
            vars: item.payloads.initvarEntries,
            ejs: item.payloads.ejsBlocks,
          })}
          {item.card?.name ? ` · ${item.card.name}` : ""}
        </p>
      ) : null}
      {item.kind === "lorebook" ? (
        <p className="studio-hint">{t("studio.pack.lorebookEntries", { n: item.entryCount })}</p>
      ) : null}

      <label className="field">
        {t("studio.pack.fileName")}
        <input
          value={item.fileName}
          onChange={(e) => updateItem(item.uid, { fileName: e.target.value })}
          spellCheck={false}
        />
      </label>
      {item.kind === "card" ? (
        <>
          {item.hooks.length > 0 && item.jsonText !== null ? (
            <label className="pack-checkbox">
              <input
                type="checkbox"
                checked={item.extractSkill}
                onChange={(e) => updateItem(item.uid, { extractSkill: e.target.checked })}
              />
              {t("studio.pack.extractSkill")}
            </label>
          ) : null}
          {item.hooks.length > 0 && item.jsonText === null ? (
            <p className="studio-hint">{t("studio.pack.pngHooksStay")}</p>
          ) : null}
          <label className="field">
            {t("studio.pack.notesZh")}
            <textarea
              rows={2}
              value={item.notesZh}
              onChange={(e) => updateItem(item.uid, { notesZh: e.target.value })}
            />
          </label>
          <label className="field">
            {t("studio.pack.notesEn")}
            <textarea
              rows={2}
              value={item.notesEn}
              onChange={(e) => updateItem(item.uid, { notesEn: e.target.value })}
            />
          </label>
        </>
      ) : null}
    </div>
  )
}

export default function PackWizard() {
  const { t } = useTranslation()
  const store = usePackStore()
  const aiSettings = useAiStore()
  const [busy, setBusy] = useState(false)
  const [aiProblems, setAiProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const dropRef = useRef<HTMLDivElement | null>(null)

  // Native drag-drop (Tauri swallows HTML5 DnD): file paths arrive as an event.
  useEffect(() => {
    if (!isTauri()) return
    let dispose: (() => void) | undefined
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return
        const paths = event.payload.paths
        void (async () => {
          const files: PickedFile[] = []
          for (const path of paths) {
            try {
              files.push(await readFileByPath(path))
            } catch {
              // directories and unreadable entries are skipped
            }
          }
          if (files.length > 0) await usePackStore.getState().addFiles(files)
        })()
      })
      .then((fn) => {
        dispose = fn
      })
    return () => dispose?.()
  }, [])

  const onBrowserDrop = async (event: React.DragEvent) => {
    event.preventDefault()
    const files: PickedFile[] = []
    for (const file of Array.from(event.dataTransfer.files)) {
      files.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), path: null })
    }
    if (files.length > 0) await store.addFiles(files)
  }

  const addViaPicker = async () => {
    const file = await pickCardFile()
    if (file !== null) await store.addFiles([file])
  }

  const draftMetadataWithAi = async () => {
    setBusy(true)
    setError(null)
    setAiProblems([])
    try {
      const summary = {
        cards: store.items
          .filter((item) => item.kind === "card")
          .map((item) => ({
            file: item.fileName,
            kind: item.cardKind,
            name: item.card?.name ?? "",
            creator_notes: item.card?.creatorNotes.slice(0, 400) ?? "",
            tags: item.card?.tags ?? [],
            hooks: item.hooks.length,
            variable_leaves: item.leaves.length,
            existing_notes: { en: item.notesEn, zh: item.notesZh },
          })),
        lorebooks: store.items.filter((item) => item.kind === "lorebook").map((item) => item.fileName),
        assets: store.items.filter((item) => item.kind === "asset").map((item) => item.fileName),
        expose_commands: packExposeLines(store.items),
      }
      const result = await draftWithRetries(
        PACK_METADATA_SYSTEM,
        [{ role: "user", content: JSON.stringify(summary, null, 1) }],
        (parsed) => {
          const gated = draftToPackMetadata(parsed)
          return { value: gated.metadata, problems: gated.problems }
        },
      )
      if (result.value === null) {
        setAiProblems(result.problems)
        return
      }
      const metadata = result.value
      store.setMetadata({
        id: metadata.id,
        version: metadata.version,
        nameEn: metadata.nameEn,
        nameZh: metadata.nameZh,
        descriptionEn: metadata.descriptionEn,
        descriptionZh: metadata.descriptionZh,
        authors: metadata.authors.join(", "),
        license: metadata.license || store.metadata.license,
      })
      if (metadata.cardNotesEn || metadata.cardNotesZh) {
        for (const item of store.items) {
          if (item.kind === "card" && item.cardKind === "world") {
            usePackStore.getState().updateItem(item.uid, {
              notesEn: metadata.cardNotesEn || item.notesEn,
              notesZh: metadata.cardNotesZh || item.notesZh,
            })
          }
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const aiLabelsFor = async (item: PackItem) => {
    setBusy(true)
    try {
      const drafts = await aiFillLabels(item.drafts)
      usePackStore.getState().updateItem(item.uid, { drafts })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const chooseOutputDir = async () => {
    const dir = await pickDirectory()
    if (dir !== null) store.setOutputDir(dir)
  }

  const writeSource = async () => {
    if (store.outputDir === null) return
    setError(null)
    const draft = buildDraftFromState(store.items, store.metadata)
    const plan = buildPackSourcePlan(draft)
    const root = `${store.outputDir}/${plan.dirName}`
    try {
      await writePackSource(root, { files: plan.files, binaries: plan.binaries }, false)
      store.setWritten(root)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (
        message.includes("already exists") &&
        window.confirm(t("studio.pack.overwriteConfirm", { dir: root }))
      ) {
        try {
          await writePackSource(root, { files: plan.files, binaries: plan.binaries }, true)
          store.setWritten(root)
          setError(null)
          return
        } catch (retryCause) {
          setError(retryCause instanceof Error ? retryCause.message : String(retryCause))
          return
        }
      }
      setError(message)
    }
  }

  const probe = async () => {
    store.setCandidates(await probeEngineCli(aiSettings.engineRepoDir.trim() || null))
  }

  const candidate = store.candidates[store.selectedCandidate] ?? null
  const packArgs =
    store.writtenDir !== null && store.outputDir !== null
      ? [
          "--pack",
          store.writtenDir,
          "--out",
          `${store.outputDir}/${store.metadata.id}-${store.metadata.version}.lwpack`,
        ]
      : ["--pack", `<${t("studio.pack.sourceDirPlaceholder")}>`]

  const runPack = async () => {
    if (candidate === null || store.writtenDir === null || store.outputDir === null) return
    store.setRunning(true)
    store.setRunResult(null)
    setError(null)
    try {
      const outPath = `${store.outputDir}/${store.metadata.id}-${store.metadata.version}.lwpack`
      const result = await runEngineCli(candidate, ["--pack", store.writtenDir, "--out", outPath])
      store.setRunResult(result)
      if (result.code === 0) {
        store.setBuiltPackPath(outPath)
        if (store.installAfterBuild) {
          const install = await runEngineCli(candidate, ["--install", outPath, "--yes"])
          store.setRunResult(install)
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      store.setRunning(false)
    }
  }

  const runInstall = async () => {
    if (candidate === null || store.builtPackPath === null) return
    store.setRunning(true)
    setError(null)
    try {
      store.setRunResult(await runEngineCli(candidate, ["--install", store.builtPackPath, "--yes"]))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      store.setRunning(false)
    }
  }

  const issues = packValidationIssues(store.items, store.metadata)
  const stepIndex = PACK_STEPS.indexOf(store.step)
  const worldCards = store.items.filter((item) => item.kind === "card" && item.cardKind === "world")
  const canNext: Record<PackStep, boolean> = {
    input: store.items.length > 0,
    review: store.items.length > 0,
    promote: true,
    metadata: issues.length === 0,
    build: false,
  }

  const goto = (step: PackStep) => store.setStep(step)

  return (
    <div className="pack-wizard">
      <nav className="pack-steps" aria-label={t("studio.pack.stepsLabel")}>
        {PACK_STEPS.map((step, index) => (
          <button
            key={step}
            type="button"
            className={step === store.step ? "pack-step active" : "pack-step"}
            onClick={() => goto(step)}
            disabled={index > stepIndex + 1}
          >
            {index + 1}. {t(`studio.pack.steps.${step}`)}
          </button>
        ))}
        <div className="header-spacer" />
        <button type="button" className="ghost-button" onClick={() => store.reset()}>
          {t("studio.pack.reset")}
        </button>
      </nav>

      {error !== null ? (
        <p className="studio-notice split-error" role="alert">
          {error}
        </p>
      ) : null}
      {store.loadError !== null ? (
        <p className="studio-notice split-error" role="alert">
          {t("studio.split.parseFailed", { detail: store.loadError })}
        </p>
      ) : null}

      {store.step === "input" ? (
        <div
          ref={dropRef}
          className="pack-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => void onBrowserDrop(e)}
        >
          <p className="placeholder">{t("studio.pack.dropHint")}</p>
          <button type="button" className="ghost-button" onClick={() => void addViaPicker()}>
            {t("studio.pack.addFile")}
          </button>
          {store.items.length > 0 ? (
            <ul className="pack-file-list">
              {store.items.map((item) => (
                <li key={item.uid}>
                  <span>{item.sourceName}</span>
                  <span className="split-badge">{t(`studio.pack.kinds.${item.kind}`)}</span>
                  {item.kind === "card" ? (
                    <span className={item.cardKind === "world" ? "split-badge world" : "split-badge"}>
                      {t(`studio.pack.cardKinds.${item.cardKind}`)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {store.step === "review" ? (
        <div className="pack-panel">
          <p className="studio-hint">{t("studio.pack.reviewHint")}</p>
          {store.items.map((item) => (
            <ItemRow key={item.uid} item={item} />
          ))}
        </div>
      ) : null}

      {store.step === "promote" ? (
        <div className="pack-panel">
          {worldCards.length === 0 ? (
            <p className="placeholder">{t("studio.pack.noWorldCards")}</p>
          ) : (
            worldCards.map((item) => (
              <section key={item.uid} className="pack-promote-card">
                <h3>{item.card?.name || item.fileName}</h3>
                <PromoteTable
                  drafts={item.drafts}
                  truncated={item.leavesTruncated}
                  onDraft={(draftUid, patch) => store.updateDraft(item.uid, draftUid, patch)}
                  onAiFill={() => void aiLabelsFor(item)}
                  aiBusy={busy}
                  aiEnabled={aiReady(aiSettings)}
                />
              </section>
            ))
          )}
        </div>
      ) : null}

      {store.step === "metadata" ? (
        <div className="pack-panel">
          <div className="dialog-row">
            <button
              type="button"
              className="ghost-button"
              onClick={() => void draftMetadataWithAi()}
              disabled={!aiReady(aiSettings) || busy}
              title={aiReady(aiSettings) ? undefined : t("studio.ai.needsSetup")}
            >
              {busy ? t("studio.ai.working") : t("studio.pack.aiDraft")}
            </button>
            <span className="studio-hint">{t("studio.pack.aiDraftHint")}</span>
          </div>
          {aiProblems.length > 0 ? (
            <ul className="issue-list">
              {aiProblems.slice(0, 6).map((problem, index) => (
                <li key={index}>{problem}</li>
              ))}
            </ul>
          ) : null}
          <div className="pack-meta-grid">
            <label className="field">
              {t("studio.pack.meta.id")}
              <input
                value={store.metadata.id}
                onChange={(e) => store.setMetadata({ id: e.target.value })}
                placeholder="deep-pier"
                spellCheck={false}
              />
            </label>
            <label className="field field-narrow">
              {t("studio.pack.meta.version")}
              <input
                value={store.metadata.version}
                onChange={(e) => store.setMetadata({ version: e.target.value })}
                spellCheck={false}
              />
            </label>
            <label className="field">
              {t("studio.pack.meta.nameZh")}
              <input
                value={store.metadata.nameZh}
                onChange={(e) => store.setMetadata({ nameZh: e.target.value })}
              />
            </label>
            <label className="field">
              {t("studio.pack.meta.nameEn")}
              <input
                value={store.metadata.nameEn}
                onChange={(e) => store.setMetadata({ nameEn: e.target.value })}
              />
            </label>
            <label className="field field-wide">
              {t("studio.pack.meta.descriptionZh")}
              <textarea
                rows={2}
                value={store.metadata.descriptionZh}
                onChange={(e) => store.setMetadata({ descriptionZh: e.target.value })}
              />
            </label>
            <label className="field field-wide">
              {t("studio.pack.meta.descriptionEn")}
              <textarea
                rows={2}
                value={store.metadata.descriptionEn}
                onChange={(e) => store.setMetadata({ descriptionEn: e.target.value })}
              />
            </label>
            <label className="field">
              {t("studio.pack.meta.authors")}
              <input
                value={store.metadata.authors}
                onChange={(e) => store.setMetadata({ authors: e.target.value })}
                placeholder={t("studio.pack.meta.authorsPlaceholder")}
              />
            </label>
            <label className="field">
              {t("studio.pack.meta.license")}
              <input
                value={store.metadata.license}
                onChange={(e) => store.setMetadata({ license: e.target.value })}
                placeholder="CC-BY-4.0"
              />
            </label>
            <label className="field field-wide">
              {t("studio.pack.meta.rulepackPatch")}
              <textarea
                rows={4}
                value={store.metadata.rulepackPatch}
                onChange={(e) => store.setMetadata({ rulepackPatch: e.target.value })}
                placeholder={"extends: coc7\ndefaults:\n  San: 60"}
                spellCheck={false}
              />
            </label>
          </div>
          {issues.length > 0 ? (
            <ul className="issue-list">
              {issues.map((issue, index) => (
                <li key={index}>{t(`studio.pack.err.${issue.key}`, issue.params)}</li>
              ))}
            </ul>
          ) : (
            <p className="studio-notice" role="status">
              {t("studio.pack.metadataClean")}
            </p>
          )}
        </div>
      ) : null}

      {store.step === "build" ? (
        <div className="pack-panel">
          <h3>{t("studio.pack.writeTitle")}</h3>
          <div className="dialog-row">
            <button type="button" className="ghost-button" onClick={() => void chooseOutputDir()}>
              {t("studio.pack.chooseDir")}
            </button>
            <code className="pack-path">{store.outputDir ?? t("studio.pack.noDir")}</code>
            <button
              type="button"
              className="primary-button"
              onClick={() => void writeSource()}
              disabled={store.outputDir === null || issues.length > 0}
            >
              {t("studio.pack.writeSource")}
            </button>
          </div>
          {store.writtenDir !== null ? (
            <p className="studio-notice" role="status">
              {t("studio.pack.written", { dir: store.writtenDir })}
            </p>
          ) : null}

          <h3>{t("studio.pack.buildTitle")}</h3>
          <div className="dialog-row">
            <button type="button" className="ghost-button" onClick={() => void probe()}>
              {t("studio.pack.probe")}
            </button>
            {store.candidates.length > 0 ? (
              <select
                value={store.selectedCandidate}
                onChange={(e) => store.setSelectedCandidate(Number(e.target.value))}
                aria-label={t("studio.pack.engine")}
              >
                {store.candidates.map((entry, index) => (
                  <option key={index} value={index}>
                    {entry.kind === "bundled-binary"
                      ? entry.program
                      : `${entry.program} -m app (${entry.cwd})`}
                  </option>
                ))}
              </select>
            ) : (
              <span className="studio-hint">{t("studio.pack.noEngine")}</span>
            )}
          </div>
          <pre className="split-code pack-command">{formatCliCommand(candidate, packArgs)}</pre>
          <div className="dialog-row">
            <label className="pack-checkbox">
              <input
                type="checkbox"
                checked={store.installAfterBuild}
                onChange={(e) => store.setInstallAfterBuild(e.target.checked)}
              />
              {t("studio.pack.installAfter")}
            </label>
            <button
              type="button"
              className="primary-button"
              onClick={() => void runPack()}
              disabled={candidate === null || store.writtenDir === null || store.running}
            >
              {store.running ? t("studio.pack.running") : t("studio.pack.runBuild")}
            </button>
            {store.builtPackPath !== null && !store.installAfterBuild ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => void runInstall()}
                disabled={store.running}
              >
                {t("studio.pack.runInstall")}
              </button>
            ) : null}
          </div>
          {store.runResult !== null ? (
            <div className="pack-output">
              <p
                className={store.runResult.code === 0 ? "studio-notice" : "studio-notice split-error"}
                role="status"
              >
                {store.runResult.timedOut
                  ? t("studio.pack.timedOut")
                  : t("studio.pack.exitCode", { code: store.runResult.code ?? "?" })}
                {store.builtPackPath !== null && store.runResult.code === 0
                  ? ` · ${store.builtPackPath}`
                  : ""}
              </p>
              <pre className="split-code pack-terminal">
                {[store.runResult.stderr, store.runResult.stdout].filter(Boolean).join("\n") ||
                  t("studio.pack.noOutput")}
              </pre>
            </div>
          ) : null}
          {!aiAvailable() ? <p className="studio-notice">{t("studio.pack.desktopOnly")}</p> : null}
        </div>
      ) : null}

      <div className="pack-nav">
        {stepIndex > 0 ? (
          <button type="button" className="ghost-button" onClick={() => goto(PACK_STEPS[stepIndex - 1])}>
            {t("studio.pack.back")}
          </button>
        ) : null}
        <div className="header-spacer" />
        {stepIndex < PACK_STEPS.length - 1 ? (
          <button
            type="button"
            className="primary-button"
            onClick={() => goto(PACK_STEPS[stepIndex + 1])}
            disabled={!canNext[store.step]}
          >
            {t("studio.pack.next")}
          </button>
        ) : null}
      </div>
    </div>
  )
}
