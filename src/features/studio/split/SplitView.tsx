// The card-split (拆卡) workbench: open any SillyTavern card, see it decomposed
// into "character half | world half", edit both, then export each half to its
// native destination — clean card / editor project on the left, `.lwpack`
// source via the pack wizard on the right.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { bytesToBase64, pickCardFile, type PickedFile } from "../../../lib/native"
import { saveTextFile } from "../../../lib/files"
import { useStudioStore } from "../../../store/studio"
import { initvarLeaves, usePackStore, type PackItem } from "../../../store/pack"
import { aiFillLabels } from "../ai/labels"
import { aiReady, useAiStore } from "../ai/provider"
import { exportFileName, exportNativeBundle } from "../exporters"
import { uid, validateProject } from "../model"
import { parseCardBytes, type StCharacterCard } from "./charcard"
import { payloadsAny, splitCard, type SplitCardResult } from "./cardSplit"
import { characterHalfToStCard, splitToProject } from "./convert"
import type { MvuLeaf } from "./mvu"
import PromoteTable from "./PromoteTable"
import { promoteLeaves, suggestExposePrefixes, type PromotionDraft } from "./promote"
import { safeFileName } from "./packSource"

interface SplitSession {
  file: PickedFile
  /** The card exactly as parsed — what a keeper's world import would read. */
  original: StCharacterCard
  /** The (editable) character half. */
  character: StCharacterCard
  split: SplitCardResult
  leaves: MvuLeaf[]
  truncated: boolean
  drafts: PromotionDraft[]
}

type ProseField = "description" | "personality" | "scenario" | "firstMes" | "mesExample" | "creatorNotes"
const PROSE_FIELDS: ProseField[] = [
  "description",
  "personality",
  "scenario",
  "firstMes",
  "mesExample",
  "creatorNotes",
]

export default function SplitView() {
  const { t } = useTranslation()
  const importProject = useStudioStore((s) => s.importProject)
  const setView = useStudioStore((s) => s.setView)
  const seedFromSplit = usePackStore((s) => s.seedFromSplit)
  const aiSettings = useAiStore()
  const [session, setSession] = useState<SplitSession | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)

  const openCard = async () => {
    setError(null)
    setNotice(null)
    try {
      const file = await pickCardFile()
      if (file === null) return
      const card = await parseCardBytes(file.bytes, file.name)
      const split = splitCard(card)
      const { leaves, truncated } = initvarLeaves(split.initvarEntries)
      setSession({
        file,
        original: card,
        character: split.character,
        split,
        leaves,
        truncated,
        drafts: promoteLeaves(leaves),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const patchCharacter = (patch: Partial<StCharacterCard>) => {
    setSession((current) =>
      current === null ? null : { ...current, character: { ...current.character, ...patch } },
    )
  }

  const patchDraft = (uid: string, patch: Partial<PromotionDraft>) => {
    setSession((current) =>
      current === null
        ? null
        : {
            ...current,
            drafts: current.drafts.map((draft) => (draft.uid === uid ? { ...draft, ...patch } : draft)),
          },
    )
  }

  const runAiLabels = async () => {
    if (session === null) return
    setAiBusy(true)
    try {
      const drafts = await aiFillLabels(session.drafts)
      setSession((current) => (current === null ? null : { ...current, drafts }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAiBusy(false)
    }
  }

  const exportCleanSt = async () => {
    if (session === null) return
    const payload = characterHalfToStCard(session.character)
    const name = `${safeFileName(session.character.name, "card")}.clean.st.json`
    const outcome = await saveTextFile(name, JSON.stringify(payload, null, 2))
    setNotice(t(`studio.save.${outcome}`))
  }

  const exportNative = async () => {
    if (session === null) return
    const project = splitToProject(session.character, session.split, session.drafts)
    const { specs } = validateProject(project)
    const payload = exportNativeBundle(project, specs)
    const outcome = await saveTextFile(exportFileName(project, "native"), JSON.stringify(payload, null, 2))
    setNotice(t(`studio.save.${outcome}`))
  }

  const toForge = () => {
    if (session === null) return
    importProject(splitToProject(session.character, session.split, session.drafts))
  }

  const toPack = () => {
    if (session === null) return
    const exposeLines = suggestExposePrefixes(session.drafts).map((prefix) => `.var expose ${prefix}`)
    const isJson = session.file.name.toLowerCase().endsWith(".json")
    const item: PackItem = {
      uid: uid(),
      fileName: isJson
        ? `${safeFileName(session.character.name || session.file.name, "card")}.st.json`
        : `${safeFileName(session.character.name || session.file.name, "card")}.png`,
      sourceName: session.file.name,
      kind: "card",
      base64: bytesToBase64(session.file.bytes),
      jsonText: isJson ? new TextDecoder().decode(session.file.bytes) : null,
      card: session.original,
      payloads: session.split.payloads,
      cardKind: payloadsAny(session.split.payloads) ? "world" : "character",
      hooks: session.split.hooks,
      leaves: session.leaves,
      leavesTruncated: session.truncated,
      drafts: session.drafts,
      extractSkill: false,
      notesEn: exposeLines.length > 0 ? `After world import: ${exposeLines.join(" · ")}` : "",
      notesZh: exposeLines.length > 0 ? `世界导入后建议执行:${exposeLines.join(" · ")}` : "",
      entryCount: 0,
    }
    seedFromSplit(item, item.notesZh, item.notesEn)
    setView("pack")
  }

  if (session === null) {
    return (
      <div className="split-empty">
        <p className="placeholder">{t("studio.split.emptyHint")}</p>
        <button type="button" className="ghost-button" onClick={() => void openCard()}>
          {t("studio.split.open")}
        </button>
        {error !== null ? (
          <p className="studio-notice split-error" role="alert">
            {t("studio.split.parseFailed", { detail: error })}
          </p>
        ) : null}
      </div>
    )
  }

  const { payloads } = session.split
  const exposePrefixes = suggestExposePrefixes(session.drafts)

  return (
    <div className="split-view">
      <div className="split-bar">
        <span className="split-file" title={session.file.path ?? session.file.name}>
          {session.file.name}
        </span>
        <span className={payloadsAny(payloads) ? "split-badge world" : "split-badge"}>
          {payloadsAny(payloads) ? t("studio.split.worldCard") : t("studio.split.plainCard")}
        </span>
        <span className="split-counts">
          {t("studio.split.counts", {
            hooks: payloads.hooks,
            vars: payloads.initvarEntries,
            ejs: payloads.ejsBlocks,
            secret: payloads.secretEntries,
          })}
        </span>
        <div className="header-spacer" />
        <button type="button" className="ghost-button" onClick={() => void openCard()}>
          {t("studio.split.openAnother")}
        </button>
      </div>
      {notice !== null ? (
        <p className="studio-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error !== null ? (
        <p className="studio-notice split-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="split-columns">
        <section className="split-column" aria-label={t("studio.split.characterHalf")}>
          <header className="split-column-head">
            <h2>{t("studio.split.characterHalf")}</h2>
            <p className="studio-hint">{t("studio.split.characterHint")}</p>
          </header>
          <label className="field">
            {t("studio.card.name")}
            <input
              value={session.character.name}
              onChange={(e) => patchCharacter({ name: e.target.value })}
            />
          </label>
          {PROSE_FIELDS.map((field) => (
            <label key={field} className="field">
              {t(`studio.split.fields.${field}`)}
              <textarea
                rows={field === "description" ? 5 : 3}
                value={session.character[field]}
                onChange={(e) => patchCharacter({ [field]: e.target.value })}
              />
            </label>
          ))}
          <p className="studio-hint">
            {t("studio.split.loreKept", { n: session.character.characterBook.length })}
          </p>
          <div className="split-actions">
            <button type="button" className="ghost-button" onClick={() => void exportCleanSt()}>
              {t("studio.split.exportClean")}
            </button>
            <button type="button" className="ghost-button" onClick={() => void exportNative()}>
              {t("studio.split.exportNative")}
            </button>
            <button type="button" className="primary-button" onClick={toForge}>
              {t("studio.split.toForge")}
            </button>
          </div>
        </section>

        <section className="split-column split-column-world" aria-label={t("studio.split.worldHalf")}>
          <header className="split-column-head">
            <h2>{t("studio.split.worldHalf")}</h2>
            <p className="studio-hint">{t("studio.split.worldHint")}</p>
          </header>

          <h3>{t("studio.split.hooksTitle", { n: payloads.hooks })}</h3>
          {session.split.hooks.length === 0 ? (
            <p className="placeholder">{t("studio.split.noHooks")}</p>
          ) : (
            session.split.hooks.map((code, index) => (
              <pre key={index} className="split-code">
                {code}
              </pre>
            ))
          )}

          <h3>{t("studio.split.ejsTitle", { n: payloads.ejsBlocks })}</h3>
          <p className="studio-hint">{t("studio.split.ejsHint")}</p>

          <h3>{t("studio.split.promoteTitle", { n: session.leaves.length })}</h3>
          <PromoteTable
            drafts={session.drafts}
            truncated={session.truncated}
            onDraft={patchDraft}
            onAiFill={() => void runAiLabels()}
            aiBusy={aiBusy}
            aiEnabled={aiReady(aiSettings)}
          />

          {exposePrefixes.length > 0 ? (
            <>
              <h3>{t("studio.split.exposeTitle")}</h3>
              <p className="studio-hint">{t("studio.split.exposeHint")}</p>
              <pre className="split-code">
                {exposePrefixes.map((prefix) => `.var expose ${prefix}`).join("\n")}
              </pre>
            </>
          ) : null}

          <div className="split-actions">
            <button type="button" className="primary-button" onClick={toPack}>
              {t("studio.split.toPack")}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
