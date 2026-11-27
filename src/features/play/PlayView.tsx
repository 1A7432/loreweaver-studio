// Play mode (protocol 3.0): the connect screen, then the room (`OnlineView`).

import { useEffect, useId, useState, type FormEvent } from "react"
import { useTranslation } from "react-i18next"
import { displayStatus } from "../../lib/connection"
import { pickDirectory } from "../../lib/native"
import { isTauri } from "../../lib/transport"
import { useConnectionState, useConnectionStore } from "../../store/connection"
import { useHostLocalStore } from "../../store/hostLocal"
import { useLastTableStore } from "../../store/lastTable"
import { describeFailure } from "./connectFailure"
import { describeHostProblem } from "./hostLocalText"
import OnlineView from "./OnlineView"
import StatusPill from "./StatusPill"

/** "Host locally & play": start a server on this machine and sit down at it as the
 * room admin. While one runs and the table is not on screen (the link dropped, the
 * app reloaded), the same button returns to it and Stop ends it. */
function HostLocalBlock() {
  const { t } = useTranslation()
  const phase = useHostLocalStore((s) => s.phase)
  const problem = useHostLocalStore((s) => s.problem)
  const running = useHostLocalStore((s) => s.running)
  const homeOverride = useHostLocalStore((s) => s.homeOverride)
  const effectiveHome = useHostLocalStore((s) => s.effectiveHome)
  const setHomeOverride = useHostLocalStore((s) => s.setHomeOverride)
  const refresh = useHostLocalStore((s) => s.refresh)
  const start = useHostLocalStore((s) => s.start)
  const stop = useHostLocalStore((s) => s.stop)
  const native = isTauri()

  useEffect(() => {
    void refresh()
  }, [refresh])

  const browse = async () => {
    const dir = await pickDirectory()
    if (dir !== null) setHomeOverride(dir)
  }

  const starting = phase === "starting"
  // A server this app started is up, but the table is not on screen.
  const serving = phase === "hosting" || (phase === "idle" && running)
  const described = problem !== null && problem.code !== "cancelled" ? describeHostProblem(problem, t) : null
  const offerStop = starting || serving || problem?.code === "already_running"

  return (
    <div className="host-local">
      <button
        type="button"
        className="host-local-button"
        disabled={!native || starting}
        onClick={() => void start()}
      >
        {starting ? <span className="spinner spinner-inline" aria-hidden="true" /> : null}
        {starting
          ? t("connect.hostLocal.starting")
          : serving
            ? t("connect.hostLocal.return")
            : t("connect.hostLocal.button")}
      </button>
      <p className="studio-hint">
        {!native
          ? t("connect.hostLocal.desktopOnly")
          : serving
            ? t("connect.hostLocal.running")
            : t("connect.hostLocal.hint")}
      </p>
      <div className="host-local-home">
        <label className="field">
          {t("connect.hostLocal.home")}
          <input
            value={homeOverride}
            placeholder={effectiveHome}
            spellCheck={false}
            disabled={!native || starting || serving}
            onChange={(e) => setHomeOverride(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost-button"
          disabled={!native || starting || serving}
          onClick={() => void browse()}
        >
          {t("studio.ai.browse")}
        </button>
      </div>
      {described !== null || offerStop ? (
        <div className="host-local-log">
          {described !== null ? (
            <div className="connect-error" role="alert">
              <p>{described.text}</p>
              {described.lines.length > 0 ? (
                <div className="host-local-lines">
                  {described.lines.map((line, index) => (
                    <div key={index} className="host-local-line">
                      {line}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {offerStop ? (
            <button type="button" className="ghost-button" onClick={() => void stop()}>
              {starting ? t("connect.hostLocal.cancel") : t("connect.hostLocal.stop")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** The access key is a credential: it never sits on screen in clear text
 * unless the operator asks (screenshots and recordings of this form are
 * routine). The toggle is a button beside the field, not inside its label, so
 * the field keeps the plain name "Access key" (and the button must not repeat
 * those words in an aria-label, or the field would have two matches by name). */
function SecretField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [shown, setShown] = useState(false)
  return (
    <div className="connect-secret">
      <label htmlFor={id}>{label}</label>
      <div className="connect-secret-row">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="ghost-button"
          aria-controls={id}
          title={t(shown ? "connect.hideKeyLabel" : "connect.showKeyLabel")}
          onClick={() => setShown(!shown)}
        >
          {t(shown ? "connect.hideKey" : "connect.showKey")}
        </button>
      </div>
    </div>
  )
}

export default function PlayView() {
  const { t } = useTranslation()
  const state = useConnectionState()
  const status = displayStatus(state)
  const failure = state.failure ? describeFailure(state.failure, t) : null
  const connect = useConnectionStore((s) => s.connect)
  const savedTicket = useLastTableStore((s) => s.ticket)
  const savedKey = useLastTableStore((s) => s.key)
  const savedName = useLastTableStore((s) => s.name)
  const forgetSaved = useConnectionStore((s) => s.forgetLastTable)
  const disconnect = useConnectionStore((s) => s.disconnect)

  // The form starts from the last table joined by hand, so a reload lands on
  // something the player only has to confirm. Nothing dials until they do.
  const [ticket, setTicket] = useState(() => useLastTableStore.getState().ticket)
  const [key, setKey] = useState(() => useLastTableStore.getState().key)
  const [name, setName] = useState(() => useLastTableStore.getState().name)

  // The room stays visible through reconnects; the form only returns once the
  // connection has ended (offline) or is dialing the very first time.
  if (status === "online" || status === "reconnecting") {
    return <OnlineView />
  }

  // A dial in flight does not lock the form. Connecting again replaces it (the
  // old connection is stopped), so a ticket pasted over a stale one
  // takes effect at once instead of waiting for the old attempt to give up;
  // Cancel drops the attempt and leaves the form as it was.
  const dialing = status === "connecting"
  const canSubmit = (status === "offline" || dialing) && ticket.trim().length > 0 && key.trim().length > 0

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    void connect(
      {
        ticket: ticket.trim(),
        key: key.trim(),
        name: name.trim() ? name.trim() : undefined,
      },
      { remember: true },
    )
  }

  const hasSaved = savedTicket !== "" && savedKey !== ""
  // Dials the SAVED table, whatever the form has been edited to since. Like
  // Connect it stays live while a dial is in flight: dialing again replaces it.
  const reconnectLast = () => {
    void connect(
      { ticket: savedTicket, key: savedKey, name: savedName ? savedName : undefined },
      { remember: true },
    )
  }
  const forgetLast = () => {
    forgetSaved()
    setTicket("")
    setKey("")
    setName("")
  }

  return (
    <div className="play-view">
      <section className="connect-card">
        <header className="connect-head">
          <h2>{t("connect.title")}</h2>
          <StatusPill />
        </header>

        <HostLocalBlock />

        {hasSaved ? (
          <div className="last-table">
            <p className="studio-hint">
              {t("connect.lastTable.label", {
                table: savedName ? `${savedName} · …${savedTicket.slice(-8)}` : `…${savedTicket.slice(-8)}`,
              })}
            </p>
            <div className="last-table-actions">
              <button type="button" className="last-table-button" onClick={reconnectLast}>
                {t("connect.lastTable.reconnect")}
              </button>
              <button
                type="button"
                className="ghost-button"
                title={t("connect.lastTable.forgetHint")}
                onClick={forgetLast}
              >
                {t("connect.lastTable.forget")}
              </button>
            </div>
          </div>
        ) : null}

        <form className="connect-form" onSubmit={onSubmit}>
          <label>
            {t("connect.ticket")}
            <textarea
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder={t("connect.ticketPlaceholder")}
              rows={3}
              spellCheck={false}
            />
          </label>
          <SecretField
            label={t("connect.key")}
            value={key}
            placeholder={t("connect.keyPlaceholder")}
            onChange={setKey}
          />
          <label>
            {t("connect.name")}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("connect.namePlaceholder")}
            />
          </label>
          <div className="connect-actions">
            <button type="submit" disabled={!canSubmit}>
              {t("connect.submit")}
            </button>
            {dialing ? (
              <button type="button" className="ghost-button" onClick={() => void disconnect()}>
                {t("connect.cancel")}
              </button>
            ) : null}
          </div>
        </form>

        {failure ? (
          <div className="connect-error" role="alert">
            <p>{failure.text}</p>
            {failure.detail ? <p className="connect-error-detail">{failure.detail}</p> : null}
          </div>
        ) : null}
      </section>
    </div>
  )
}
