import { invoke } from "@tauri-apps/api/core"
import { save } from "@tauri-apps/plugin-dialog"
import { bytesToBase64 } from "./native"
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
  try {
    await navigator.clipboard.writeText(contents)
    return "copied"
  } catch {
    // Clipboard can reject (unfocused document, denied permission) — surface
    // a cancelled outcome instead of an unhandled rejection with no notice.
    return "cancelled"
  }
}

/**
 * Binary sibling of `saveTextFile`: native dialog + base64 over the bridge.
 * Outside the shell fall back to an anchor download (no clipboard equivalent
 * for binary payloads).
 */
export async function saveBinaryFile(
  defaultName: string,
  bytes: Uint8Array,
  extension: string,
): Promise<SaveOutcome> {
  if (isTauri()) {
    try {
      const path = await save({
        defaultPath: defaultName,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      })
      if (path === null) return "cancelled"
      await invoke("write_binary_file", { path, base64: bytesToBase64(bytes) })
      return "saved"
    } catch {
      // Fall through to the anchor-download fallback.
    }
  }
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer]))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = defaultName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return "saved"
}
