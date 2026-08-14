// Which SillyTavern card comes out — said out loud, at every export point.
//
// The two flavors always existed and the difference is load-bearing: keeper-only
// (secret) lore has no safe representation in an ST card, where everything is
// player-visible. Stripping it makes a card safe to circulate; keeping it makes
// a card that stands on its own for the author's own table. Both are right; the
// wrong part was that the choice was invisible — the forge toolbar silently
// stripped, the wizard finish silently kept, and nothing said so.
//
// Per-site DEFAULTS are unchanged: the forge toolbar still starts on
// safe-to-circulate, the wizard finish still starts on release-with-secrets.

import { useTranslation } from "react-i18next"
import type { ExportFlavor } from "./exporters"

export default function ExportFlavorPicker({
  flavor,
  onChange,
  secretCount,
}: {
  flavor: ExportFlavor
  onChange: (flavor: ExportFlavor) => void
  /** How many lore entries the choice actually decides the fate of. */
  secretCount: number
}) {
  const { t } = useTranslation()
  return (
    <div className="export-flavor">
      <label className="field field-narrow">
        {t("studio.exportFlavor.label")}
        <select value={flavor} onChange={(e) => onChange(e.target.value as ExportFlavor)}>
          <option value="safe">{t("studio.exportFlavor.safe")}</option>
          <option value="release">{t("studio.exportFlavor.release")}</option>
        </select>
      </label>
      <p className="studio-hint">
        {secretCount === 0
          ? t("studio.exportFlavor.noSecrets")
          : t(flavor === "safe" ? "studio.exportFlavor.safeHint" : "studio.exportFlavor.releaseHint", {
              n: secretCount,
            })}
      </p>
    </div>
  )
}
