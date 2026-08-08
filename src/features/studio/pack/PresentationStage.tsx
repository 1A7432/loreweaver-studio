// The 演出资料包 (presentation kit) wizard stage — the Stage Director's entire
// creative brief, authored as data: who may be pictured (定妆 refs + style
// keywords), which audio cues exist, and the 宁缺毋滥 generation veto. The
// Director is KIT-GATED (docs/specs/M19): a module opts into staged beats by
// shipping `ui/presentation.yaml`, so this stage starts empty on purpose and
// the author adds the kit deliberately. Schema mirrors `core/presentation.py`.

import { useTranslation } from "react-i18next"
import { pickAnyFiles } from "../../../lib/native"
import { usePackStore } from "../../../store/pack"
import {
  PRESENTATION_AUDIO_EXTENSIONS,
  PRESENTATION_AUDIO_LAYERS,
  PRESENTATION_GENERATION_MODES,
  PRESENTATION_IMAGE_EXTENSIONS,
  PRESENTATION_SUBJECT_KINDS,
  presentationSummary,
  type PackPresentationAudioDraft,
  type PackPresentationSubjectDraft,
} from "../split/packSource"
import type { Issue } from "../model"

function extensionOf(fileName: string): string {
  return /\.([^.]+)$/.exec(fileName.toLowerCase())?.[1] ?? ""
}

/** Data-URL MIME for the ref thumbnail (decorative preview only — the engine
 * sniffs the real bytes at pack build). */
function previewMime(fileName: string): string {
  const ext = extensionOf(fileName)
  if (ext === "svg") return "image/svg+xml"
  if (ext === "jpg") return "image/jpeg"
  return `image/${ext || "png"}`
}

function fieldErrors(issues: Issue[], uid: string | null, field: string): Issue[] {
  return issues.filter((issue) => (issue.params?.uid ?? null) === uid && issue.params?.field === field)
}

function IssueLine({ issue }: { issue: Issue }) {
  const { t } = useTranslation()
  return (
    <p className="studio-hint split-error" role="alert">
      {t(`studio.pack.err.${issue.key}`, issue.params)}
    </p>
  )
}

function FieldIssues({ issues, uid, field }: { issues: Issue[]; uid: string | null; field: string }) {
  const matches = fieldErrors(issues, uid, field)
  if (matches.length === 0) return null
  return (
    <>
      {matches.map((issue, index) => (
        <IssueLine key={index} issue={issue} />
      ))}
    </>
  )
}

function SubjectCard({ subject, issues }: { subject: PackPresentationSubjectDraft; issues: Issue[] }) {
  const { t } = useTranslation()
  const store = usePackStore()
  const hasRef = subject.refBase64 !== ""
  const refLooksImage =
    subject.refFileName !== "" &&
    (PRESENTATION_IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(subject.refFileName))

  const uploadRef = async () => {
    const files = await pickAnyFiles()
    if (files.length > 0) store.setPresentationSubjectRef(subject.uid, files[0])
  }

  return (
    <div className="pack-item">
      <div className="pack-item-head">
        {hasRef ? (
          <img
            className="pack-ref-thumb"
            src={`data:${previewMime(subject.refFileName)};base64,${subject.refBase64}`}
            alt=""
          />
        ) : (
          <span className="pack-ref-thumb pack-ref-empty" aria-hidden="true">
            {t("studio.pack.presentation.subject.refEmpty")}
          </span>
        )}
        <label className="field field-narrow">
          {t("studio.pack.presentation.subject.id")}
          <input
            value={subject.id}
            onChange={(e) => store.updatePresentationSubject(subject.uid, { id: e.target.value })}
            placeholder="gu-wantang"
            spellCheck={false}
          />
        </label>
        <label className="field field-narrow">
          {t("studio.pack.presentation.subject.kind")}
          <select
            value={subject.kind}
            aria-label={t("studio.pack.presentation.subject.kind")}
            onChange={(e) => store.updatePresentationSubject(subject.uid, { kind: e.target.value })}
          >
            {PRESENTATION_SUBJECT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`studio.pack.presentation.kinds.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="header-spacer" />
        <button
          type="button"
          className="ghost-button"
          onClick={() => store.removePresentationSubject(subject.uid)}
        >
          {t("studio.remove")}
        </button>
      </div>
      <FieldIssues issues={issues} uid={subject.uid} field="id" />
      <FieldIssues issues={issues} uid={subject.uid} field="kind" />

      <div className="dialog-row">
        <label className="field">
          {t("studio.pack.presentation.subject.nameZh")}
          <input
            value={subject.nameZh}
            onChange={(e) => store.updatePresentationSubject(subject.uid, { nameZh: e.target.value })}
            placeholder="顾晚棠"
          />
        </label>
        <label className="field">
          {t("studio.pack.presentation.subject.nameEn")}
          <input
            value={subject.nameEn}
            onChange={(e) => store.updatePresentationSubject(subject.uid, { nameEn: e.target.value })}
            placeholder="Gu Wantang"
          />
        </label>
      </div>
      <FieldIssues issues={issues} uid={subject.uid} field="nameEn" />
      <FieldIssues issues={issues} uid={subject.uid} field="nameZh" />

      <div className="dialog-row">
        <button type="button" className="ghost-button" onClick={() => void uploadRef()}>
          {t(
            hasRef
              ? "studio.pack.presentation.subject.refReplace"
              : "studio.pack.presentation.subject.refUpload",
          )}
        </button>
        {hasRef ? (
          <>
            <label className="field">
              {t("studio.pack.presentation.subject.refFileName")}
              <input
                value={subject.refFileName}
                onChange={(e) =>
                  store.updatePresentationSubject(subject.uid, { refFileName: e.target.value })
                }
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="ghost-button"
              onClick={() => store.clearPresentationSubjectRef(subject.uid)}
            >
              {t("studio.pack.presentation.subject.refRemove")}
            </button>
          </>
        ) : null}
      </div>
      {hasRef && !refLooksImage ? (
        <p className="studio-hint pack-warn">{t("studio.pack.presentation.subject.refBadType")}</p>
      ) : null}
      {!hasRef ? (
        // The ref-mandatory doctrine, stated at the exact moment it bites:
        // legal per schema, but the Director can never picture this subject.
        <p className="studio-hint pack-warn">{t("studio.pack.presentation.subject.refMissing")}</p>
      ) : null}
      <FieldIssues issues={issues} uid={subject.uid} field="ref" />
      <FieldIssues issues={issues} uid={subject.uid} field="refFileName" />

      <label className="field">
        {t("studio.pack.presentation.subject.prompt")}
        <textarea
          rows={2}
          value={subject.prompt}
          onChange={(e) => store.updatePresentationSubject(subject.uid, { prompt: e.target.value })}
          placeholder={t("studio.pack.presentation.subject.promptPlaceholder")}
          spellCheck={false}
        />
      </label>
      <p className="studio-hint">{t("studio.pack.presentation.subject.promptHint")}</p>
      <FieldIssues issues={issues} uid={subject.uid} field="prompt" />
    </div>
  )
}

function CueCard({ cue, issues }: { cue: PackPresentationAudioDraft; issues: Issue[] }) {
  const { t } = useTranslation()
  const store = usePackStore()
  const hasAsset = cue.assetBase64 !== ""
  const assetLooksAudio =
    cue.assetFileName !== "" &&
    (PRESENTATION_AUDIO_EXTENSIONS as readonly string[]).includes(extensionOf(cue.assetFileName))

  const uploadAsset = async () => {
    const files = await pickAnyFiles()
    if (files.length > 0) store.setPresentationCueAsset(cue.uid, files[0])
  }

  return (
    <div className="pack-item">
      <div className="pack-item-head">
        <label className="field field-narrow">
          {t("studio.pack.presentation.cue.id")}
          <input
            value={cue.id}
            onChange={(e) => store.updatePresentationCue(cue.uid, { id: e.target.value })}
            placeholder="chao-yong"
            spellCheck={false}
          />
        </label>
        <label className="field field-narrow">
          {t("studio.pack.presentation.cue.layer")}
          <select
            value={cue.layer}
            aria-label={t("studio.pack.presentation.cue.layer")}
            onChange={(e) => store.updatePresentationCue(cue.uid, { layer: e.target.value })}
          >
            {PRESENTATION_AUDIO_LAYERS.map((layer) => (
              <option key={layer} value={layer}>
                {t(`studio.pack.presentation.layers.${layer}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("studio.pack.presentation.cue.title")}
          <input
            value={cue.title}
            onChange={(e) => store.updatePresentationCue(cue.uid, { title: e.target.value })}
            placeholder="潮涌"
          />
        </label>
        <div className="header-spacer" />
        <button type="button" className="ghost-button" onClick={() => store.removePresentationCue(cue.uid)}>
          {t("studio.remove")}
        </button>
      </div>
      <FieldIssues issues={issues} uid={cue.uid} field="id" />
      <FieldIssues issues={issues} uid={cue.uid} field="layer" />
      <FieldIssues issues={issues} uid={cue.uid} field="title" />

      <div className="dialog-row">
        <button type="button" className="ghost-button" onClick={() => void uploadAsset()}>
          {t(
            hasAsset
              ? "studio.pack.presentation.cue.assetReplace"
              : "studio.pack.presentation.cue.assetUpload",
          )}
        </button>
        {hasAsset || cue.assetFileName !== "" ? (
          <>
            <label className="field">
              {t("studio.pack.presentation.cue.assetFileName")}
              <input
                value={cue.assetFileName}
                onChange={(e) => store.updatePresentationCue(cue.uid, { assetFileName: e.target.value })}
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="ghost-button"
              onClick={() => store.clearPresentationCueAsset(cue.uid)}
            >
              {t("studio.pack.presentation.cue.assetRemove")}
            </button>
          </>
        ) : null}
      </div>
      {hasAsset && !assetLooksAudio ? (
        <p className="studio-hint pack-warn">{t("studio.pack.presentation.cue.assetBadType")}</p>
      ) : null}
      <FieldIssues issues={issues} uid={cue.uid} field="asset" />
      <FieldIssues issues={issues} uid={cue.uid} field="assetFileName" />
    </div>
  )
}

export default function PresentationStage({ issues }: { issues: Issue[] }) {
  const { t } = useTranslation()
  const store = usePackStore()
  const kit = store.presentation

  if (kit === null) {
    // The empty state IS the kit-gating lesson: opting in is a deliberate act,
    // and the author learns what the kit buys before adding one.
    return (
      <div className="pack-panel">
        <section className="pack-item pack-kit-empty">
          <h3>{t("studio.pack.presentation.emptyTitle")}</h3>
          <p className="studio-hint">{t("studio.pack.presentation.emptyHint")}</p>
          <ul className="pack-doctrine">
            <li>{t("studio.pack.presentation.doctrineGated")}</li>
            <li>{t("studio.pack.presentation.doctrineRef")}</li>
            <li>{t("studio.pack.presentation.doctrinePackOnly")}</li>
            <li>{t("studio.pack.presentation.doctrineWarmup")}</li>
          </ul>
          <div className="dialog-row">
            <button type="button" className="primary-button" onClick={() => store.addPresentation()}>
              {t("studio.pack.presentation.add")}
            </button>
          </div>
        </section>
      </div>
    )
  }

  const summary = presentationSummary(kit)
  const kitWideIssues = issues.filter(
    (issue) => issue.params?.uid === undefined && issue.params?.field === undefined,
  )

  return (
    <div className="pack-panel">
      <p className="studio-hint">{t("studio.pack.presentation.hint")}</p>
      <p className="studio-hint">
        {t("studio.pack.presentation.summary", {
          subjects: summary.subjects,
          withRefs: summary.withRefs,
          audio: summary.audio,
          mode: t(
            summary.mode === "allow"
              ? "studio.pack.presentation.modeAllow"
              : "studio.pack.presentation.modePackOnly",
          ),
        })}
        {` · ${t(summary.imagegen ? "studio.pack.presentation.trustImagegen" : "studio.pack.presentation.trustNoImagegen")}`}
      </p>

      <section className="pack-extra-section">
        <h3>{t("studio.pack.presentation.generation.title")}</h3>
        <div
          className="pack-gen-grid"
          role="radiogroup"
          aria-label={t("studio.pack.presentation.generation.title")}
        >
          {PRESENTATION_GENERATION_MODES.map((mode) => (
            <label key={mode} className={kit.generation === mode ? "pack-gen-card active" : "pack-gen-card"}>
              <input
                type="radio"
                name="pack-generation"
                checked={kit.generation === mode}
                onChange={() => store.updatePresentation({ generation: mode })}
              />
              <span className="pack-gen-label">{t(`studio.pack.presentation.generation.${mode}.label`)}</span>
              <span className="studio-hint">{t(`studio.pack.presentation.generation.${mode}.hint`)}</span>
            </label>
          ))}
        </div>
        <FieldIssues issues={issues} uid={null} field="generation" />
      </section>

      <section className="pack-extra-section">
        <h3>{t("studio.pack.presentation.style.title")}</h3>
        <p className="studio-hint">{t("studio.pack.presentation.style.keywordsHint")}</p>
        <div className="dialog-row">
          <label className="field">
            {t("studio.pack.presentation.style.keywordsZh")}
            <input
              value={kit.keywordsZh}
              onChange={(e) => store.updatePresentation({ keywordsZh: e.target.value })}
              placeholder="水墨淡彩, 靛青与赭石, 一九二五年浙东渔镇"
            />
          </label>
          <label className="field">
            {t("studio.pack.presentation.style.keywordsEn")}
            <input
              value={kit.keywordsEn}
              onChange={(e) => store.updatePresentation({ keywordsEn: e.target.value })}
              placeholder="ink wash with muted color, indigo and ochre, 1925 coastal Zhejiang"
            />
          </label>
        </div>
        <FieldIssues issues={issues} uid={null} field="keywordsEn" />
        <FieldIssues issues={issues} uid={null} field="keywordsZh" />
        <label className="field field-wide">
          {t("studio.pack.presentation.style.banned")}
          <textarea
            rows={3}
            value={kit.bannedText}
            onChange={(e) => store.updatePresentation({ bannedText: e.target.value })}
            placeholder={"text overlays\nmodern clothing"}
            spellCheck={false}
          />
        </label>
        <p className="studio-hint">{t("studio.pack.presentation.style.bannedHint")}</p>
        <FieldIssues issues={issues} uid={null} field="banned" />
      </section>

      <section className="pack-extra-section">
        <h3>{t("studio.pack.presentation.subjects.title")}</h3>
        <p className="studio-hint">{t("studio.pack.presentation.subjects.hint")}</p>
        {kit.subjects.map((subject) => (
          <SubjectCard key={subject.uid} subject={subject} issues={issues} />
        ))}
        <div className="dialog-row">
          <button type="button" className="ghost-button" onClick={() => store.addPresentationSubject()}>
            {t("studio.pack.presentation.subjects.add")}
          </button>
        </div>
      </section>

      <section className="pack-extra-section">
        <h3>{t("studio.pack.presentation.audio.title")}</h3>
        <p className="studio-hint">{t("studio.pack.presentation.audio.hint")}</p>
        {kit.audio.map((cue) => (
          <CueCard key={cue.uid} cue={cue} issues={issues} />
        ))}
        <div className="dialog-row">
          <button type="button" className="ghost-button" onClick={() => store.addPresentationCue()}>
            {t("studio.pack.presentation.audio.add")}
          </button>
        </div>
      </section>

      {kitWideIssues.length > 0 ? (
        <ul className="issue-list">
          {kitWideIssues.map((issue, index) => (
            <li key={index}>{t(`studio.pack.err.${issue.key}`, issue.params)}</li>
          ))}
        </ul>
      ) : null}

      <div className="dialog-row">
        <button type="button" className="ghost-button" onClick={() => store.clearPresentation()}>
          {t("studio.pack.presentation.removeKit")}
        </button>
      </div>
    </div>
  )
}
