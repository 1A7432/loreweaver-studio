// Import a card file from this computer (protocol 3.0 §11.6): upload it with purpose `import` —
// stored where only admins can fetch it, announced to nobody — then `import {file, as}`. As a
// `character` it becomes this member's character; as a `world` (the room admin's) the room's
// world. The command's answer — what was imported and what was left behind — shows here, to
// this person, as the server wrote it. A character import waits on a model call: the button
// says so while it runs.

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { uploadFile } from "../../lib/media"
import { pickUploadPath } from "../../lib/native"
import { useConnection, useSessionSnapshot } from "../../store/connection"
import CommandFeedback from "./CommandFeedback"
import { useCommand, useCommandRunner, useOnline } from "./room"
import { transferErrorText, uploadBlocked } from "./transfer"

export default function ImportCard({ as }: { as: "character" | "world" }) {
  const { t } = useTranslation()
  const connection = useConnection()
  const online = useOnline()
  const usable = useCommand("import", ["file", "as"]) !== null
  const blocked = uploadBlocked(useSessionSnapshot())
  const { run, feedback, dismiss, pending } = useCommandRunner()
  const [uploading, setUploading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (!usable) return null

  const start = async () => {
    if (connection === null) return
    const path = await pickUploadPath("card", t("play.import.fileFilter"))
    if (path === null) return
    setFailure(null)
    dismiss()
    setUploading(true)
    let hash: string
    try {
      hash = (await uploadFile(connection, path, "import")).hash
    } catch (error) {
      setFailure(transferErrorText(error, t))
      return
    } finally {
      setUploading(false)
    }
    await run("import", { file: hash, as })
  }

  const busy = uploading || pending
  return (
    <div className="play-form">
      <h4 className="play-form-title">
        {as === "world" ? t("play.import.worldTitle") : t("play.import.characterTitle")}
      </h4>
      <p className="studio-hint">
        {as === "world" ? t("play.import.worldHint") : t("play.import.characterHint")}
      </p>
      {blocked !== null ? (
        <p className="studio-hint">{t(`play.transfer.blocked.${blocked}`)}</p>
      ) : (
        <button
          type="button"
          className="ghost-button"
          disabled={!online || busy}
          onClick={() => void start()}
        >
          {uploading
            ? t("play.import.uploading")
            : pending
              ? t("play.import.working")
              : t("play.import.pick")}
        </button>
      )}
      {failure !== null ? (
        <p className="connect-error" role="alert">
          {failure}
        </p>
      ) : null}
      <CommandFeedback feedback={feedback} onDismiss={dismiss} />
    </div>
  )
}
