// How the connect screen and the menu word "Host locally": a problem's code in its
// own sentence, with the details it carries (the server's last lines, the settings it
// refused) as plain lines under it; the server's start-up notes, each in words.

import type { TFunction } from "i18next"
import type { HostProblem } from "../../store/hostLocal"

export interface HostProblemText {
  readonly text: string
  /** Lines under it, as they came (a setting's name, an engine's problem, a stderr line). */
  readonly lines: readonly string[]
}

export function describeHostProblem(problem: HostProblem, t: TFunction): HostProblemText {
  switch (problem.code) {
    case "desktop_only":
      return { text: t("connect.hostLocal.desktopOnly"), lines: [] }
    case "no_engine":
      return {
        text: t("connect.hostLocal.problem.no_engine"),
        lines: problem.engines.map((engine) => `${engine.program}: ${engine.problem}`),
      }
    case "already_running":
      return { text: t("connect.hostLocal.problem.already_running", { dir: problem.dataDir }), lines: [] }
    case "refused":
      if (problem.refusal === "bad_settings") {
        return {
          text: t("connect.hostLocal.problem.bad_settings"),
          lines: problem.problems.map((entry) =>
            t(
              entry.problem === "missing"
                ? "connect.hostLocal.setting.missing"
                : "connect.hostLocal.setting.invalid",
              { variable: entry.variable },
            ),
          ),
        }
      }
      return { text: t("connect.hostLocal.problem.refused", { code: problem.refusal }), lines: [] }
    case "exited":
      return {
        text:
          problem.exitCode === null
            ? t("connect.hostLocal.problem.exited")
            : t("connect.hostLocal.problem.exitedCode", { code: problem.exitCode }),
        lines: problem.stderr,
      }
    case "timeout":
      return { text: t("connect.hostLocal.problem.timeout"), lines: problem.stderr }
    case "mint_failed":
      return {
        text: t("connect.hostLocal.problem.mint_failed", { code: problem.refusal ?? "?" }),
        lines: problem.stderr,
      }
    case "no_key":
      return { text: t("connect.hostLocal.problem.no_key"), lines: [] }
    case "io":
      return { text: t("connect.hostLocal.problem.io"), lines: [problem.detail] }
    case "cancelled":
      return { text: t("connect.hostLocal.problem.cancelled"), lines: [] }
    case "died":
      return {
        text:
          problem.exitCode === null
            ? t("connect.hostLocal.problem.died")
            : t("connect.hostLocal.problem.diedCode", { code: problem.exitCode }),
        lines: problem.stderr,
      }
    case "key_refused":
      return { text: t("connect.hostLocal.problem.key_refused"), lines: [] }
  }
}

/** The start-up notes with a sentence of their own (`connect.hostLocal.note.<code>`). */
const NOTE_CODES: ReadonlySet<string> = new Set([
  "model_not_configured",
  "recall_off",
  "context_window_unknown",
  "model_override_unusable",
])

export function describeHostNote(note: string, t: TFunction): string {
  return NOTE_CODES.has(note)
    ? t(`connect.hostLocal.note.${note}`)
    : t("connect.hostLocal.note.other", { code: note })
}
