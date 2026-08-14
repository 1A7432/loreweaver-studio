// The advisory lint's face: a badge you can open, never a gate.
//
// Deliberately not a dialog and never modal — the engine CLI is the authority
// on whether a pack builds, and this list is a second opinion about whether it
// will DO anything. It gets a count, a disclosure, and nothing that can stop
// the author from shipping.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { lintSummary } from "./packLint"
import type { PackLintFinding } from "./model"

export function LintBadge({ findings, onClick }: { findings: PackLintFinding[]; onClick: () => void }) {
  const { t } = useTranslation()
  const { warn, info } = lintSummary(findings)
  const total = warn + info
  return (
    <button
      type="button"
      className={warn > 0 ? "studio-issues has-issues" : "studio-issues"}
      onClick={onClick}
      title={t("studio.lint.hint")}
    >
      {total === 0 ? t("studio.lint.clean") : t("studio.lint.count", { warn, info })}
    </button>
  )
}

export default function LintPanel({
  findings,
  collapsible = false,
}: {
  findings: PackLintFinding[]
  collapsible?: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(!collapsible)
  const { warn, info } = lintSummary(findings)

  if (findings.length === 0) {
    return (
      <p className="studio-notice" role="status">
        {t("studio.lint.clean")}
      </p>
    )
  }
  return (
    <section className="pack-output" aria-label={t("studio.lint.title")}>
      <div className="dialog-row">
        <h3>{t("studio.lint.title")}</h3>
        <span className="studio-hint">{t("studio.lint.count", { warn, info })}</span>
        <div className="header-spacer" />
        {collapsible ? (
          <button type="button" className="ghost-button" onClick={() => setOpen(!open)}>
            {t(open ? "studio.lint.hide" : "studio.lint.show")}
          </button>
        ) : null}
      </div>
      <p className="studio-hint">{t("studio.lint.hint")}</p>
      {open ? (
        <ul className="issue-list">
          {findings.map((finding, index) => (
            <li key={`${finding.ruleId}-${finding.target.id}-${index}`}>
              <span className={finding.severity === "warn" ? "split-badge world" : "split-badge"}>
                {t(`studio.lint.severity.${finding.severity}`)}
              </span>{" "}
              {t(`studio.lint.msg.${finding.key}`, finding.params)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
