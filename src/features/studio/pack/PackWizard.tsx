// The auto-import pipeline wizard (③): files in → deterministic classify /
// split → promotion → AI-drafted metadata (human-confirmed) → source tree on
// disk → the ENGINE builds (and optionally installs) the .lwpack. Every step
// can be paused, edited, or re-done — the pipeline is glass, not a black box.

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { parse as parseYaml } from "yaml"
import {
  aiAvailable,
  formatCliCommand,
  pickAnyFiles,
  pickDirectory,
  probeEngineCli,
  readFileByPath,
  runEngineCli,
  writePackSource,
  type EngineCandidate,
  type PickedFile,
} from "../../../lib/native"
import { formatInstallCommand, installDataDir, installPack } from "../../../lib/packInstall"
import { isTauri } from "../../../lib/transport"
import { useHostLocalStore } from "../../../store/hostLocal"
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
import { isTestDriveErrorKey, useTestDriveStore } from "../../../store/testDrive"
import type { TestDriveMode } from "./testDrive"
import LintPanel from "../lint/LintPanel"
import { lintPack } from "../lint/packLint"
import { lintSourceFromPackBench } from "../lint/sources"
import { parsePackBuildJson, type PackBuildSuccess } from "./buildResult"
import {
  buildPackSourcePlan,
  MAX_PREP_OPERATIONS,
  MAX_PREP_SCRIPT_CHARS,
  PREP_DIR,
  presentationSummary,
  readPrepScript,
} from "../split/packSource"
import { readRulepack } from "../split/rulepack"
import { latestOrdinal, suggestedVersion, versionMatchesConvention } from "../split/episodes"
import PresentationStage from "./PresentationStage"
import PromoteTable from "../split/PromoteTable"
import type { Issue } from "../model"

function ItemRow({ item }: { item: PackItem }) {
  const { t } = useTranslation()
  const updateItem = usePackStore((s) => s.updateItem)
  const removeItem = usePackStore((s) => s.removeItem)
  const reattachItem = usePackStore((s) => s.reattachItem)
  const episodes = usePackStore((s) => s.episodes)

  const reattach = async () => {
    const files = await pickAnyFiles()
    if (files.length > 0) reattachItem(item.uid, files[0])
  }

  return (
    <div className="pack-item">
      {item.needsBytes ? (
        // The session came back from storage with everything except this file's
        // bytes. Nothing else was lost, and the build stays blocked until it
        // returns rather than shipping an empty file under the right name.
        <p className="studio-notice split-error" role="alert">
          {t("studio.pack.needsBytes", { name: item.sourceName, size: item.size })}{" "}
          <button type="button" className="ghost-button" onClick={() => void reattach()}>
            {t("studio.pack.reattach")}
          </button>
        </p>
      ) : null}
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
          // Manifest v2: the kind is a DETECTED readout, never an author
          // choice — the build stamps it from the real payload and install
          // re-verifies the stamp.
          <span
            className={item.cardKind === "world" ? "split-badge world" : "split-badge"}
            title={t("studio.pack.detectedKindHint")}
          >
            {t(`studio.pack.cardKinds.${item.cardKind}`)}
          </span>
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
            secret: item.payloads.secretEntries,
          })}
          {item.card?.name ? ` · ${item.card.name}` : ""}
          {` · ${t(item.cardKind === "world" ? "studio.pack.detectedWorld" : "studio.pack.detectedCharacter")}`}
        </p>
      ) : null}
      {item.kind === "lorebook" ? (
        <p className="studio-hint">{t("studio.pack.lorebookEntries", { n: item.entryCount })}</p>
      ) : null}
      {item.initvarProblems.length > 0 ? (
        // The card imported; these blocks contributed no variables.
        <ul className="issue-list">
          {item.initvarProblems.map((problem, index) => (
            <li key={index} className="split-error">
              {t(`studio.${problem.key}`, problem.params)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="dialog-row">
        <label className="field">
          {t("studio.pack.fileName")}
          <input
            value={item.fileName}
            onChange={(e) => updateItem(item.uid, { fileName: e.target.value })}
            spellCheck={false}
          />
        </label>
        {episodes.length > 0 ? (
          <label className="field field-narrow">
            {t("studio.pack.episodes.itemTag")}
            <select value={item.episode} onChange={(e) => updateItem(item.uid, { episode: e.target.value })}>
              <option value="">{t("studio.pack.episodes.evergreen")}</option>
              {episodes.map((episode) => (
                <option key={episode.id} value={episode.id}>
                  {episode.ordinal}. {episode.title || episode.id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
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

/** The engine-generated trust card (from the `--pack --json` object): pack
 * composition, detected world-card count, and every code-carrying flag — the
 * same disclosure the CLI prints before install, rendered natively. */
function TrustCard({ result }: { result: PackBuildSuccess }) {
  const { t } = useTranslation()
  const trust = result.trust
  if (trust === null) return null
  const megabytes = (trust.asset_bytes / (1024 * 1024)).toFixed(1)
  return (
    <section className="pack-output pack-trust" aria-label={t("studio.pack.trust.title")}>
      <h3>{t("studio.pack.trust.title")}</h3>
      <p className="studio-hint">
        {`${result.id}@${result.version} · ${t("studio.pack.trust.sha", { hash: result.sha256.slice(0, 16) })}`}
      </p>
      <ul className="issue-list">
        <li>
          {t("studio.pack.trust.counts", {
            skills: trust.skills,
            rulepacks: trust.rulepacks,
            cards: trust.cards,
            lorebooks: trust.lorebooks,
            assets: trust.assets,
            mb: megabytes,
            panels: trust.panels,
          })}
        </li>
        {trust.world_cards > 0 ? (
          <li>{t("studio.pack.trust.worldCards", { count: trust.world_cards })}</li>
        ) : null}
        <li>{t(trust.has_hooks ? "studio.pack.trust.hooksYes" : "studio.pack.trust.hooksNo")}</li>
        <li>{t(trust.has_ejs ? "studio.pack.trust.ejsYes" : "studio.pack.trust.ejsNo")}</li>
        <li>{t(trust.has_rules_script ? "studio.pack.trust.scriptYes" : "studio.pack.trust.scriptNo")}</li>
        {trust.prep_scripts > 0 ? (
          <li>{t("studio.pack.trust.prepScripts", { count: trust.prep_scripts })}</li>
        ) : null}
        {trust.presets > 0 ? <li>{t("studio.pack.trust.presets", { count: trust.presets })}</li> : null}
        {trust.presentation > 0 ? (
          <li>
            {t("studio.pack.trust.presentation", {
              subjects: trust.presentation,
              imagegen: t(
                trust.imagegen ? "studio.pack.trust.imagegenAllowed" : "studio.pack.trust.imagegenPackOnly",
              ),
            })}
          </li>
        ) : null}
      </ul>
    </section>
  )
}

/** The end of the author loop: install into the local server's own data dir,
 * bring that server up, join as keeper, and issue the pack's import commands —
 * the sequence the author used to run by hand across two views. */
function TestDrivePanel({
  candidate,
  result,
  packPath,
  sourceDir,
}: {
  candidate: EngineCandidate | null
  result: PackBuildSuccess
  packPath: string
  sourceDir: string | null
}) {
  const { t } = useTranslation()
  const drive = useTestDriveStore()
  const [mode, setMode] = useState<TestDriveMode>("install-then-import")
  const busy = drive.phase !== "idle" && drive.phase !== "ready" && drive.phase !== "error"

  return (
    <section className="pack-output" aria-label={t("studio.pack.testDrive.title")}>
      <h3>{t("studio.pack.testDrive.title")}</h3>
      <div className="dialog-row">
        <label className="field field-narrow">
          {t("studio.pack.testDrive.mode")}
          <select value={mode} onChange={(e) => setMode(e.target.value as TestDriveMode)}>
            <option value="install-then-import">{t("studio.pack.testDrive.modeInstall")}</option>
            <option value="mount-source" disabled={sourceDir === null}>
              {t("studio.pack.testDrive.modeMount")}
            </option>
          </select>
        </label>
      </div>
      <p className="studio-hint">
        {t(mode === "mount-source" ? "studio.pack.testDrive.mountHint" : "studio.pack.testDrive.hint")}
      </p>
      <div className="dialog-row">
        <button
          type="button"
          className="primary-button"
          disabled={(candidate === null && mode !== "mount-source") || busy}
          onClick={() =>
            void drive.run({
              candidate: candidate!,
              packPath,
              packId: result.id,
              packVersion: result.version,
              sourceDir: sourceDir ?? undefined,
              mode,
              // Skills and rulepacks are registered at server startup, so a
              // pack carrying either needs the server restarted, not just the
              // install re-run.
              carriesSkillsOrRulepacks: (result.trust?.skills ?? 0) > 0 || (result.trust?.rulepacks ?? 0) > 0,
            })
          }
        >
          {busy ? t(`studio.pack.testDrive.phase.${drive.phase}`) : t("studio.pack.testDrive.run")}
        </button>
        {drive.phase !== "idle" ? (
          <button type="button" className="ghost-button" onClick={() => drive.reset()} disabled={busy}>
            {t("studio.pack.testDrive.clear")}
          </button>
        ) : null}
      </div>
      {drive.dataDir !== null ? (
        <p className="studio-hint">{t("studio.pack.testDrive.dataDir", { dir: drive.dataDir })}</p>
      ) : null}
      {drive.commands.length > 0 ? (
        <>
          <p className="studio-hint">
            {t("studio.pack.testDrive.commands", { sent: drive.sent, total: drive.commands.length })}
          </p>
          <pre className="split-code pack-command">{drive.commands.join("\n")}</pre>
        </>
      ) : null}
      {drive.phase === "ready" ? (
        <p className="studio-notice" role="status">
          {t("studio.pack.testDrive.ready")}
        </p>
      ) : null}
      {drive.phase === "error" && drive.error !== null ? (
        <p className="studio-notice split-error" role="alert">
          {isTestDriveErrorKey(drive.error) ? t(`studio.pack.${drive.error}`) : drive.error}
        </p>
      ) : null}
    </section>
  )
}

// i18n-exempt: a YAML sample — code, identical in every locale.
const FULL_RULEPACK_SAMPLE = `names: [My System]
set_keys: [mysys]
defaults:
  力量: 50
  体质: 50
derived:
  体力:
    floor_div: {of: 体质, by: 10}
resolution:
  kind: percentile`
// i18n-exempt: as above.
const PATCH_RULEPACK_SAMPLE = `extends: coc7
defaults:
  San: 60`

/** The rulepack editor. Two modes over ONE artifact: a `patch` is an `extends:`
 * over a built-in system (what the bench has always offered), a `full` pack is
 * a whole rule system authored here. Both emit `rulepacks/<id>.yaml` and the
 * engine does not distinguish them — the mode changes the editor and the
 * advice, not the file. Validation is advisory: `core/rulepacks.py` parses this
 * again at build time and its verdict is the only one that counts. */
function RulepackSection() {
  const { t } = useTranslation()
  const metadata = usePackStore((s) => s.metadata)
  const setMetadata = usePackStore((s) => s.setMetadata)
  const full = metadata.rulepackMode === "full"
  const reading = readRulepack(metadata.rulepackPatch)

  const loadFromFile = async () => {
    const files = await pickAnyFiles()
    if (files.length === 0) return
    setMetadata({
      rulepackPatch: new TextDecoder("utf-8").decode(files[0].bytes),
      rulepackMode: "full",
      // The file stem IS the system id players type in `.set`, so adopt it.
      rulepackId: metadata.rulepackId || files[0].name.replace(/\.[^.]*$/, ""),
    })
  }

  return (
    <section className="pack-extra-section">
      <h3>{t("studio.pack.rulepack.title")}</h3>
      <div className="dialog-row">
        <label className="field field-narrow">
          {t("studio.pack.rulepack.mode")}
          <select
            value={metadata.rulepackMode}
            onChange={(e) => setMetadata({ rulepackMode: e.target.value as "patch" | "full" })}
          >
            <option value="patch">{t("studio.pack.rulepack.modePatch")}</option>
            <option value="full">{t("studio.pack.rulepack.modeFull")}</option>
          </select>
        </label>
        <button type="button" className="ghost-button" onClick={() => void loadFromFile()}>
          {t("studio.pack.rulepack.load")}
        </button>
      </div>
      <p className="studio-hint">
        {t(full ? "studio.pack.rulepack.fullHint" : "studio.pack.rulepack.patchHint")}
      </p>
      <label className="field field-wide">
        {t(full ? "studio.pack.rulepack.yamlFull" : "studio.pack.meta.rulepackPatch")}
        <textarea
          className={full ? "wizard-yaml" : undefined}
          rows={full ? 22 : 4}
          value={metadata.rulepackPatch}
          onChange={(e) => setMetadata({ rulepackPatch: e.target.value })}
          placeholder={full ? FULL_RULEPACK_SAMPLE : PATCH_RULEPACK_SAMPLE}
          spellCheck={false}
        />
      </label>
      {metadata.rulepackPatch.trim() ? (
        <p className="studio-hint">
          {t("studio.pack.rulepack.summary", {
            base: reading.summary.extends || t("studio.pack.rulepack.noBase"),
            stats: reading.summary.stats,
            derived: reading.summary.derived,
            subsystems: reading.summary.subsystems,
            commands: reading.summary.commands,
          })}
        </p>
      ) : null}
      {reading.issues.length > 0 ? (
        <ul className="issue-list">
          {reading.issues.map((issue, index) => (
            <li key={index}>{t(`studio.pack.err.${issue.key}`, issue.params)}</li>
          ))}
        </ul>
      ) : null}
      <p className="studio-hint">{t("studio.pack.rulepack.advisory")}</p>
    </section>
  )
}

/** The prep-script editor (M20 F). A prep script PLANS bulk setup — forty NPCs
 * from a list, a family of variables — and the engine applies the plan through
 * the ordinary tool path after a keeper previews it whole. It never runs at
 * install, or at any other time, by itself.
 *
 * Checks here are the engine's BUILD checks (extension, size) plus an advisory
 * read of what the source reaches for. Deliberately not a syntax check: the
 * engine's own build is static too, so packs build identically on machines
 * without the optional QuickJS extra, and a syntax error surfaces at preview. */
function PrepScriptSection() {
  const { t } = useTranslation()
  const scripts = usePackStore((s) => s.prepScripts)
  const add = usePackStore((s) => s.addPrepScript)
  const update = usePackStore((s) => s.updatePrepScript)
  const remove = usePackStore((s) => s.removePrepScript)
  const packId = usePackStore((s) => s.metadata.id)
  const [apiOpen, setApiOpen] = useState(false)

  return (
    <section className="pack-extra-section">
      <div className="dialog-row">
        <h3>{t("studio.pack.prep.title")}</h3>
        <div className="header-spacer" />
        <button type="button" className="ghost-button" onClick={() => setApiOpen(!apiOpen)}>
          {t(apiOpen ? "studio.pack.prep.hideApi" : "studio.pack.prep.showApi")}
        </button>
      </div>
      <p className="studio-hint">{t("studio.pack.prep.hint")}</p>
      {apiOpen ? (
        <ul className="pack-doctrine">
          <li>{t("studio.pack.prep.apiPlan")}</li>
          <li>
            {t("studio.pack.prep.apiLimits", { chars: MAX_PREP_SCRIPT_CHARS, ops: MAX_PREP_OPERATIONS })}
          </li>
          <li>{t("studio.pack.prep.apiGating")}</li>
          <li>{t("studio.pack.prep.apiUnreachable")}</li>
          <li>{t("studio.pack.prep.apiPreview")}</li>
        </ul>
      ) : null}
      {scripts.map((script, index) => {
        const reading = readPrepScript(script.source)
        return (
          <div className="pack-item" key={index}>
            <div className="pack-item-head">
              <label className="field field-narrow">
                {t("studio.pack.prep.fileName")}
                <input
                  value={script.fileName}
                  onChange={(e) => update(index, { fileName: e.target.value })}
                  placeholder="setup.js"
                  spellCheck={false}
                />
              </label>
              <span className="split-badge">{`${PREP_DIR}/${script.fileName}`}</span>
              <div className="header-spacer" />
              <button type="button" className="ghost-button" onClick={() => remove(index)}>
                {t("studio.remove")}
              </button>
            </div>
            <label className="field field-wide">
              {t("studio.pack.prep.source")}
              <textarea
                className="wizard-yaml"
                rows={16}
                value={script.source}
                onChange={(e) => update(index, { source: e.target.value })}
                spellCheck={false}
              />
            </label>
            <p className="studio-hint">
              {t("studio.pack.prep.reading", {
                chars: reading.chars,
                max: MAX_PREP_SCRIPT_CHARS,
                calls: reading.literalPlanCalls,
              })}
              {reading.hasLoop ? ` · ${t("studio.pack.prep.readingLoop", { ops: MAX_PREP_OPERATIONS })}` : ""}
            </p>
            {reading.forbidden.length > 0 ? (
              <p className="studio-hint pack-warn">
                {t("studio.pack.prep.forbidden", { names: reading.forbidden.join(", ") })}
              </p>
            ) : null}
            <p className="studio-hint">
              {t("studio.pack.prep.invoke", {
                ref: `${packId || "<packId>"}/${PREP_DIR}/${script.fileName}`,
              })}
            </p>
          </div>
        )
      })}
      <button type="button" className="ghost-button" onClick={() => add()}>
        {t("studio.pack.prep.add")}
      </button>
    </section>
  )
}

/** The serialized-module timeline (连载模组).
 *
 * One pack, cumulative versions: the release at episode N contains episodes
 * 1..N and nothing of N+1, which is what makes the circulating file spoiler-safe
 * without any gating machinery. This is where the installments are declared and
 * where each one's release notes are written; the tag on each dropped file is on
 * the Classify step, and the "build up to" selector is on the Build step. */
function EpisodeTimeline() {
  const { t } = useTranslation()
  const episodes = usePackStore((s) => s.episodes)
  const addEpisode = usePackStore((s) => s.addEpisode)
  const updateEpisode = usePackStore((s) => s.updateEpisode)
  const removeEpisode = usePackStore((s) => s.removeEpisode)

  return (
    <section className="pack-extra-section">
      <h3>{t("studio.pack.episodes.title")}</h3>
      <p className="studio-hint">{t("studio.pack.episodes.hint")}</p>
      {episodes.map((episode) => (
        <div className="pack-item" key={episode.id}>
          <div className="pack-item-head">
            <span className="split-badge">{t("studio.pack.episodes.ordinal", { n: episode.ordinal })}</span>
            <label className="field field-narrow">
              {t("studio.pack.episodes.id")}
              <input
                value={episode.id}
                onChange={(e) => updateEpisode(episode.id, { id: e.target.value })}
                spellCheck={false}
              />
            </label>
            <label className="field">
              {t("studio.pack.episodes.episodeTitle")}
              <input
                value={episode.title}
                onChange={(e) => updateEpisode(episode.id, { title: e.target.value })}
              />
            </label>
            <div className="header-spacer" />
            <button type="button" className="ghost-button" onClick={() => removeEpisode(episode.id)}>
              {t("studio.remove")}
            </button>
          </div>
          <label className="field field-wide">
            {t("studio.pack.episodes.summary")}
            <textarea
              rows={2}
              value={episode.summary}
              onChange={(e) => updateEpisode(episode.id, { summary: e.target.value })}
            />
          </label>
          <label className="field field-wide">
            {t("studio.pack.episodes.releaseNotes")}
            <textarea
              rows={3}
              value={episode.releaseNotes}
              onChange={(e) => updateEpisode(episode.id, { releaseNotes: e.target.value })}
              placeholder={t("studio.pack.episodes.releaseNotesPlaceholder")}
            />
          </label>
        </div>
      ))}
      <button type="button" className="ghost-button" onClick={() => addEpisode()}>
        {t("studio.pack.episodes.add")}
      </button>
    </section>
  )
}

/** "Build up to episode N" — the release checkpoint.
 *
 * Content tagged past N is excluded from the written source tree entirely, so
 * the `.lwpack` that circulates at this release cannot contain a future
 * chapter. The version convention (MINOR = episode) is surfaced next to it and
 * never applied behind the author's back. */
function ReleaseHorizon() {
  const { t } = useTranslation()
  const episodes = usePackStore((s) => s.episodes)
  const buildUpTo = usePackStore((s) => s.buildUpTo)
  const setBuildUpTo = usePackStore((s) => s.setBuildUpTo)
  const version = usePackStore((s) => s.metadata.version)
  const setMetadata = usePackStore((s) => s.setMetadata)

  const latest = latestOrdinal(episodes)
  const upTo = buildUpTo > 0 ? buildUpTo : latest
  const suggested = suggestedVersion(version, upTo)
  const conventional = versionMatchesConvention(version, upTo)

  return (
    <section className="pack-extra-section">
      <div className="dialog-row">
        <label className="field field-narrow">
          {t("studio.pack.episodes.buildUpTo")}
          <select value={upTo} onChange={(e) => setBuildUpTo(Number(e.target.value))}>
            {episodes
              .slice()
              .sort((a, b) => a.ordinal - b.ordinal)
              .map((episode) => (
                <option key={episode.id} value={episode.ordinal}>
                  {episode.ordinal}. {episode.title || episode.id}
                </option>
              ))}
          </select>
        </label>
        <span className="studio-hint">{t("studio.pack.episodes.buildUpToHint", { n: upTo })}</span>
      </div>
      {!conventional ? (
        <p className="studio-hint">
          {t("studio.pack.episodes.versionHint", { version, suggested })}{" "}
          <button
            type="button"
            className="ghost-button"
            onClick={() => setMetadata({ version: suggested })}
            disabled={suggested === version}
          >
            {t("studio.pack.episodes.versionApply", { suggested })}
          </button>
        </p>
      ) : null}
    </section>
  )
}

export default function PackWizard() {
  const { t } = useTranslation()
  const store = usePackStore()
  const aiSettings = useAiStore()
  const [busy, setBusy] = useState(false)
  const [aiProblems, setAiProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [panelDir, setPanelDir] = useState("")
  // The install target is the local server's data dir, and the author's own
  // server-folder override decides which one that is.
  const hostHome = useHostLocalStore((s) => s.homeOverride)
  const [installDir, setInstallDir] = useState("")
  useEffect(() => {
    void installDataDir(hostHome)
      .then(setInstallDir)
      .catch(() => setInstallDir(""))
  }, [hostHome])
  const dropRef = useRef<HTMLDivElement | null>(null)

  const addPanelAssets = async () => {
    const files = await pickAnyFiles()
    if (files.length > 0) store.addPanelFiles(files, panelDir)
  }

  const reattachPanelFile = async (path: string) => {
    const files = await pickAnyFiles()
    if (files.length > 0) store.reattachPanelFile(path, files[0])
  }

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
    const files = await pickAnyFiles()
    if (files.length > 0) await store.addFiles(files)
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

  /** Adopt a source tree that already exists on disk (an earlier session's, or
   * a hand-edited one) so build+install work WITHOUT re-dropping every file —
   * the iteration loop a module author actually lives in. */
  const adoptSourceDir = async () => {
    const dir = await pickDirectory()
    if (dir === null) return
    setError(null)
    try {
      const manifest = await readFileByPath(`${dir}/pack.yaml`)
      const parsed = parseYaml(new TextDecoder("utf-8").decode(manifest.bytes)) as {
        id?: unknown
        version?: unknown
      } | null
      const id = typeof parsed?.id === "string" ? parsed.id : ""
      const version = typeof parsed?.version === "string" ? parsed.version : ""
      if (!id || !version) {
        setError(t("studio.pack.adoptInvalid", { dir }))
        return
      }
      store.setMetadata({ id, version })
      const parent = dir.replace(/\/[^/]+\/?$/, "") || dir
      store.setOutputDir(parent)
      store.setWritten(dir)
      store.setBuiltPackPath(null)
      store.setRunResult(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const writeSource = async () => {
    if (store.outputDir === null) return
    setError(null)
    const draft = buildDraftFromState(
      store.items,
      store.metadata,
      store.panels,
      store.manualSkills,
      store.presentation,
      store.prepScripts,
      store.episodes,
      store.buildUpTo,
    )
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
          "--json",
        ]
      : ["--pack", `<${t("studio.pack.sourceDirPlaceholder")}>`, "--json"]

  const runPack = async () => {
    if (candidate === null || store.writtenDir === null || store.outputDir === null) return
    store.setRunning(true)
    store.setRunResult(null)
    store.setPackResult(null)
    setError(null)
    try {
      const outPath = `${store.outputDir}/${store.metadata.id}-${store.metadata.version}.lwpack`
      // `--json`: stdout is exactly ONE machine object; human lines (the
      // localized trust card included) stay on stderr for the terminal below.
      const result = await runEngineCli(candidate, ["--pack", store.writtenDir, "--out", outPath, "--json"])
      store.setRunResult(result)
      const parsed = parsePackBuildJson(result.stdout)
      if (parsed?.ok === false) {
        // The engine validated and refused: surface its reason prominently —
        // the stderr detail stays visible in the terminal for full context.
        setError(t("studio.pack.buildFailed", { detail: parsed.error }))
        return
      }
      if (result.code === 0) {
        if (parsed?.ok === true) store.setPackResult(parsed.result)
        // Prefer the engine-reported path; fall back to the requested --out
        // when stdout wasn't the machine shape (older engine).
        const builtPath = parsed?.ok === true ? parsed.result.path : outPath
        store.setBuiltPackPath(builtPath)
        if (store.installAfterBuild) {
          // Same target as every other install path: the local server's own
          // data dir, which is the only one the studio can promise anything
          // about (see `lib/packInstall.ts`).
          const install = await installPack(candidate, builtPath, hostHome)
          store.setInstalledTo(install.dataDir)
          store.setRunResult(install.result)
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
      const install = await installPack(candidate, store.builtPackPath, hostHome)
      store.setInstalledTo(install.dataDir)
      store.setRunResult(install.result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      store.setRunning(false)
    }
  }

  const issues = packValidationIssues(
    store.items,
    store.metadata,
    store.panels,
    store.manualSkills,
    store.presentation,
    store.prepScripts,
    store.episodes,
    store.buildUpTo,
  )
  // Advisory, alongside the blocking `issues` above and never mixed with them:
  // these are packs that build fine and then do nothing.
  const lintFindings = lintPack(
    lintSourceFromPackBench({
      items: store.items,
      metadata: store.metadata,
      panels: store.panels,
      manualSkills: store.manualSkills,
      presentation: store.presentation,
      episodes: store.episodes,
      buildUpTo: store.buildUpTo,
    }),
  )
  // Kit issues live on the presentation step (every kit key shares the
  // packPresentation prefix; kit-raised path collisions are tagged `from`) —
  // the metadata step only gates on its own fields, the build gates on ALL.
  const isKitIssue = (issue: Issue) =>
    issue.key.startsWith("packPresentation") || issue.params?.from === "presentation"
  const kitIssues = issues.filter(isKitIssue)
  const otherIssues = issues.filter((issue) => !isKitIssue(issue))
  const stepIndex = PACK_STEPS.indexOf(store.step)
  const worldCards = store.items.filter((item) => item.kind === "card" && item.cardKind === "world")
  const canNext: Record<PackStep, boolean> = {
    input: store.items.length > 0,
    review: store.items.length > 0,
    promote: true,
    metadata: otherIssues.length === 0,
    presentation: kitIssues.length === 0,
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
            // The build step stands on its own — it can adopt a source tree
            // that already exists on disk, so it is never gated behind the
            // authoring steps.
            disabled={index > stepIndex + 1 && step !== "build"}
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
          {t(`studio.${store.loadError.key}`, store.loadError.params)}
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
          <LintPanel findings={lintFindings} collapsible />
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
            <label className="field">
              {t("studio.pack.meta.rulepackId")}
              <input
                value={store.metadata.rulepackId}
                onChange={(e) => store.setMetadata({ rulepackId: e.target.value })}
                placeholder={store.metadata.id ? `${store.metadata.id}-rules` : "my-rules"}
                spellCheck={false}
              />
            </label>
          </div>

          <RulepackSection />

          <PrepScriptSection />

          <EpisodeTimeline />

          <section className="pack-extra-section">
            <h3>{t("studio.pack.panels.title")}</h3>
            <p className="studio-hint">{t("studio.pack.panels.hint")}</p>
            <label className="field field-wide">
              {t("studio.pack.panels.yaml")}
              <textarea
                rows={10}
                value={store.panels?.yamlText ?? ""}
                onChange={(e) => store.setPanelsYaml(e.target.value)}
                placeholder={
                  // i18n-exempt: a panels YAML sample — code. Its own {en, zh}
                  // labels are the point: panel text is authored bilingual.
                  "panels:\n  - id: hud\n    title: {en: HUD, zh: 状态板}\n    slot: sidebar\n    blocks:\n      - {kind: meter, label: {en: Fear, zh: 恐慌}, value: {$var: fear}, min: 0, max: 10}"
                }
                spellCheck={false}
              />
            </label>
            <div className="dialog-row">
              <label className="field field-narrow">
                {t("studio.pack.panels.subdir")}
                <input
                  value={panelDir}
                  onChange={(e) => setPanelDir(e.target.value)}
                  placeholder="case-board"
                  spellCheck={false}
                />
              </label>
              <button type="button" className="ghost-button" onClick={() => void addPanelAssets()}>
                {t("studio.pack.panels.addFiles")}
              </button>
              {store.panels !== null ? (
                <button type="button" className="ghost-button" onClick={() => store.clearPanels()}>
                  {t("studio.pack.panels.clear")}
                </button>
              ) : null}
            </div>
            {store.panels !== null && store.panels.files.length > 0 ? (
              <ul className="pack-file-list">
                {store.panels.files.map((file) => (
                  <li key={file.path}>
                    <input
                      className="pack-panel-path"
                      value={file.path}
                      aria-label={t("studio.pack.panels.pathLabel")}
                      onChange={(e) => store.updatePanelFilePath(file.path, e.target.value)}
                      spellCheck={false}
                    />
                    <span className="split-badge">
                      {file.contents !== undefined
                        ? t("studio.pack.panels.textFile")
                        : t("studio.pack.panels.binaryFile")}
                    </span>
                    {file.contents === undefined && file.base64 === undefined ? (
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => void reattachPanelFile(file.path)}
                      >
                        {t("studio.pack.reattach")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => store.removePanelFile(file.path)}
                    >
                      {t("studio.remove")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="pack-extra-section">
            <h3>{t("studio.pack.skills.title")}</h3>
            <p className="studio-hint">{t("studio.pack.skills.hint")}</p>
            {store.manualSkills.map((skill, index) => (
              <div className="pack-item" key={index}>
                <div className="pack-item-head">
                  <label className="field field-narrow">
                    {t("studio.pack.skills.slug")}
                    <input
                      value={skill.slug}
                      onChange={(e) => store.updateManualSkill(index, { slug: e.target.value })}
                      placeholder="my-skill"
                      spellCheck={false}
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => store.removeManualSkill(index)}
                  >
                    {t("studio.remove")}
                  </button>
                </div>
                <label className="field field-wide">
                  {t("studio.pack.skills.md")}
                  <textarea
                    rows={8}
                    value={skill.skillMd ?? ""}
                    onChange={(e) => store.updateManualSkill(index, { skillMd: e.target.value })}
                    // i18n-exempt: a SKILL.md frontmatter sample — code.
                    placeholder={"---\nname: …\ndescription: …\nmetadata:\n  scope: room\n---\n\n…"}
                    spellCheck={false}
                  />
                </label>
                <label className="field field-wide">
                  {t("studio.pack.skills.hooks")}
                  <textarea
                    rows={4}
                    value={skill.hooks[0] ?? ""}
                    onChange={(e) =>
                      store.updateManualSkill(index, {
                        hooks: e.target.value.trim() ? [e.target.value] : [],
                      })
                    }
                    placeholder={"on('turn_start', () => { /* … */ })"}
                    spellCheck={false}
                  />
                </label>
              </div>
            ))}
            <button type="button" className="ghost-button" onClick={() => store.addManualSkill()}>
              {t("studio.pack.skills.add")}
            </button>
          </section>

          {otherIssues.length > 0 ? (
            <ul className="issue-list">
              {otherIssues.map((issue, index) => (
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

      {store.step === "presentation" ? <PresentationStage issues={kitIssues} /> : null}

      {store.step === "build" ? (
        <div className="pack-panel">
          <h3>{t("studio.pack.writeTitle")}</h3>
          {store.episodes.length > 0 ? <ReleaseHorizon /> : null}
          {store.presentation !== null ? (
            // The review the author gets right before the engine speaks: what
            // the kit stages, and what the trust card will disclose.
            <p className="studio-hint">
              {t("studio.pack.presentation.buildReview", {
                subjects: presentationSummary(store.presentation).subjects,
                withRefs: presentationSummary(store.presentation).withRefs,
                audio: presentationSummary(store.presentation).audio,
                mode: t(
                  presentationSummary(store.presentation).mode === "allow"
                    ? "studio.pack.presentation.modeAllow"
                    : "studio.pack.presentation.modePackOnly",
                ),
              })}
              {` · ${t(
                presentationSummary(store.presentation).imagegen
                  ? "studio.pack.presentation.trustImagegen"
                  : "studio.pack.presentation.trustNoImagegen",
              )}`}
            </p>
          ) : null}
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
            <button type="button" className="ghost-button" onClick={() => void adoptSourceDir()}>
              {t("studio.pack.adoptDir")}
            </button>
          </div>
          <p className="studio-hint">{t("studio.pack.adoptHint")}</p>
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
          <pre className="split-code pack-command">
            {formatInstallCommand(
              candidate,
              store.builtPackPath ?? `<${t("studio.pack.builtPackPlaceholder")}>`,
              installDir,
            )}
          </pre>
          <p className="studio-hint">{t("studio.pack.installTargetHint", { dir: installDir || "…" })}</p>
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
          {store.packResult !== null ? <TrustCard result={store.packResult} /> : null}
          {store.packResult !== null && store.builtPackPath !== null ? (
            <TestDrivePanel
              candidate={candidate}
              result={store.packResult}
              packPath={store.builtPackPath}
              sourceDir={store.writtenDir}
            />
          ) : null}
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
                {store.installedTo !== null && store.runResult.code === 0
                  ? ` · ${t("studio.pack.installedTo", { dir: store.installedTo })}`
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
