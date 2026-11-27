// The pack bench wizard: files in → deterministic classify / split → promotion → AI-drafted
// metadata (human-confirmed) → modules, panels, presentation kit → a 3.0 pack source tree on
// disk → the ENGINE builds the .lwpack and its own installer verifies it in a scratch data
// directory. Every step can be paused, edited, or re-done — the pipeline is glass, not a
// black box. Playing the pack needs a running 3.0 server, which Studio does not host here.

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
import { formatInstallCommand } from "../../../lib/packInstall"
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
import { isTestDriveErrorKey, useTestDriveStore } from "../../../store/testDrive"
import { nextSteps } from "./testDrive"
import LintPanel from "../lint/LintPanel"
import { lintPack } from "../lint/packLint"
import PanelsEditor from "./PanelsEditor"
import { lintSourceFromPackBench } from "../lint/sources"
import { parsePackBuildJson, type EngineRefusal, type PackBuildSuccess, type PackTrust } from "./buildResult"
import {
  buildPackSourcePlan,
  MODULE_DIR,
  MODULE_SOURCE_EXTENSIONS,
  moduleIdMentioned,
  presentationSummary,
  SDK_GUIDE_URL,
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
        // Everything but this file's bytes came back from storage; the build stays blocked
        // until they return rather than shipping an empty file under the right name.
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
          <option value="asset">{t("studio.pack.kinds.asset")}</option>
        </select>
        {item.kind === "card" ? (
          // What the card IS — written as `kind:`, and checked by the engine against the card.
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
      {item.kind === "card" && item.hooks.length > 0 ? (
        <p className="studio-hint pack-warn">
          {t("studio.pack.cardHooksNeverRun", { count: item.hooks.length })}
        </p>
      ) : null}
      {item.initvarProblems.length > 0 ? (
        <ul className="issue-list">
          {item.initvarProblems.map((problem, index) => (
            <li key={index} className="split-error">
              {t(`studio.${problem.key}`, problem.params ?? {})}
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

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2)
}

/** The trust card as the engine computed it: what installing the pack means. Whether it runs
 * code comes first, as the engine's own card puts it. */
export function TrustCard({ trust, sha256 }: { trust: PackTrust; sha256: string }) {
  const { t } = useTranslation()
  return (
    <section className="pack-output pack-trust" aria-label={t("studio.pack.trust.title")}>
      <h3>{t("studio.pack.trust.title")}</h3>
      <p className="studio-hint">
        {`${trust.id}@${trust.version} · ${trust.license} · ${t("studio.pack.trust.sha", { hash: sha256.slice(0, 16) })}`}
      </p>
      {trust.runsCode ? (
        <div className="studio-notice split-error" role="alert">
          <strong>{t("studio.pack.trust.runsCode")}</strong>
          <ul className="issue-list">
            {trust.modules.map((module) => (
              <li key={module.id}>
                {t("studio.pack.trust.module", {
                  id: module.id,
                  entry: module.entry,
                  kb: (module.bytes / 1024).toFixed(1),
                  hash: module.sha256.slice(0, 12),
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="studio-notice" role="status">
          {t("studio.pack.trust.noCode")}
        </p>
      )}
      <ul className="issue-list">
        {trust.ruleSystems.map((system) => (
          <li key={`rule-${system.id}`}>
            {system.extends === null
              ? t("studio.pack.trust.ruleSystem", { id: system.id })
              : t("studio.pack.trust.ruleSystemExtends", { id: system.id, base: system.extends })}
          </li>
        ))}
        {trust.skills.map((skill) => (
          <li key={`skill-${skill.id}`}>
            {t("studio.pack.trust.skill", { id: skill.id, name: skill.name })}
            {skill.tools.length > 0
              ? ` · ${t("studio.pack.trust.skillTools", { tools: skill.tools.join(", ") })}`
              : ""}
            {skill.mature ? ` · ${t("studio.pack.trust.skillMature")}` : ""}
          </li>
        ))}
        {trust.cards.map((card) => (
          <li key={`card-${card.path}`}>
            {t(card.kind === "world" ? "studio.pack.trust.worldCard" : "studio.pack.trust.characterCard", {
              path: card.path,
              name: card.name,
            })}
            {card.kind === "world"
              ? ` · ${t("studio.pack.trust.machinery", {
                  declarations: card.machinery.variableDeclarations,
                  templates: card.machinery.templates,
                  secret: card.machinery.secretEntries,
                  variables: card.machinery.moduleVariables,
                  hooks: card.machinery.hooks,
                })}`
              : ""}
          </li>
        ))}
        {trust.panels.map((panel) => (
          <li key={`panel-${panel.id}`}>
            {t(panel.kind === "page" ? "studio.pack.trust.pagePanel" : "studio.pack.trust.templatePanel", {
              id: panel.id,
              audience: t(`studio.panels.audienceName.${panel.audience}`),
              views: panel.views.join(", ") || "—",
              page: panel.page?.path ?? "",
            })}
          </li>
        ))}
        {trust.presentation !== null ? (
          <li>
            {t("studio.pack.trust.presentation", {
              subjects: trust.presentation.subjects,
              cues: trust.presentation.cues,
              generation: t(
                trust.presentation.generation === "allow"
                  ? "studio.pack.trust.imagegenAllowed"
                  : "studio.pack.trust.imagegenPackOnly",
              ),
            })}
          </li>
        ) : null}
        <li>
          {t("studio.pack.trust.sizes", {
            assets: trust.assets.count,
            assetMb: megabytes(trust.assets.bytes),
            files: trust.files.count,
            fileMb: megabytes(trust.files.bytes),
          })}
        </li>
        {trust.ignored.map((entry) => (
          <li key={`ignored-${entry.path}`} className="pack-warn">
            {t("studio.pack.trust.ignored", { path: entry.path, reason: entry.reason })}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A refusal as the engine gave it: its code and path, and every problem it listed. */
export function RefusalView({ refusal, titleKey }: { refusal: EngineRefusal; titleKey: string }) {
  const { t } = useTranslation()
  return (
    <section className="studio-notice split-error" role="alert">
      <strong>{t(titleKey, { code: refusal.code })}</strong>
      {refusal.path !== undefined || refusal.detail !== undefined ? (
        <p>
          <code>{[refusal.path, refusal.detail].filter(Boolean).join(" · ")}</code>
        </p>
      ) : null}
      {refusal.problems.length > 0 ? (
        <ul className="issue-list">
          {refusal.problems.map((problem, index) => (
            <li key={index}>
              <code>{problem.code}</code> {problem.path}
              {problem.detail ? ` — ${problem.detail}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** After a build: the engine's own installer on the built file, into a scratch data
 * directory; then the exact commands that put the pack in front of a table. */
function VerifyPanel({ candidate, result }: { candidate: EngineCandidate | null; result: PackBuildSuccess }) {
  const { t } = useTranslation()
  const verify = useTestDriveStore()
  const busy = verify.phase === "verifying"
  const install = verify.verification?.install
  const steps = nextSteps(result.trust)
  return (
    <section className="pack-output" aria-label={t("studio.pack.verify.title")}>
      <h3>{t("studio.pack.verify.title")}</h3>
      <p className="studio-hint">{t("studio.pack.verify.hint")}</p>
      <div className="dialog-row">
        <button
          type="button"
          className="primary-button"
          disabled={candidate === null || busy}
          onClick={() => candidate !== null && void verify.run({ candidate, packPath: result.out })}
        >
          {busy ? t("studio.pack.verify.running") : t("studio.pack.verify.run")}
        </button>
        {verify.phase !== "idle" && !busy ? (
          <button type="button" className="ghost-button" onClick={() => verify.reset()}>
            {t("studio.pack.verify.clear")}
          </button>
        ) : null}
      </div>
      {verify.phase === "verified" && install?.ok ? (
        <div className="studio-notice" role="status">
          <p>
            {t("studio.pack.verify.installed", { id: install.result.id, version: install.result.version })}
            {verify.verification?.listed
              ? ` · ${t("studio.pack.verify.listed", {
                  packs:
                    verify.verification.listed.map((pack) => `${pack.id}@${pack.version}`).join(", ") || "—",
                })}`
              : ""}
          </p>
          {install.result.shadowed.ruleSystems.length + install.result.shadowed.skills.length > 0 ? (
            <p className="pack-warn">
              {t("studio.pack.verify.shadowed", {
                ids: [...install.result.shadowed.ruleSystems, ...install.result.shadowed.skills].join(", "),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      {verify.phase === "refused" && install && !install.ok ? (
        <RefusalView refusal={install.refusal} titleKey="studio.pack.verify.refused" />
      ) : null}
      {verify.phase === "error" && verify.error !== null ? (
        <p className="studio-notice split-error" role="alert">
          {isTestDriveErrorKey(verify.error) ? t(`studio.pack.${verify.error}`) : verify.error}
        </p>
      ) : null}

      <h4>{t("studio.pack.verify.nextTitle")}</h4>
      <p className="studio-hint">{t("studio.pack.verify.hostingNote")}</p>
      <p className="studio-hint">{t("studio.pack.verify.operator")}</p>
      <pre className="split-code pack-command">{formatInstallCommand(candidate, result.out)}</pre>
      <p className="studio-hint">{t("studio.pack.verify.admin")}</p>
      <pre className="split-code pack-command">{steps.admin.join("\n")}</pre>
      {steps.players.length > 0 ? (
        <>
          <p className="studio-hint">{t("studio.pack.verify.players")}</p>
          <pre className="split-code pack-command">{steps.players.join("\n")}</pre>
        </>
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
  敏捷: 50
derived:
  体力:
    floor_div: {of: 体质, by: 10}
resolution:
  version: 1
  roll: 1d100
  target: skill
  compare: "<="
  ranks:
    - {id: crit, when: "roll == 1", success: true, critical: true, tier: 3}
    - {id: fumble, when: "roll == 100", fumble: true, tier: 0}
    - {id: success, when: "roll <= target", success: true, tier: 2}
    - {id: fail, tier: 1}
initiative:
  roll: "1d100 + {敏捷}"`
// i18n-exempt: as above.
const PATCH_RULEPACK_SAMPLE = `extends: coc7
defaults:
  San: 60`

/** The rule-pack editor. Two modes over ONE artifact: a `patch` is an `extends:` over a
 * built-in system, a `full` pack a whole rule system authored here. Both emit
 * `rulepacks/<id>.yaml`. Validation is advisory except where 3.0 refuses outright (a rules
 * script): the engine compiles the file again at build and its verdict is the one that counts. */
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
      // The file stem IS the rule system's id, so adopt it.
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
            <li key={index}>{t(`studio.pack.err.${issue.key}`, issue.params ?? {})}</li>
          ))}
        </ul>
      ) : null}
      <p className="studio-hint">{t("studio.pack.rulepack.advisory")}</p>
    </section>
  )
}

/** The modules step: a pack's code. Honest about what Studio does with it — it writes the
 * source into the pack tree under `src/` and declares it; it does not type-check, bundle or
 * run it (the engine's builder bundles it; a room that enables the pack runs it). */
function ModulesStep({ issues }: { issues: Issue[] }) {
  const { t } = useTranslation()
  const modules = usePackStore((s) => s.modules)
  const addModule = usePackStore((s) => s.addModule)
  const updateModule = usePackStore((s) => s.updateModule)
  const removeModule = usePackStore((s) => s.removeModule)

  const loadSource = async (uid: string) => {
    const files = await pickAnyFiles()
    if (files.length === 0) return
    updateModule(uid, { source: new TextDecoder("utf-8").decode(files[0].bytes) })
  }

  return (
    <div className="pack-panel">
      <h3>{t("studio.pack.modules.title")}</h3>
      <p className="studio-hint">{t("studio.pack.modules.hint")}</p>
      <p className="studio-notice" role="note">
        {t("studio.pack.modules.honest")}
      </p>
      <p className="studio-hint">
        {t("studio.pack.modules.guide")}{" "}
        <a href={SDK_GUIDE_URL} target="_blank" rel="noreferrer">
          {SDK_GUIDE_URL}
        </a>
      </p>
      {modules.map((module) => (
        <div className="pack-item" key={module.uid}>
          <div className="pack-item-head">
            <label className="field field-narrow">
              {t("studio.pack.modules.id")}
              <input
                value={module.id}
                onChange={(e) => updateModule(module.uid, { id: e.target.value })}
                placeholder="tally"
                spellCheck={false}
              />
            </label>
            <label className="field field-narrow">
              {t("studio.pack.modules.fileName")}
              <input
                value={module.fileName}
                onChange={(e) => updateModule(module.uid, { fileName: e.target.value })}
                placeholder="tally.ts"
                spellCheck={false}
              />
            </label>
            <span className="split-badge">{`${MODULE_DIR}/${module.fileName}`}</span>
            <div className="header-spacer" />
            <button type="button" className="ghost-button" onClick={() => void loadSource(module.uid)}>
              {t("studio.pack.modules.load")}
            </button>
            <button type="button" className="ghost-button" onClick={() => removeModule(module.uid)}>
              {t("studio.remove")}
            </button>
          </div>
          <label className="field field-wide">
            {t("studio.pack.modules.source")}
            <textarea
              className="wizard-yaml module-source"
              rows={18}
              value={module.source}
              onChange={(e) => updateModule(module.uid, { source: e.target.value })}
              spellCheck={false}
              aria-label={t("studio.pack.modules.sourceFor", { id: module.id || "?" })}
            />
          </label>
          {!moduleIdMentioned(module.source, module.id) ? (
            <p className="studio-hint pack-warn">{t("studio.pack.modules.idMismatch", { id: module.id })}</p>
          ) : null}
          <p className="studio-hint">
            {t("studio.pack.modules.names", {
              id: module.id || "?",
              extensions: MODULE_SOURCE_EXTENSIONS.join(" "),
            })}
          </p>
        </div>
      ))}
      <button type="button" className="ghost-button" onClick={() => addModule()}>
        {t("studio.pack.modules.add")}
      </button>
      {issues.length > 0 ? (
        <ul className="issue-list">
          {issues.map((issue, index) => (
            <li key={index}>{t(`studio.pack.err.${issue.key}`, issue.params ?? {})}</li>
          ))}
        </ul>
      ) : null}
    </div>
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

/** Studio's own name for a candidate, for the engine picker. */
function candidateLabel(candidate: EngineCandidate): string {
  const where = candidate.kind === "binary" ? candidate.program : `bun ${candidate.args[0] ?? ""}`
  return candidate.version === null ? where : `${where} (${candidate.version})`
}

export default function PackWizard() {
  const { t } = useTranslation()
  const store = usePackStore()
  const aiSettings = useAiStore()
  const [busy, setBusy] = useState(false)
  const [aiProblems, setAiProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<EngineRefusal | null>(null)
  const [panelDir, setPanelDir] = useState("")
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
            variable_leaves: item.leaves.length,
            existing_notes: { en: item.notesEn, zh: item.notesZh },
          })),
        assets: store.items.filter((item) => item.kind === "asset").map((item) => item.fileName),
        modules: store.modules.map((module) => module.id),
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

  /** Adopt a source tree that already exists on disk (an earlier session's, or a hand-edited
   * one) so the build works WITHOUT re-dropping every file. */
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
      store.setPackResult(null)
      store.setRunResult(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const draftInput = {
    items: store.items,
    metadata: store.metadata,
    panels: store.panels,
    manualSkills: store.manualSkills,
    modules: store.modules,
    presentation: store.presentation,
    episodes: store.episodes,
    buildUpTo: store.buildUpTo,
  }

  const writeSource = async () => {
    if (store.outputDir === null) return
    setError(null)
    const plan = buildPackSourcePlan(buildDraftFromState(draftInput))
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
  const outPath =
    store.outputDir !== null
      ? `${store.outputDir}/${store.metadata.id}-${store.metadata.version}.lwpack`
      : null
  const packArgs =
    store.writtenDir !== null && outPath !== null
      ? ["pack", store.writtenDir, "--out", outPath]
      : ["pack", `<${t("studio.pack.sourceDirPlaceholder")}>`]

  const runPack = async () => {
    if (candidate === null || store.writtenDir === null || outPath === null) return
    store.setRunning(true)
    store.setRunResult(null)
    store.setPackResult(null)
    store.setBuiltPackPath(null)
    useTestDriveStore.getState().reset()
    setRefusal(null)
    setError(null)
    try {
      const result = await runEngineCli(candidate, ["pack", store.writtenDir, "--out", outPath])
      store.setRunResult(result)
      const parsed = parsePackBuildJson(result.stdout, result.stderr)
      if (parsed === null) {
        setError(t("studio.pack.noJson"))
        return
      }
      if (!parsed.ok) {
        // The engine validated and refused: its code, path and problems, as it said them.
        setRefusal(parsed.refusal)
        return
      }
      store.setPackResult(parsed.result)
      store.setBuiltPackPath(parsed.result.out)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      store.setRunning(false)
    }
  }

  const issues = packValidationIssues(draftInput)
  // Advisory, alongside the blocking `issues` above and never mixed with them: packs that
  // build fine and then do nothing.
  const lintSource = lintSourceFromPackBench({
    items: store.items,
    metadata: store.metadata,
    panels: store.panels,
    presentation: store.presentation,
    episodes: store.episodes,
    buildUpTo: store.buildUpTo,
  })
  const lintFindings = lintPack(lintSource)
  // Kit issues live on the presentation step, module issues on the modules step; the
  // metadata step gates on the rest, and the build gates on ALL.
  const isKitIssue = (issue: Issue) =>
    issue.key.startsWith("packPresentation") || issue.params?.from === "presentation"
  const isModuleIssue = (issue: Issue) => issue.key.startsWith("packModule")
  const kitIssues = issues.filter(isKitIssue)
  const moduleIssues = issues.filter(isModuleIssue)
  const otherIssues = issues.filter((issue) => !isKitIssue(issue) && !isModuleIssue(issue))
  const stepIndex = PACK_STEPS.indexOf(store.step)
  const worldCards = store.items.filter((item) => item.kind === "card" && item.cardKind === "world")
  const canNext: Record<PackStep, boolean> = {
    input: store.items.length > 0,
    review: store.items.length > 0,
    promote: true,
    metadata: otherIssues.length === 0,
    modules: moduleIssues.length === 0,
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
            // The build step stands on its own — it can adopt a source tree that already
            // exists on disk, so it is never gated behind the authoring steps.
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

      {store.migrationNotes.length > 0 ? (
        <section className="studio-notice" role="status" aria-label={t("studio.pack.migration.title")}>
          <strong>{t("studio.pack.migration.title")}</strong>
          <ul className="issue-list">
            {store.migrationNotes.map((note, index) => (
              <li key={index}>{t(`studio.${note.key}`, note.params ?? {})}</li>
            ))}
          </ul>
          <button type="button" className="ghost-button" onClick={() => store.dismissMigrationNotes()}>
            {t("studio.pack.migration.dismiss")}
          </button>
        </section>
      ) : null}

      {error !== null ? (
        <p className="studio-notice split-error" role="alert">
          {error}
        </p>
      ) : null}
      {store.loadError !== null ? (
        <p className="studio-notice split-error" role="alert">
          {t(`studio.${store.loadError.key}`, store.loadError.params ?? {})}
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

          <EpisodeTimeline />

          <section className="pack-extra-section">
            <h3>{t("studio.pack.panels.title")}</h3>
            <p className="studio-hint">{t("studio.pack.panels.hint")}</p>
            <PanelsEditor
              yamlText={store.panels?.yamlText ?? ""}
              onChange={store.setPanelsYaml}
              variables={lintSource.variables}
              moduleIds={store.modules.map((module) => module.id)}
              files={[
                ...(store.panels?.files.map((file) => file.path) ?? []),
                ...store.items
                  .filter((item) => item.kind === "asset")
                  .map((item) => `assets/${item.fileName}`),
              ]}
            />
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
              </div>
            ))}
            <button type="button" className="ghost-button" onClick={() => store.addManualSkill()}>
              {t("studio.pack.skills.add")}
            </button>
          </section>

          {otherIssues.length > 0 ? (
            <ul className="issue-list">
              {otherIssues.map((issue, index) => (
                <li key={index}>{t(`studio.pack.err.${issue.key}`, issue.params ?? {})}</li>
              ))}
            </ul>
          ) : (
            <p className="studio-notice" role="status">
              {t("studio.pack.metadataClean")}
            </p>
          )}
        </div>
      ) : null}

      {store.step === "modules" ? <ModulesStep issues={moduleIssues} /> : null}

      {store.step === "presentation" ? <PresentationStage issues={kitIssues} /> : null}

      {store.step === "build" ? (
        <div className="pack-panel">
          <h3>{t("studio.pack.writeTitle")}</h3>
          {store.episodes.length > 0 ? <ReleaseHorizon /> : null}
          {store.presentation !== null ? (
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
          {issues.length > 0 ? (
            <p className="studio-hint pack-warn">{t("studio.pack.blocked", { count: issues.length })}</p>
          ) : null}
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
                    {candidateLabel(entry)}
                  </option>
                ))}
              </select>
            ) : (
              <span className="studio-hint">{t("studio.pack.noEngine")}</span>
            )}
          </div>
          {candidate !== null && candidate.version === null ? (
            <p className="studio-notice split-error" role="alert">
              {t("studio.pack.engineNoVersion", { problem: candidate.problem ?? "" })}
            </p>
          ) : null}
          <pre className="split-code pack-command">{formatCliCommand(candidate, packArgs)}</pre>
          <div className="dialog-row">
            <button
              type="button"
              className="primary-button"
              onClick={() => void runPack()}
              disabled={candidate === null || store.writtenDir === null || store.running}
            >
              {store.running ? t("studio.pack.running") : t("studio.pack.runBuild")}
            </button>
          </div>
          {refusal !== null ? <RefusalView refusal={refusal} titleKey="studio.pack.buildRefused" /> : null}
          {store.packResult !== null ? (
            <>
              <p className="studio-notice" role="status">
                {t("studio.pack.built", {
                  out: store.packResult.out,
                  kb: (store.packResult.bytes / 1024).toFixed(1),
                })}
              </p>
              {store.packResult.ignored.length > 0 ? (
                <p className="studio-hint pack-warn">
                  {t("studio.pack.builtIgnored", { files: store.packResult.ignored.join(", ") })}
                </p>
              ) : null}
              <TrustCard trust={store.packResult.trust} sha256={store.packResult.sha256} />
              <VerifyPanel candidate={candidate} result={store.packResult} />
            </>
          ) : null}
          {store.runResult !== null ? (
            <details className="pack-output">
              <summary>
                {store.runResult.timedOut
                  ? t("studio.pack.timedOut")
                  : t("studio.pack.exitCode", { code: store.runResult.code ?? "?" })}
              </summary>
              <pre className="split-code pack-terminal">
                {[store.runResult.stderr, store.runResult.stdout].filter(Boolean).join("\n") ||
                  t("studio.pack.noOutput")}
              </pre>
            </details>
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
