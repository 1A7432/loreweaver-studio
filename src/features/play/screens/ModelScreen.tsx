// Model / config — the TUI KeeperModel core loop: show the live provider
// config, switch provider/model/key/base-url, pull the provider's model
// catalog when it has one. The API key field is write-only (the server echoes
// only api_key_masked back).

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { useAdminStore } from "../../../store/admin"
import ScreenShell from "./ScreenShell"

export default function ModelScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation()
  const config = useAdminStore((s) => s.config)
  const models = useAdminStore((s) => s.models)
  const modelsProvider = useAdminStore((s) => s.modelsProvider)
  const refreshConfig = useAdminStore((s) => s.refreshConfig)
  const listModels = useAdminStore((s) => s.listModels)
  const setModel = useAdminStore((s) => s.setModel)

  const [provider, setProvider] = useState("")
  const [chatModel, setChatModel] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")

  useEffect(() => {
    refreshConfig()
  }, [refreshConfig])

  // Every admin_config resets the form to the live values (incl. the reply to
  // our own apply); the key field always starts blank on purpose.
  useEffect(() => {
    if (config === null) return
    setProvider(config.provider)
    setChatModel(config.chat_model)
    setBaseUrl(config.base_url)
    setApiKey("")
  }, [config])

  const apply = () => {
    if (!provider.trim()) return
    setModel(provider.trim(), chatModel.trim() || undefined, apiKey || undefined, baseUrl.trim())
  }

  const catalog = modelsProvider === provider ? models : []

  return (
    <ScreenShell title={t("play.menu.model")} onBack={onBack} showAdminError>
      {config?.using_demo === true ? <p className="studio-notice">{t("play.model.demoActive")}</p> : null}
      <div className="play-form">
        <label className="field">
          {t("play.model.provider")}
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {(config?.providers ?? (provider ? [provider] : [])).map((name) => (
              <option key={name} value={name}>
                {name}
                {(config?.saved_providers ?? []).includes(name) ? ` ${t("play.model.ready")}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t("play.model.chatModel")}
          <input
            value={chatModel}
            onChange={(e) => setChatModel(e.target.value)}
            list="play-model-catalog"
            spellCheck={false}
          />
          <datalist id="play-model-catalog">
            {catalog.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <button
          type="button"
          className="ghost-button"
          onClick={() => listModels(provider || undefined, apiKey || undefined, baseUrl || undefined)}
        >
          {t("play.model.listModels")}
        </button>
        <label className="field">
          {t("play.model.baseUrl")}
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          {t("play.model.apiKey")}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config ? t("play.model.keyMasked", { masked: config.api_key_masked }) : ""}
          />
        </label>
        <button type="button" className="primary-button" onClick={apply} disabled={!provider.trim()}>
          {t("play.model.apply")}
        </button>
      </div>
    </ScreenShell>
  )
}
