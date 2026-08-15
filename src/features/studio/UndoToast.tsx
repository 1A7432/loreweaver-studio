// The undo offer, as a toast.
//
// Rendered once at the app root so a deletion made anywhere can be taken back
// from anywhere — including after switching views, which is exactly when an
// author notices they deleted the wrong thing.

import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { currentUndo, UNDO_WINDOW_MS, useUndoStore } from "../../store/undo"

/** Coarse tick: the toast only has to disappear roughly on time, and a second
 * of granularity keeps this from re-rendering the app 60 times a second. */
const TICK_MS = 500

export default function UndoToast() {
  const { t } = useTranslation()
  const entries = useUndoStore((s) => s.entries)
  const undo = useUndoStore((s) => s.undo)
  const dismiss = useUndoStore((s) => s.dismiss)
  const [now, setNow] = useState(() => Date.now())

  const newest = entries.at(-1)
  useEffect(() => {
    if (newest === undefined) return
    // Only tick while an offer could still be standing — and STOP once the
    // newest one has run out. Nothing else changes `newest`, so an interval
    // left running here would re-render the whole app twice a second for the
    // rest of the session over a toast that is no longer on screen.
    const timer = setInterval(() => {
      const at = Date.now()
      setNow(at)
      // Stopped by the SAME predicate that hides the toast, so the clock can
      // never outlive the offer or stop while it is still on screen.
      if (currentUndo([newest], at) === null) clearInterval(timer)
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [newest])

  const entry = currentUndo(entries, now)
  if (entry === null) return null

  const seconds = Math.max(0, Math.ceil((UNDO_WINDOW_MS - (now - entry.at)) / 1000))
  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <span>
        {entry.name.trim()
          ? t(`studio.undo.deleted.${entry.kind}`, { name: entry.name })
          : t(`studio.undo.deletedUnnamed.${entry.kind}`)}
      </span>
      <button type="button" className="primary-button" onClick={() => undo()}>
        {t("studio.undo.undo", { seconds })}
      </button>
      <button
        type="button"
        className="ghost-button"
        onClick={() => dismiss(entry.id)}
        aria-label={t("studio.undo.dismiss")}
      >
        {t("studio.undo.dismiss")}
      </button>
    </div>
  )
}
