import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./locales/en.json"
import zh from "./locales/zh.json"

const STORAGE_KEY = "lw-lang"

export const resources = {
  en: { translation: en },
  zh: { translation: zh },
} as const

/** Resolve the startup locale. `navigator.language` is optional — bun's test
 * runner (and some embedded WebViews) expose `navigator` without it. */
export function detectLanguage(
  stored: string | null | undefined,
  navigatorLanguage: string | null | undefined,
): "en" | "zh" {
  if (stored === "en" || stored === "zh") return stored
  const nav = typeof navigatorLanguage === "string" ? navigatorLanguage.toLowerCase() : ""
  return nav.startsWith("zh") ? "zh" : "en"
}

function initialLanguage(): string {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null
  const navLang =
    typeof navigator !== "undefined" && typeof navigator.language === "string"
      ? navigator.language
      : undefined
  return detectLanguage(stored, navLang)
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
