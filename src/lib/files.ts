import { invoke } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { isTauri } from "./transport"

export type SaveOutcome = "saved" | "copied" | "cancelled"

/**
 * Save text through the native dialog + a Rust write command. Outside the
 * shell (or where a save dialog is unsupported, e.g. iOS) fall back to the
 * clipboard so the export is never lost.
 */
export async function saveTextFile(defaultName: string, contents: string): Promise<SaveOutcome> {
  if (isTauri()) {
    try {
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
      if (path === null) return "cancelled"
      await invoke("write_text_file", { path, contents })
      return "saved"
    } catch {
      // Fall through to the clipboard fallback.
    }
  }
  await navigator.clipboard.writeText(contents)
  return "copied"
}
