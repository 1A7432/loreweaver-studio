// Who the two ends of this connection actually are: the server's own release version
// (`welcome.server.version`) beside the studio's, and the wire version it speaks
// (`welcome.protocol`).
//
// The soft flag is on the PROTOCOL, not on the two product versions: the studio and the
// engine are separate products with separate version lines. A different protocol MINOR
// is the real drift — same major, so the connection is sound (the session refuses a
// major mismatch outright), but one side knows frames the other does not.

import { useTranslation } from "react-i18next"
import { PROTOCOL_VERSION } from "loreweaver-protocol/v3"
import { useSessionSnapshot } from "../../store/connection"
import { STUDIO_VERSION } from "../../version"

export default function VersionBadge() {
  const { t } = useTranslation()
  const welcome = useSessionSnapshot()?.welcome ?? null
  if (welcome === null) return null

  const serverProtocol = welcome.protocol
  const drifted = serverProtocol !== PROTOCOL_VERSION
  return (
    <span
      className={drifted ? "version-badge has-drift" : "version-badge"}
      title={
        drifted
          ? t("connect.protocolDrift", { server: serverProtocol, client: PROTOCOL_VERSION })
          : t("connect.protocolMatch", { protocol: serverProtocol })
      }
    >
      {t("connect.versions", {
        server: welcome.server.version || t("connect.versionUnknown"),
        client: STUDIO_VERSION,
      })}
      {drifted ? (
        <span className="version-drift-mark" aria-hidden="true">
          {" ⚠"}
        </span>
      ) : null}
    </span>
  )
}
