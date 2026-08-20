// The state half of the live-draft view (the render half is StreamPreview.tsx;
// they are two files so react-refresh keeps working on the component one).

import { useCallback, useState } from "react"
import type { DraftStreamEvent } from "./provider"

/** Accumulates stream events into displayable text. A `start` event clears the
 * pane: a validation retry REPLACES the rejected draft on screen, the same way
 * it replaces it in the result. */
export function useDraftStream(): {
  text: string
  onStream: (event: DraftStreamEvent) => void
} {
  const [text, setText] = useState("")
  const onStream = useCallback((event: DraftStreamEvent) => {
    if (event.kind === "start") setText("")
    else setText((previous) => previous + event.text)
  }, [])
  return { text, onStream }
}
