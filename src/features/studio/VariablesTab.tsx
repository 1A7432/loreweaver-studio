import { useTranslation } from "react-i18next"
import { useStudioStore } from "../../store/studio"
import type { ForgeProject, ForgeVariable, Issue, VarKind, VarVisibility } from "./model"

const KINDS: VarKind[] = ["number", "bool", "text", "enum"]
const VISIBILITIES: VarVisibility[] = ["player", "keeper"]

function VariableRow({ variable, issues }: { variable: ForgeVariable; issues: Issue[] }) {
  const { t } = useTranslation()
  const update = useStudioStore((s) => s.updateVariable)
  const remove = useStudioStore((s) => s.removeVariable)
  const patch = (p: Partial<ForgeVariable>) => update(variable.uid, p)

  return (
    <div className="var-editor" data-uid={variable.uid}>
      <div className="var-editor-grid">
        <label className="field">
          {t("studio.vars.id")}
          <input
            value={variable.id}
            onChange={(e) => patch({ id: e.target.value })}
            placeholder="suspicion"
            spellCheck={false}
          />
        </label>
        <label className="field">
          {t("studio.vars.kind")}
          <select value={variable.kind} onChange={(e) => patch({ kind: e.target.value as VarKind })}>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`studio.vars.kinds.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("studio.vars.visibility")}
          <select
            value={variable.visibility}
            onChange={(e) => patch({ visibility: e.target.value as VarVisibility })}
          >
            {VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {t(`studio.vars.visibilities.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("studio.vars.labelEn")}
          <input value={variable.labelEn} onChange={(e) => patch({ labelEn: e.target.value })} />
        </label>
        <label className="field">
          {t("studio.vars.labelZh")}
          <input value={variable.labelZh} onChange={(e) => patch({ labelZh: e.target.value })} />
        </label>
        {variable.kind === "number" ? (
          <>
            <label className="field field-narrow">
              {t("studio.vars.min")}
              <input value={variable.minimum} onChange={(e) => patch({ minimum: e.target.value })} />
            </label>
            <label className="field field-narrow">
              {t("studio.vars.max")}
              <input value={variable.maximum} onChange={(e) => patch({ maximum: e.target.value })} />
            </label>
          </>
        ) : null}
        <label className="field">
          {t("studio.vars.default")}
          <input value={variable.defaultValue} onChange={(e) => patch({ defaultValue: e.target.value })} />
        </label>
        {variable.kind === "enum" ? (
          <label className="field field-wide">
            {t("studio.vars.options")}
            <textarea
              rows={2}
              value={variable.options}
              onChange={(e) => patch({ options: e.target.value })}
              placeholder={t("studio.vars.optionsPlaceholder")}
            />
          </label>
        ) : null}
        <button type="button" className="ghost-button var-remove" onClick={() => remove(variable.uid)}>
          {t("studio.remove")}
        </button>
      </div>
      {issues.length > 0 ? (
        <ul className="issue-list">
          {issues.map((issue, i) => (
            <li key={i}>{t(`studio.err.${issue.key}`, issue.params)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default function VariablesTab({
  project,
  issues,
}: {
  project: ForgeProject
  issues: Map<string, Issue[]>
}) {
  const { t } = useTranslation()
  const addVariable = useStudioStore((s) => s.addVariable)

  return (
    <div className="studio-form">
      <p className="studio-hint">{t("studio.vars.hint")}</p>
      {project.variables.map((variable) => (
        <VariableRow key={variable.uid} variable={variable} issues={issues.get(variable.uid) ?? []} />
      ))}
      <button type="button" className="ghost-button" onClick={addVariable}>
        {t("studio.vars.add")}
      </button>
    </div>
  )
}
