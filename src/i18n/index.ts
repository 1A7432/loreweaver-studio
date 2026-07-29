import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./locales/en.json"
import zh from "./locales/zh.json"

const STORAGE_KEY = "lw-lang"

export const resources = {
  en: { translation: en },
  zh: { translation: zh },
} as const

function initialLanguage(): string {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
  if (stored === "en" || stored === "zh") return stored
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en"
  return nav.startsWith("zh") ? "zh" : "en"
}

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
})

i18n.on("languageChanged", (lng) => {
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, lng)
})

export default i18n
