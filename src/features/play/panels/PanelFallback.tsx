// A page panel this client cannot run, whose author gave no `fallback` (protocol 3.0
// §10.4 `panels`: `fallback: null`): one localized "needs a rich client" line.

import { useTranslation } from "react-i18next"

export default function PanelFallback() {
  const { t } = useTranslation()
  return <p className="panel-fallback-null">{t("panels.richOnly")}</p>
}
