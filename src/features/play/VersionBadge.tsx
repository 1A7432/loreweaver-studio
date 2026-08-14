// Who the two ends of this connection actually are.
//
// `welcome.version` is the server's own release version, and `welcome.protocol`
// is the wire version it speaks — the protocol document says the first "exists
// precisely for client/server drift detection". Neither was ever displayed, so
// an operator debugging a table had no way to see which server they were
// talking to short of reading its terminal.
//
// The soft flag is on the PROTOCOL, not on the two product versions: the studio
// and the engine are separate products with separate version lines, so
// comparing "0.1.0" to "2.1.dev141" would flag every healthy connection. A
// different protocol MINOR is the real drift — same major, so the connection is
// sound (the store refuses a major mismatch outright), but one side knows
// frames the other does not.

import { useTranslation } from "react-i18next"
import { PROTOCOL_VERSION } from "@loreweaver/protocol"
import { useConnectionStore } from "../../store/connection"
import { STUDIO_VERSION } from "../../version"

export default function VersionBadge() {
  const { t } = useTranslation()
  const welcome = useConnectionStore((s) => s.welcome)
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
        server: welcome.version || t("connect.versionUnknown"),
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
