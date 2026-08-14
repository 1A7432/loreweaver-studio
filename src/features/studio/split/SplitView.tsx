// The card-split (拆卡) workbench: open any SillyTavern card, see it decomposed
// into "character half | world half", edit both, then export each half to its
// native destination — clean card / editor project on the left, `.lwpack`
// source via the pack wizard on the right.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { bytesToBase64, pickCardFile } from "../../../lib/native"
import { saveTextFile } from "../../../lib/files"
import { useStudioStore } from "../../../store/studio"
import { initvarLeaves, usePackStore, type PackItem } from "../../../store/pack"
import { isTextCard, sessionBytes, sha256Hex, useSplitStore } from "../../../store/split"
import { aiFillLabels } from "../ai/labels"
import { aiReady, useAiStore } from "../ai/provider"
import { exportFileName, exportNativeBundle } from "../exporters"
import { describeImportFailure } from "../importErrors"
import { uid, validateProject } from "../model"
import { parseCardBytes } from "./charcard"
import { payloadsAny, splitCard } from "./cardSplit"
import { characterHalfToStCard, splitToProject } from "./convert"
import PromoteTable from "./PromoteTable"
import { promoteLeaves, suggestExposePrefixes } from "./promote"
import { safeFileName } from "./packSource"

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
  // Persisted: a tab switch or a reload used to destroy every edit here.
  const session = useSplitStore((s) => s.session)
  const setSession = useSplitStore((s) => s.setSession)
  const patchSession = useSplitStore((s) => s.patchSession)
  const patchCharacter = useSplitStore((s) => s.patchCharacter)
  const patchDraft = useSplitStore((s) => s.patchDraft)
  const reattach = useSplitStore((s) => s.reattach)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [aiBusy, setAiBusy] = useState(false)

  const openCard = async () => {
    setError(null)
    setNotice(null)
    try {
      const file = await pickCardFile()
      if (file === null) return
      let card
      try {
        card = await parseCardBytes(file.bytes, file.name)
      } catch (cause) {
        const problem = describeImportFailure(cause, file.name)
        setError(t(`studio.${problem.key}`, problem.params))
        return
      }
      const split = splitCard(card)
      const { leaves, truncated, problems } = initvarLeaves(split.initvarEntries)
      setSession({
        file: {
          name: file.name,
          path: file.path,
          size: file.bytes.length,
          sha256: await sha256Hex(file.bytes),
        },
        base64: bytesToBase64(file.bytes),
        needsReattach: false,
        original: card,
        character: split.character,
        split,
        leaves,
        truncated,
        initvarProblems: problems,
        drafts: promoteLeaves(leaves),
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** Hand back the bytes of a session restored without them (a PNG card). The
   * name is checked, not enforced: an author who renamed the file still knows
   * which card it is, and the size/hash readout is there to be compared. */
  const reattachCard = async () => {
    setError(null)
    try {
      const file = await pickCardFile()
      if (file === null) return
      reattach(file)
      setNotice(t("studio.split.reattached", { name: file.name }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const runAiLabels = async () => {
    if (session === null) return
    setAiBusy(true)
    try {
      patchSession({ drafts: await aiFillLabels(session.drafts) })
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
    const bytes = sessionBytes(session)
    if (bytes === null) {
      // The pack bench ships the card file as-is, so there is nothing honest to
      // hand it without the original bytes.
      setError(t("studio.split.reattachNeeded"))
      return
    }
    const exposeLines = suggestExposePrefixes(session.drafts).map((prefix) => `.var expose ${prefix}`)
    const isJson = isTextCard(session.file.name)
    const item: PackItem = {
      uid: uid(),
      fileName: isJson
        ? `${safeFileName(session.character.name || session.file.name, "card")}.st.json`
        : `${safeFileName(session.character.name || session.file.name, "card")}.png`,
      sourceName: session.file.name,
      kind: "card",
      base64: bytesToBase64(bytes),
      jsonText: isJson ? new TextDecoder().decode(bytes) : null,
      size: bytes.length,
      needsBytes: false,
      card: session.original,
      payloads: session.split.payloads,
      cardKind: payloadsAny(session.split.payloads) ? "world" : "character",
      hooks: session.split.hooks,
      leaves: session.leaves,
      leavesTruncated: session.truncated,
      initvarProblems: session.initvarProblems,
      episode: "",
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
            {error}
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
      {session.needsReattach ? (
        // Every EDIT survived the reload; only the file's raw bytes did not,
        // and only the hand-off to the pack bench needs them.
        <p className="studio-notice split-error" role="alert">
          {t("studio.split.reattachHint", {
            name: session.file.name,
            size: session.file.size,
            hash: session.file.sha256.slice(0, 12),
          })}{" "}
          <button type="button" className="ghost-button" onClick={() => void reattachCard()}>
            {t("studio.split.reattach")}
          </button>
        </p>
      ) : null}
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
          {session.initvarProblems.length > 0 ? (
            // The card still opened; these blocks simply contributed no
            // variables, which is invisible unless it is said out loud.
            <ul className="issue-list">
              {session.initvarProblems.map((problem, index) => (
                <li key={index} className="split-error">
                  {t(`studio.${problem.key}`, problem.params)}
                </li>
              ))}
            </ul>
          ) : null}
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
