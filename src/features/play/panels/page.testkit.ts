// Running a real page in jsdom, as far as jsdom can host one. Imported by tests only.
//
// What is real: the page's own HTML and script, the host-injected bootstrap (the very string
// `Tier2Frame` registered), and the host side of the bridge — the page's script RUNS here.
// What is emulated, because jsdom lacks it: the `panel://` scheme (the page is written into
// the mounted frame's document with the same head splice `panel_serve.rs` makes — that splice
// has its own Rust tests), and the browser's `MessageEvent.source` (jsdom's postMessage sets
// none, so both directions are delivered here with the sender a browser would name). jsdom
// enforces neither the sandbox nor the CSP: those are pinned by the attribute and header
// tests, not proven by running a page.

/** The splice `panel_serve.rs` makes: theme and bootstrap right after `<head…>`. */
export function servedDocument(html: string, bootstrapJs: string, themeCss: string): string {
  const at = html.search(/<head[\s>]/i)
  if (at < 0) throw new Error("the test page has no <head>")
  const end = html.indexOf(">", at) + 1
  return `${html.slice(0, end)}<style>${themeCss}</style>\n<script>${bootstrapJs}</script>\n${html.slice(end)}`
}

function deliver(target: Window, data: unknown, source: unknown): void {
  // An event of the receiving window's own realm, as a browser would make it.
  const Event = (target as Window & typeof globalThis).MessageEvent
  const event = new Event("message", { data: structuredClone(data) })
  Object.defineProperty(event, "source", { value: source })
  target.dispatchEvent(event)
}

/**
 * Serve `html` into the mounted `iframe`: messages the page posts to its parent reach the
 * app's window with the frame as their source, and messages the host posts to the frame reach
 * the page with its parent as their source. Returns the page's window.
 */
export function servePage(
  iframe: HTMLIFrameElement,
  html: string,
  head: { bootstrapJs: string; themeCss: string },
): Window {
  const page = iframe.contentWindow
  const doc = iframe.contentDocument
  if (page === null || doc === null) throw new Error("the frame has no window")
  const parent = {
    postMessage: (data: unknown, target: string) => {
      if (target !== "*") throw new Error(`the bootstrap posted to ${target}, not "*"`)
      setTimeout(() => deliver(window, data, page), 0)
    },
  }
  Object.defineProperty(page, "parent", { value: parent, configurable: true })
  Object.defineProperty(page, "postMessage", {
    configurable: true,
    value: (data: unknown, target: string) => {
      if (target !== "*") throw new Error(`the host posted to ${target}, not "*"`)
      setTimeout(() => deliver(page, data, parent), 0)
    },
  })
  doc.open()
  doc.write(servedDocument(html, head.bootstrapJs, head.themeCss))
  doc.close()
  return page
}
