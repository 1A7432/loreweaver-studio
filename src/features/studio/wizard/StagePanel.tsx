// One stage of the wizard: guided questions → the author's answer → AI
// structuring (draftWithRetries + the stage gate) → lint + token review →
// deterministic confirm. The one-click rewrite feeds lint hits back through
// the SAME problems mechanism the validation retry loop uses.

import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { stringify as yamlStringify } from "yaml"
import type { LlmMessage } from "../../../lib/native"
import type { ForgeProject } from "../model"
import { aiReady, draftWithRetries, useAiStore } from "../ai/provider"
import { StreamPreview } from "../ai/StreamPreview"
import { useDraftStream } from "../ai/useDraftStream"
import DraftEditor from "./DraftEditors"
import { lintFields, lintProblems, type LintHit } from "./lint"
import { contextDigest, guidanceSystem, stageSystem } from "./prompts"
import {
  carryManualSlots,
  gateGuidance,
  stageDraftToWire,
  stageGate,
  type GuidanceDraft,
  type StageGateContext,
} from "./schemas"
import {
  blankDraft,
  confirmBlocks,
  draftProseFields,
  stageMeta,
  type StageId,
  type WorldPath,
} from "./stages"
import { confirmedDrafts, useWizardStore, type WizardSession } from "./store"
import { DEFAULT_CONSTANT_BUDGET, demoteAdvice, draftConstantTokens, layerReport } from "./tokens"

const WORLD_PATHS: WorldPath[] = ["real", "small", "large"]

function LintList({ hits, advisory }: { hits: Map<string, LintHit[]>; advisory: boolean }) {
  const { t } = useTranslation()
  if (hits.size === 0) return null
  return (
    <div className={advisory ? "wizard-lint advisory" : "wizard-lint"}>
      <p className="wizard-lint-head">
        {advisory ? t("studio.wizard.lint.manualHead") : t("studio.wizard.lint.head")}
      </p>
      <ul className="issue-list">
        {[...hits.entries()].flatMap(([field, list]) =>
          list.map((hit, index) => (
            <li key={`${field}:${index}`}>
              <strong>{field}</strong> · {t(`studio.wizard.lint.rules.${hit.rule}`)} ·{" "}
              <mark>{hit.match}</mark>
              <span className="wizard-lint-excerpt">{hit.excerpt}</span>
            </li>
          )),
        )}
      </ul>
    </div>
  )
}

export default function StagePanel({ session, project }: { session: WizardSession; project: ForgeProject }) {
  const { t } = useTranslation()
  const stage = session.stage
  const meta = stageMeta(stage)
  const record = session.records[stage]
  const answer = record?.answer ?? ""
  const draft = record?.draft ?? null

  const setAnswer = useWizardStore((s) => s.setAnswer)
  const setDraft = useWizardStore((s) => s.setDraft)
  const setWorldPath = useWizardStore((s) => s.setWorldPath)
  const skipStage = useWizardStore((s) => s.skipStage)
  const confirmStage = useWizardStore((s) => s.confirmStage)
  const aiSettings = useAiStore()
  const ready = aiReady(aiSettings)

  const [busy, setBusy] = useState(false)
  const stream = useDraftStream()
  const [problems, setProblems] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [guidance, setGuidance] = useState<GuidanceDraft | null>(null)

  const ctx: StageGateContext = { path: session.worldPath, characterName: project.name }
  const digest = useMemo(() => contextDigest(confirmedDrafts(session)), [session])

  const lint = useMemo(() => {
    if (draft === null) return { ai: new Map<string, LintHit[]>(), manual: new Map<string, LintHit[]>() }
    const fields = draftProseFields(draft)
    return { ai: lintFields(fields.ai), manual: lintFields(fields.manual) }
  }, [draft])

  const blocks = confirmBlocks(draft)
  const confirmed = session.contract.confirmedAt[stage] !== undefined

  const report = layerReport(project.lorebook)
  const advice = demoteAdvice(report)
  const stageTokens = draft !== null ? draftConstantTokens(draft) : 0

  const runDraftLoop = async (history: LlmMessage[]) => {
    setBusy(true)
    setError(null)
    setProblems([])
    try {
      const result = await draftWithRetries(
        stageSystem(stage as Exclude<StageId, "exegesis">, digest),
        history,
        stageGate(stage, ctx),
        3,
        undefined,
        stream.onStream,
      )
      if (result.value !== null) {
        setDraft(session.projectUid, stage, carryManualSlots(draft, result.value))
      } else {
        setProblems(result.problems)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const structure = () => void runDraftLoop([{ role: "user", content: answer.trim() }])

  const rewrite = () => {
    if (draft === null) return
    const hits = [...lint.ai.entries()].flatMap(([field, list]) => lintProblems(list, field))
    if (hits.length === 0) return
    // Same problems-append shape the validation retry loop uses (provider.ts).
    void runDraftLoop([
      { role: "user", content: answer.trim() },
      { role: "assistant", content: JSON.stringify(stageDraftToWire(draft)) },
      {
        role: "user",
        content: `Validation rejected that draft. Fix these problems and output the corrected JSON object only:\n- ${hits.join("\n- ")}`,
      },
    ])
  }

  const askGuidance = async () => {
    if (meta.manual === null) return
    setBusy(true)
    setError(null)
    try {
      const result = await draftWithRetries(
        guidanceSystem(meta.manual, digest),
        [{ role: "user", content: answer.trim() || "(the author has not written notes yet)" }],
        gateGuidance,
        2,
      )
      if (result.value !== null) setGuidance(result.value)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const yamlPreview = useMemo(() => {
    if (draft === null) return null
    const wire = stageDraftToWire(draft)
    return Object.keys(wire).length > 0 ? yamlStringify(wire) : null
  }, [draft])

  const questions = Array.from({ length: meta.questions }, (_, i) =>
    t(`studio.wizard.stages.${stage}.q${i + 1}`),
  )

  return (
    <section className="wizard-stage" aria-label={t(`studio.wizard.stages.${stage}.title`)}>
      <header className="wizard-stage-head">
        <h2>{t(`studio.wizard.stages.${stage}.title`)}</h2>
        {confirmed ? <span className="wizard-badge done">{t("studio.wizard.confirmedBadge")}</span> : null}
        {meta.optional ? <span className="wizard-badge">{t("studio.wizard.optionalBadge")}</span> : null}
      </header>
      <p className="studio-hint">{t(`studio.wizard.stages.${stage}.intro`)}</p>

      {meta.manual !== null ? (
        <p className="wizard-manual-notice">{t("studio.wizard.manualNotice")}</p>
      ) : null}

      {stage === "worldview" ? (
        <label className="field field-narrow">
          {t("studio.wizard.pathLabel")}
          <select
            value={session.worldPath}
            onChange={(e) => setWorldPath(session.projectUid, e.target.value as WorldPath)}
          >
            {WORLD_PATHS.map((path) => (
              <option key={path} value={path}>
                {t(`studio.wizard.paths.${path}`)}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="wizard-questions">
        <p className="wizard-questions-head">{t("studio.wizard.questionsHead")}</p>
        <ol>
          {questions.map((question, index) => (
            <li key={index}>{question}</li>
          ))}
        </ol>
        {guidance !== null ? (
          <div className="wizard-guidance">
            <p className="wizard-questions-head">{t("studio.wizard.guidanceHead")}</p>
            <ol>
              {guidance.questions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ol>
            {guidance.example ? (
              <p className="wizard-guidance-example">
                <span className="wizard-badge">{t("studio.wizard.exampleBadge")}</span> {guidance.example}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <label className="field">
        {t("studio.wizard.answerLabel")}
        <textarea
          rows={6}
          value={answer}
          placeholder={t(`studio.wizard.stages.${stage}.placeholder`)}
          onChange={(e) => setAnswer(session.projectUid, stage, e.target.value)}
        />
      </label>

      <div className="dialog-row">
        {meta.aiAssisted ? (
          <button
            type="button"
            className="primary-button"
            disabled={!ready || busy || !answer.trim()}
            onClick={structure}
          >
            {busy ? t("studio.ai.working") : t("studio.wizard.structure")}
          </button>
        ) : null}
        {meta.manual !== null ? (
          <button
            type="button"
            className="ghost-button"
            disabled={!ready || busy}
            onClick={() => void askGuidance()}
          >
            {t("studio.wizard.askGuidance")}
          </button>
        ) : null}
        {draft === null ? (
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() => setDraft(session.projectUid, stage, blankDraft(stage, session.worldPath))}
          >
            {t("studio.wizard.startBlank")}
          </button>
        ) : null}
        {!ready && meta.aiAssisted ? <span className="studio-hint">{t("studio.ai.needsSetup")}</span> : null}
      </div>

      <StreamPreview text={stream.text} busy={busy} />

      {error !== null ? (
        <p className="studio-notice split-error" role="alert">
          {error}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <div className="ai-problems">
          <p className="studio-notice" role="alert">
            {t("studio.wizard.rejected")}
          </p>
          <ul className="issue-list">
            {problems.slice(0, 8).map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft !== null ? (
        <>
          <DraftEditor draft={draft} onChange={(next) => setDraft(session.projectUid, stage, next)} />

          <LintList hits={lint.ai} advisory={false} />
          {lint.ai.size > 0 && meta.aiAssisted ? (
            <button type="button" className="ghost-button" disabled={!ready || busy} onClick={rewrite}>
              {t("studio.wizard.lint.rewrite")}
            </button>
          ) : null}
          <LintList hits={lint.manual} advisory={true} />

          <div className="wizard-tokens-bar">
            <span>
              {t("studio.wizard.tokensStage", { n: stageTokens })} ·{" "}
              {t("studio.wizard.tokensProject", {
                n: report.constantTokens,
                budget: DEFAULT_CONSTANT_BUDGET,
              })}
            </span>
          </div>
          {advice.length > 0 ? (
            <div className="wizard-advice">
              <p className="studio-notice">{t("studio.wizard.overBudget")}</p>
              <ul className="issue-list">
                {advice.map((item) => (
                  <li key={item.uid}>
                    {t("studio.wizard.demoteLine", {
                      title: item.title || t("studio.wb.untitledEntry"),
                      tokens: item.tokens,
                      after: item.afterTokens,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {yamlPreview !== null ? (
            <details className="wizard-yaml-preview">
              <summary>{t("studio.wizard.yamlPreview")}</summary>
              <pre>{yamlPreview}</pre>
            </details>
          ) : null}
        </>
      ) : null}

      <div className="dialog-row wizard-confirm-row">
        {meta.optional ? (
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() => skipStage(session.projectUid, stage)}
          >
            {t("studio.wizard.skip")}
          </button>
        ) : null}
        <button
          type="button"
          className="primary-button"
          disabled={busy || blocks.length > 0}
          onClick={() => confirmStage(session.projectUid, stage)}
        >
          {confirmed ? t("studio.wizard.reconfirm") : t("studio.wizard.confirm")}
        </button>
        {blocks.map((block) => (
          <span key={block} className="wizard-block">
            {t(`studio.wizard.block.${block}`)}
          </span>
        ))}
      </div>
    </section>
  )
}
