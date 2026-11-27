// The room admin's model settings: what each model lane and image generation use now (the
// `admin/model` view, subscribed only while this screen is open — keys come masked), and the
// `model` / `imagegen` commands to change them. Server-wide: every room follows.
//
// An API key is typed into a masked field and lives only in the form's state: it goes out
// inside the one `command.run` that sets it (protocol 3.0 §6.9 — never as a typed line, where a
// slip makes it speech), is cleared from the form the moment that call is made, and is gone
// when the form closes. It is never put in a store, the log or the console.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { stripControlChars, type AdminModelLane, type AdminModelView } from "loreweaver-protocol/v3"
import CommandFeedback from "../CommandFeedback"
import { useCommand, useCommandRunner, useOnline, useView, useViews } from "../room"
import ScreenShell from "./ScreenShell"

type FormKind = { readonly kind: "lane"; readonly lane: AdminModelLane["lane"] } | { readonly kind: "image" }

interface Listed {
  readonly provider: string
  readonly models: readonly string[]
  readonly total: number
  readonly truncated: boolean
}

/** The models out of a `model list` answer; null when it is not that shape. */
function listedFrom(data: unknown, asked: string): Listed | null {
  if (typeof data !== "object" || data === null) return null
  const record = data as Record<string, unknown>
  if (!Array.isArray(record.models)) return null
  const models = record.models.filter((entry): entry is string => typeof entry === "string")
  return {
    provider: typeof record.provider === "string" ? record.provider : asked,
    models,
    total: typeof record.total === "number" ? record.total : models.length,
    truncated: record.truncated === true,
  }
}

const OTHER = "\u0000other"

function ModelForm({
  form,
  view,
  onClose,
}: {
  form: FormKind
  view: AdminModelView
  onClose: (text: string | null) => void
}) {
  const { t } = useTranslation()
  const online = useOnline()
  const setter = useCommandRunner()
  const lister = useCommandRunner()
  const providers =
    form.kind === "lane"
      ? view.providers.map((entry) => ({ id: entry.id, credential: entry.credential }))
      : view.imageProviders
  const current =
    form.kind === "lane"
      ? (view.lanes.find((lane) => lane.lane === form.lane) ?? null)
      : { provider: view.imagegen.provider, model: view.imagegen.model }
  const known = providers.some((entry) => entry.id === current?.provider)
  const [provider, setProvider] = useState(known ? (current?.provider ?? "") : (providers[0]?.id ?? OTHER))
  const [name, setName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const startModel = known ? (current?.model ?? "") : ""
  const [model, setModel] = useState(startModel)
  // Until the admin types or picks a model, the field follows the provider: the lane's own
  // model belongs to its own provider.
  const [modelTouched, setModelTouched] = useState(false)
  const [size, setSize] = useState(form.kind === "image" ? (view.imagegen.size ?? "") : "")
  // The typed API key: this form's, until it is sent or the form closes.
  const [secret, setSecret] = useState("")
  const [listed, setListed] = useState<Listed | null>(null)
  const other = provider === OTHER
  const command = form.kind === "lane" ? "model" : "imagegen"
  const providerName = other ? name.trim() : provider

  const submit = async () => {
    if (providerName === "" || (other && baseUrl.trim() === "")) return
    const args: Record<string, unknown> =
      form.kind === "lane"
        ? { op: "set", lane: form.lane, provider: providerName }
        : { op: "set", provider: providerName }
    if (model.trim() !== "") args.model = model.trim()
    if (baseUrl.trim() !== "") args.baseUrl = baseUrl.trim()
    if (form.kind === "image" && size.trim() !== "") args.size = size.trim()
    if (secret.trim() !== "") args.key = secret.trim()
    // The key is in `args` and goes out in this one call: gone from the form now.
    setSecret("")
    const result = await setter.run(command, args)
    if (result?.ok) onClose(result.text ?? null)
  }

  const list = async () => {
    if (form.kind !== "lane" || providerName === "") return
    setListed(null)
    const result = await lister.run("model", { op: "list", provider: providerName, lane: form.lane })
    if (result?.ok) setListed(listedFrom(result.data, providerName))
  }

  return (
    <div className="play-form model-form">
      <h4 className="play-form-title">
        {form.kind === "lane"
          ? t("play.model.titleLane", { lane: t(`play.model.lanes.${form.lane}`) })
          : t("play.model.titleImage")}
      </h4>
      <label className="field">
        {t("play.model.provider")}
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value)
            setListed(null)
            if (!modelTouched) setModel(e.target.value === current?.provider ? startModel : "")
          }}
        >
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {stripControlChars(entry.id)}
              {entry.credential ? ` · ${t("play.model.keySaved")}` : ""}
            </option>
          ))}
          <option value={OTHER}>{t("play.model.other")}</option>
        </select>
      </label>
      {other ? (
        <label className="field">
          {t("play.model.name")}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("play.model.namePlaceholder")}
          />
        </label>
      ) : null}
      {form.kind === "image" || other ? (
        <label className="field">
          {t("play.model.baseUrl")}
          <input value={baseUrl} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      ) : null}
      <label className="field">
        {t("play.model.model")}
        <input
          value={model}
          spellCheck={false}
          onChange={(e) => {
            setModelTouched(true)
            setModel(e.target.value)
          }}
        />
      </label>
      {form.kind === "lane" ? (
        <div className="chip-row">
          <button
            type="button"
            className="ghost-button"
            disabled={!online || lister.pending || providerName === ""}
            onClick={() => void list()}
          >
            {lister.pending ? t("play.model.listing") : t("play.model.list")}
          </button>
        </div>
      ) : null}
      <CommandFeedback feedback={lister.feedback} onDismiss={lister.dismiss} />
      {listed !== null ? (
        listed.models.length === 0 ? (
          <p className="studio-hint">{t("play.model.listEmpty")}</p>
        ) : (
          <label className="field">
            {t("play.model.listed", {
              count: listed.models.length,
              provider: stripControlChars(listed.provider),
            })}
            <select
              value={listed.models.includes(model) ? model : ""}
              onChange={(e) => {
                setModelTouched(true)
                setModel(e.target.value)
              }}
            >
              <option value="">{t("play.model.pick")}</option>
              {listed.models.map((id) => (
                <option key={id} value={id}>
                  {stripControlChars(id)}
                </option>
              ))}
            </select>
          </label>
        )
      ) : null}
      {listed?.truncated ? (
        <p className="studio-hint">
          {t("play.model.listTruncated", { shown: listed.models.length, total: listed.total })}
        </p>
      ) : null}
      <label className="field">
        {t("play.model.key")}
        <input
          type="password"
          value={secret}
          autoComplete="off"
          spellCheck={false}
          placeholder={t("play.model.keyPlaceholder")}
          onChange={(e) => setSecret(e.target.value)}
        />
      </label>
      <p className="studio-hint">{t("play.model.keyNote")}</p>
      {form.kind === "image" ? (
        <label className="field">
          {t("play.model.size")}
          <input
            value={size}
            spellCheck={false}
            placeholder="1024x1024"
            onChange={(e) => setSize(e.target.value)}
          />
        </label>
      ) : null}
      <div className="chip-row">
        <button
          type="button"
          className="primary-button"
          disabled={!online || setter.pending || providerName === "" || (other && baseUrl.trim() === "")}
          onClick={() => void submit()}
        >
          {setter.pending ? t("play.busy") : t("play.model.apply")}
        </button>
        <button
          type="button"
          className="ghost-button"
          disabled={setter.pending}
          onClick={() => onClose(null)}
        >
          {t("play.model.cancel")}
        </button>
      </div>
      <CommandFeedback feedback={setter.feedback} onDismiss={setter.dismiss} />
    </div>
  )
}

export default function ModelScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  useViews(["admin/model"])
  const view = useView("admin/model")
  const online = useOnline()
  const canModel = useCommand("model", ["op", "lane", "provider", "model", "key", "baseUrl"]) !== null
  const canImage = useCommand("imagegen", ["op", "provider", "model", "size", "key", "baseUrl"]) !== null
  const [form, setForm] = useState<FormKind | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const runner = useCommandRunner()

  const close = (text: string | null) => {
    setForm(null)
    setDone(text)
  }

  return (
    <ScreenShell title={t("play.menu.model")} onBack={onBack}>
      {!canModel ? <p className="placeholder">{t("play.admin.unavailable")}</p> : null}
      {view === null && canModel ? <p className="placeholder">{t("play.admin.loading")}</p> : null}
      {done !== null ? (
        <div className="command-feedback is-answer" role="status">
          <p className="command-feedback-text">{stripControlChars(done)}</p>
        </div>
      ) : null}
      {view !== null && form !== null ? <ModelForm form={form} view={view} onClose={close} /> : null}
      {view !== null && canModel && form === null ? (
        <>
          <p className="studio-hint">{t("play.model.serverWide")}</p>
          <table className="play-table">
            <thead>
              <tr>
                <th>{t("play.model.lane")}</th>
                <th>{t("play.model.provider")}</th>
                <th>{t("play.model.model")}</th>
                <th>{t("play.model.key")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {view.lanes.map((lane) => (
                <tr key={lane.lane}>
                  <td>
                    {t(`play.model.lanes.${lane.lane}`)}
                    <span className="desk-tag">
                      {lane.sameAsKeeper && lane.lane !== "keeper"
                        ? t("play.model.sameAsKeeper")
                        : t(`play.model.source.${lane.source}`)}
                    </span>
                  </td>
                  <td>{stripControlChars(lane.provider ?? "") || t("play.model.none")}</td>
                  <td>{stripControlChars(lane.model ?? "") || t("play.model.none")}</td>
                  <td>
                    <code>
                      {lane.key.set ? stripControlChars(lane.key.masked ?? "") : t("play.model.noKey")}
                    </code>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!online}
                      onClick={() => {
                        setDone(null)
                        setForm({ kind: "lane", lane: lane.lane })
                      }}
                    >
                      {t("play.model.change")}
                    </button>
                    {lane.source === "override" ? (
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={!online || runner.pending}
                        onClick={() => void runner.run("model", { op: "reset", lane: lane.lane })}
                      >
                        {t("play.model.reset")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {canImage ? (
                <tr>
                  <td>
                    {t("play.model.image")}
                    <span className="desk-tag">{t(`play.model.source.${view.imagegen.source}`)}</span>
                  </td>
                  <td>
                    {view.imagegen.enabled
                      ? stripControlChars(view.imagegen.provider ?? "") || t("play.model.none")
                      : t("play.model.imageOff")}
                  </td>
                  <td>{stripControlChars(view.imagegen.model ?? "") || t("play.model.none")}</td>
                  <td>
                    <code>
                      {view.imagegen.key.set
                        ? stripControlChars(view.imagegen.key.masked ?? "")
                        : t("play.model.noKey")}
                    </code>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!online}
                      onClick={() => {
                        setDone(null)
                        setForm({ kind: "image" })
                      }}
                    >
                      {t("play.model.change")}
                    </button>
                    {view.imagegen.enabled ? (
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={!online || runner.pending}
                        onClick={() => void runner.run("imagegen", { op: "off" })}
                      >
                        {t("play.model.imageTurnOff")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <CommandFeedback feedback={runner.feedback} onDismiss={runner.dismiss} />
        </>
      ) : null}
    </ScreenShell>
  )
}
