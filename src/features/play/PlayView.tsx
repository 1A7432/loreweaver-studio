import { useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { useConnectionStore } from "../../store/connection"
import SessionView from "./SessionView"

function StatusPill() {
  const { t } = useTranslation()
  const status = useConnectionStore((s) => s.status)
  const attempt = useConnectionStore((s) => s.attempt)
  return (
    <span className={`status-pill status-${status}`} data-status={status}>
      <span className="status-dot" aria-hidden="true" />
      {t(`connect.status.${status}`)}
      {status === "reconnecting" && attempt > 0 ? ` (${t("connect.attempt", { n: attempt })})` : null}
    </span>
  )
}

export default function PlayView() {
  const { t } = useTranslation()
  const status = useConnectionStore((s) => s.status)
  const lastError = useConnectionStore((s) => s.lastError)
  const connect = useConnectionStore((s) => s.connect)

  const [ticket, setTicket] = useState("")
  const [key, setKey] = useState("")
  const [name, setName] = useState("")

  // The session stays visible through reconnects; the form only returns once
  // the transport has given up (offline) or is dialing the very first time.
  if (status === "online" || status === "reconnecting") {
    return <SessionView />
  }

  const offline = status === "offline"
  const canSubmit = offline && ticket.trim().length > 0 && key.trim().length > 0

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    void connect({
      ticket: ticket.trim(),
      key: key.trim(),
      name: name.trim() ? name.trim() : undefined,
    })
  }

  return (
    <div className="play-view">
      <section className="connect-card">
        <header className="connect-head">
          <h2>{t("connect.title")}</h2>
          <StatusPill />
        </header>

        <form className="connect-form" onSubmit={onSubmit}>
          <label>
            {t("connect.ticket")}
            <textarea
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder={t("connect.ticketPlaceholder")}
              rows={3}
              spellCheck={false}
              disabled={!offline}
            />
          </label>
          <label>
            {t("connect.key")}
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={t("connect.keyPlaceholder")}
              spellCheck={false}
              disabled={!offline}
            />
          </label>
          <label>
            {t("connect.name")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("connect.namePlaceholder")}
              disabled={!offline}
            />
          </label>
          <button type="submit" disabled={!canSubmit}>
            {t("connect.submit")}
          </button>
        </form>

        {lastError ? (
          <p className="connect-error" role="alert">
            {lastError}
          </p>
        ) : null}
      </section>
    </div>
  )
}
