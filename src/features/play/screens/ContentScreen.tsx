// The room admin's content: the packs installed on the server and which this room has on, the
// room's rule system, and the Keeper's skills — the `admin/content` view, subscribed only while
// this screen is open — and the commands that change them: `pack` (enable, disable, install),
// `rule` (the rule system) and `skill` (enable, disable). A world card from this computer comes
// in here too (`ImportCard` with `as: "world"`).
//
// Installing takes a ref — a path on the server, an `https://` URL or `gh:owner/repo[@tag]` —
// and the server fetches and installs before it answers; its answer is the pack's trust card in
// words (what it ships, and whether it runs code), shown here as the server wrote it.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars, type AdminContentSource } from "loreweaver-protocol/v3"
import CommandFeedback from "../CommandFeedback"
import ImportCard from "../ImportCard"
import { useCommand, useCommandRunner, useOnline, useView, useViews } from "../room"
import ScreenShell from "./ScreenShell"

function SourceTag({ source }: { source: AdminContentSource }) {
  const { t } = useTranslation()
  return (
    <span className="desk-tag">
      {source.kind === "pack" && source.id ? stripControlChars(source.id) : t("play.content.builtIn")}
    </span>
  )
}

function InstallPack() {
  const { t } = useTranslation()
  const online = useOnline()
  const { run, feedback, dismiss, pending } = useCommandRunner()
  const [ref, setRef] = useState("")
  const install = async () => {
    const wanted = ref.trim()
    if (wanted === "") return
    const result = await run("pack", { op: "install", ref: wanted })
    if (result?.ok) setRef("")
  }
  return (
    <div className="play-form">
      <h4 className="play-form-title">{t("play.content.installTitle")}</h4>
      <label className="field">
        {t("play.content.ref")}
        <input
          value={ref}
          spellCheck={false}
          placeholder={t("play.content.refPlaceholder")}
          onChange={(e) => setRef(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary-button"
        disabled={!online || pending || ref.trim() === ""}
        onClick={() => void install()}
      >
        {pending ? t("play.content.installing") : t("play.content.install")}
      </button>
      <p className="studio-hint">{t("play.content.installHint")}</p>
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </div>
  )
}

export default function ContentScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  useViews(["admin/content"])
  const content = useView("admin/content")
  const online = useOnline()
  const canPack = useCommand("pack", ["op", "id"]) !== null
  const canInstall = useCommand("pack", ["op", "ref"]) !== null
  const canRule = useCommand("rule", ["system"]) !== null
  const canSkill = useCommand("skill", ["op", "id"]) !== null
  const { run, feedback, dismiss, pending } = useCommandRunner()

  return (
    <ScreenShell title={t("play.menu.content")} onBack={onBack}>
      {content === null ? <p className="placeholder">{t("play.admin.loading")}</p> : null}
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
      {content !== null ? (
        <>
          <h4 className="play-form-title">{t("play.content.packs")}</h4>
          {content.packs.length === 0 ? <p className="placeholder">{t("play.content.noPacks")}</p> : null}
          <ul className="play-list">
            {content.packs.map((pack) => (
              <li key={pack.id} className="play-skill-row">
                <label className="audio-mute">
                  <input
                    type="checkbox"
                    checked={pack.enabled}
                    disabled={!online || pending || !canPack}
                    onChange={(e) =>
                      void run("pack", { op: e.target.checked ? "enable" : "disable", id: pack.id })
                    }
                  />
                  <span className="play-skill-name">{stripControlChars(pack.title) || pack.id}</span>
                </label>
                <span className="desk-tag">{stripControlChars(pack.version)}</span>
              </li>
            ))}
          </ul>
          {canInstall ? <InstallPack /> : null}
          <ImportCard as="world" />

          <h4 className="play-form-title">{t("play.content.ruleSystems")}</h4>
          <ul className="play-list">
            {content.ruleSystems.map((system) => (
              <li key={system.id} className="play-skill-row">
                <label className="audio-mute">
                  <input
                    type="radio"
                    name="rule-system"
                    checked={system.enabled}
                    disabled={!online || pending || !canRule}
                    onChange={() => void run("rule", { system: system.id })}
                  />
                  <span className="play-skill-name">{stripControlChars(system.title) || system.id}</span>
                </label>
                <SourceTag source={system.source} />
              </li>
            ))}
          </ul>

          <h4 className="play-form-title">{t("play.content.skills")}</h4>
          {content.skills.length === 0 ? <p className="placeholder">{t("play.content.noSkills")}</p> : null}
          <ul className="play-list">
            {content.skills.map((skill) => (
              <li key={skill.id} className="play-skill-row">
                <label className="audio-mute">
                  <input
                    type="checkbox"
                    checked={skill.enabled}
                    disabled={!online || pending || !canSkill}
                    onChange={(e) =>
                      void run("skill", { op: e.target.checked ? "enable" : "disable", id: skill.id })
                    }
                  />
                  <span className="play-skill-name">{stripControlChars(skill.title) || skill.id}</span>
                </label>
                <SourceTag source={skill.source} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </ScreenShell>
  )
}
