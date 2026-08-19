// The live view of a draft being generated. One hook + one strip of <pre>,
// shared by every drafting surface: the transport streams everywhere (that is
// what keeps buffering gateways from 408-ing a long card), and any surface
// that wants the author to SEE the draft grow wires these two lines in.
//
// The preview is raw model output on its way to the validation gate — it is
// deliberately unstyled text, not parsed content, because nothing here has
// passed the gate yet.

import { useEffect, useRef } from "react"

/** Renders only while a generation is live and has produced text. Follows the
 * tail like a terminal — the author watches the newest tokens, not the top. */
export function StreamPreview({ text, busy }: { text: string; busy: boolean }) {
  const pane = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const node = pane.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [text])
  if (!busy || text === "") return null
  return (
    <pre ref={pane} className="ai-stream-preview" aria-live="polite">
      {text}
    </pre>
  )
}
