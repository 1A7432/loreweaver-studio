# The page bridge (version 2)

A **page panel** is one self-contained HTML file a pack ships ([LWF panels §7
"Pages"](https://github.com/1A7432/loreweaver/blob/v3/docs/lwf/formats/panels.md) on the
engine's `v3` branch). The format leaves the bridge between a page and the client "the desktop
client's to define". This document is that definition: the `window.loreweaver` object
Loreweaver Studio gives a page, what a page may and may not do, and the limits it runs under.
It is the reference; the code is `src/features/play/panels/bridge.ts` (both sides),
`Tier2Frame.tsx` (the frame) and `src-tauri/src/panel_serve.rs` (the `panel://` scheme).

A client that does not run pages shows the page's `fallback` blocks instead. So does this one
while the page loads, when it does not start, and when it was written for bridge version 1.

## The page

- ONE HTML file, UTF-8, at most **2 MiB**: scripts, styles, pictures and fonts inline (a
  picture is a `data:` URI). The engine refuses a script file beside a page.
- It is fetched by the hash the `panels` view gives (`page: {hash, size, mime: "text/html"}`,
  protocol 3.0 §10.6) over the byte channel, checked against that sha256, and served to the
  frame from the app's verified cache.
- It runs in an `<iframe sandbox="allow-scripts">` with an **opaque origin**, and has **no
  network** (see [The sandbox](#the-sandbox)).
- The host puts two things at the top of its `<head>` before any of the author's markup: a
  `<style>` defining the theme variables below, and the bootstrap `<script>` that defines
  `window.loreweaver`.

## Lifecycle

1. **Load.** `window.loreweaver` exists before the first author script runs.
2. **`ready()`.** The page calls it (once is enough; it returns the same promise). It resolves
   with the panel, the language, the theme and the member viewing it, and at that moment
   `views()` already holds the current values. A page that does not call `ready()` within
   **6 seconds** is treated as not started: the panel shows its fallback and a line saying so
   (a late `ready()` still wins). An uncaught error before `ready()` does the same at once,
   with the error's first line.
3. **Views and events.** From then on the page is told about every change of its views
   (`onViews`) and every new event of the room's log (`onEvent`).
4. **`run`.** The page acts by running commands, as the member viewing it.
5. **Unmount.** When the panel is closed, collapsed, its overlay dismissed, the page's hash or
   the app's language or theme changes, or the table is left, the frame is removed with
   everything in it. An open confirmation is withdrawn; nothing further is posted.

## `window.loreweaver`

```ts
interface Loreweaver {
  version: "2"
  ready(): Promise<{
    panel: { id: string; title: string } // id is `<pack>/<panel>`; title in the member's language
    locale: string // the app's language, e.g. "en", "zh"
    theme: "light" | "dark" | string
    member: { name: string; role: "player" | "admin" | "observer" }
  }>
  views(): Record<string, unknown | null>
  onViews(cb: (views: Record<string, unknown | null>) => void): () => void
  onEvent(
    cb: (event: { seq: number; id: string; ts: number; kind: string; turn?: number; data: unknown }) => void,
  ): () => void
  run(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<
    | { ok: true; text?: string; data?: unknown }
    | { ok: false; code: string; message: string; reason?: string }
  >
}
```

The object is frozen and cannot be replaced.

### `views()` and `onViews(cb)`

- Keyed by the **handles** the panel declared (`views: {me: me, tide: harbor/tide}` gives
  `me` and `tide`) — the same names a fallback's `{$view: "tide.level"}` uses.
- Each value is exactly what this member's session holds for that view (protocol 3.0 §10.4 and
  §10.5), with one thing taken out: a list element flagged `hidden: true` is removed at any
  depth — a panel never shows what an admin's view marks as hidden from players, on any screen
  (LWF panels §4.2). `null` means the value is not held: not arrived yet, or a module view the
  room does not have.
- Nothing else of the session crosses: not the other views, not the log beyond `onEvent`, not
  the connection.
- `views()` returns a fresh copy of the current values (`{}` before `ready()`).
- `onViews(cb)` calls `cb` once with the current values — at once if the page is ready, else
  when it becomes ready — and then on every change. The host subscribes the declared views
  while the page is mounted. It returns a function that unsubscribes `cb`.

### `onEvent(cb)`

- Each **new** event of the room's log after the page became ready, once, in log order, as the
  protocol delivers it (protocol 3.0 §7–§8) without the envelope's `type`. There is no replay
  of history, and events a page sees are the table's: already player-grade.
- A `rewind` (an undo) or a `reset` arrives as an event like any other; what it means for the
  page's own state is the page's business.
- Events that arrive while no callback is registered are kept, up to **32** (the oldest go),
  and handed to the first `onEvent` callback.
- It returns a function that unsubscribes `cb`.

### `run(command, args?)`

`command.run {id: command, args}` (protocol 3.0 §5.3), sent through the app's connection, as
the member viewing the page — with that member's role, the server's rate limit and the room's
turn order. `args` defaults to `{}` and must be a plain JSON object.

Before anything is sent, the host:

1. checks the shape: `command` a non-empty string of at most 200 code points, `args` an
   object that survives JSON (`invalid_params`), at most **16 KiB** as JSON (`too_large`);
2. applies the page's own rate limit: a burst of **4**, then one more every **2.5 s**
   (`rate_limited`) — on top of the server's per-member limit;
3. looks the command up in the `commands` view (§6.5): a command it does not list is refused
   with `unavailable` and `reason: "unknown"`, one listed with `available: false` with
   `unavailable` and the view's own `reason` (`observer`, `no_rule_system`, `no_media`, …);
4. for a command flagged `danger: true` (`undo`, `reset`, `save`, …), shows **its own**
   confirmation, naming the panel and the command. The page cannot see or click it. If the
   person declines (or presses Escape, or the panel goes away), the page gets `cancelled`. One
   question at a time: another `danger` run while one is open gets `busy`.

The answer:

- `{ok: true, text?, data?}` — the server's answer as it gave it: `text` written for the
  member in their language, `data` structured, per command (§5.1).
- `{ok: false, code, message}` — the server's refusal, passed through unchanged: `message` is
  in the member's language, `code` is stable. The codes a page meets most (§6.4):
  `unknown_command`, `forbidden`, `usage`, `unknown_arg`, `missing_arg`, `invalid_arg`,
  `too_long`, `no_rule_system`, `not_in_system`, `no_media`, `stale_generation`,
  `rate_limited`, `module_args`, `module_unavailable`, `command_failed`, `invalid_params`, and
  the commands' own (`bad_dice`, `no_character`, …). Treat any code you do not know as a plain
  refusal and show `message`.
- `{ok: false, code, message, reason?}` — a refusal the host made itself, nothing sent:

| `code`           | when                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_params` | `command` is not a non-empty string of ≤ 200 code points, or `args` is not a JSON object                                         |
| `too_large`      | `args` is over 16 KiB as JSON                                                                                                    |
| `rate_limited`   | the page's own burst is spent                                                                                                    |
| `unavailable`    | the `commands` view does not list the command (`reason: "unknown"`) or lists it as not available (`reason` as the view gives it) |
| `cancelled`      | a `danger` command the person declined                                                                                           |
| `busy`           | a `danger` command while the person is still answering another                                                                   |
| `not_ready`      | `run` before `ready()` was answered                                                                                              |
| `not_sent`       | the command did not reach the room (no connection, or no answer in time); `message` names the reason                             |

A local refusal's `message` is in the member's language too. `rate_limited` and
`invalid_params` can come from either side; `message` says which.

## Limits

| What                                     | Limit                                 | Constant (`bridge.ts` / `panel_serve.rs`) |
| ---------------------------------------- | ------------------------------------- | ----------------------------------------- |
| a page's HTML                            | 2 MiB                                 | `MAX_PAGE_BYTES`                          |
| time to call `ready()`                   | 6 s                                   | `HANDSHAKE_TIMEOUT_MS`                    |
| one message from the page, as JSON       | 64 KiB (dropped, with a console note) | `MAX_PAGE_MESSAGE_BYTES`                  |
| `run` arguments, as JSON                 | 16 KiB                                | `MAX_RUN_ARGS_BYTES`                      |
| `run` command id                         | 200 code points                       | `MAX_COMMAND_ID_CHARS`                    |
| `run` rate per page                      | burst 4, then 1 per 2.5 s             | `PAGE_RUN_BURST`, `PAGE_RUN_REFILL_MS`    |
| events kept before an `onEvent` callback | 32                                    | `MAX_QUEUED_EVENTS`                       |
| an error report before `ready()`         | one line, 200 characters              | `MAX_PANEL_ERROR_CHARS`                   |

## Theme

The page's `<head>` starts with a `:root` rule of the app's current theme, under a stable
contract: `--lw-bg`, `--lw-bg-raised`, `--lw-bg-inset`, `--lw-border`, `--lw-border-soft`,
`--lw-ink`, `--lw-ink-dim`, `--lw-ink-faint`, `--lw-accent`, `--lw-accent-strong`,
`--lw-accent-ink`, `--lw-danger`, `--lw-warn`, `--lw-ok`, `--lw-font-ui`, `--lw-font-story`,
`--lw-font-mono`. Use them with a fallback (`var(--lw-ink, #222)`); the frame's own background
is the panel's.

## The sandbox

The frame is `sandbox="allow-scripts"` and nothing else, with `referrerpolicy="no-referrer"`:
an opaque origin (no `allow-same-origin`), no forms, popups, top navigation, downloads, modal
dialogs (`alert`, `confirm`, `prompt`), pointer lock or presentation.

The page document is served with this Content-Security-Policy (pinned by a test in
`panel_serve.rs`):

```text
default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval';
style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; media-src data: blob:;
connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none';
manifest-src 'none'; base-uri 'none'; form-action 'none'
```

and `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-DNS-Prefetch-Control: off`. The app's own CSP pins where the frame may navigate:
`frame-src panel:` on macOS and Linux, `frame-src http://panel.localhost` on Windows (WebView2
serves a custom scheme as `http://<scheme>.localhost`).

**A page may:** run inline scripts (eval and WebAssembly included), use inline styles, show
`data:`/`blob:` pictures, fonts, sound and video, draw on a canvas, keep state in its own
variables, and talk to the host through `window.loreweaver`.

**A page may not:** load anything from a URL (scripts, styles, pictures, fonts, frames,
plugins, workers), make any request, submit a form, open a window, navigate the app, read the
app's storage or cookies, or reach the app except through the bridge. Its storage is that of
an opaque origin: assume it does not persist.

### Every way out, and what stops it

A page holds room data, so each path a script could use to send it somewhere was checked. The
WebViews: WKWebView (macOS), WebView2 (Windows, Chromium), WebKitGTK (Linux). Unless a row says
otherwise, the stop holds in all three — by the CSP and sandbox standards they implement; this
client's tests pin the attribute and the header, they do not run a page in each WebView.

| Path                                                                                             | What stops it                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`, `XMLHttpRequest`                                                                        | CSP `connect-src 'none'`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `WebSocket`, `EventSource`                                                                       | CSP `connect-src 'none'`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `navigator.sendBeacon`                                                                           | CSP `connect-src 'none'`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `<a ping>`                                                                                       | the ping is a request under `connect-src 'none'`; the click's navigation is stopped as below                                                                                                                                                                                                                                                                                                                                                      |
| `<img src="https://…">`, `<video>`/`<audio>` src                                                 | CSP `img-src` / `media-src` allow `data:` and `blob:` only                                                                                                                                                                                                                                                                                                                                                                                        |
| CSS `url()`, `@font-face`, `@import`                                                             | CSP `img-src` / `font-src` / `style-src` (inline only)                                                                                                                                                                                                                                                                                                                                                                                            |
| `<script src>`, `<link rel=stylesheet>`                                                          | CSP `script-src` / `style-src` (inline only)                                                                                                                                                                                                                                                                                                                                                                                                      |
| `<link rel=preload>`                                                                             | the CSP directive of what it preloads                                                                                                                                                                                                                                                                                                                                                                                                             |
| `<link rel=prefetch>`                                                                            | Chromium: `default-src 'none'`. WebKit: the same check applies where the engine supports the hint at all; not verified by a run in WKWebView or WebKitGTK                                                                                                                                                                                                                                                                                         |
| `<iframe>`, `<object>`, `<embed>`, workers                                                       | CSP `frame-src` / `child-src` / `object-src` / `worker-src` `'none'`                                                                                                                                                                                                                                                                                                                                                                              |
| a service worker                                                                                 | an opaque origin cannot register one                                                                                                                                                                                                                                                                                                                                                                                                              |
| `<base href>`                                                                                    | CSP `base-uri 'none'`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| form submission                                                                                  | sandbox (no `allow-forms`) and CSP `form-action 'none'`                                                                                                                                                                                                                                                                                                                                                                                           |
| `window.open`, `target=_blank`                                                                   | sandbox (no `allow-popups`)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `top.location = …` (navigating the app)                                                          | sandbox (no `allow-top-navigation`)                                                                                                                                                                                                                                                                                                                                                                                                               |
| `location = "https://…?data"`, a link, `<meta http-equiv=refresh>` (the frame navigating itself) | the APP's CSP `frame-src`, which governs every navigation of the frame: only `panel:` (macOS, Linux) or `http://panel.localhost` (Windows) is allowed, and the scheme serves nothing but a registered page under its secret token. Chromium checks it before the request is made; WebKit is expected to apply the parent's `frame-src` to the frame's own navigations too — not verified by a run                                                 |
| `postMessage` to the app                                                                         | only the bridge listens, and it accepts messages only from this frame's window with this mount's nonce; it answers with this member's own data                                                                                                                                                                                                                                                                                                    |
| `<link rel=dns-prefetch>`                                                                        | not covered by CSP anywhere. `X-DNS-Prefetch-Control: off` turns it off where the engine honours the header (WebKit and Chromium are documented to; not verified by a run)                                                                                                                                                                                                                                                                        |
| **`<link rel=preconnect>`**                                                                      | **not covered by CSP in Chromium (WebView2): a host name the page chooses can be looked up, and connected to, leaking what fits in a host name. Nothing in this client stops it. WebKit: not verified**                                                                                                                                                                                                                                           |
| **WebRTC (`RTCPeerConnection` with a STUN/TURN server)**                                         | **not stopped. No engine implements a CSP directive for WebRTC, and the sandbox has no flag for it. WKWebView (recent macOS) and WebView2 expose it; WebKitGTK only when the app enables WebRTC, which this app does not. Removing the constructor in the bootstrap would likely not hold (a page could take a fresh one from a nested `about:blank` frame, which loads no URL for `frame-src` to refuse), so the bootstrap does not pretend to** |

**The app's own IPC** (Tauri). The frame must not reach the app's commands. On macOS and
Linux, Tauri's IPC script — with the per-launch key every call must carry — is injected into
the main frame only, so the page has no key, and the `ipc://` request path is refused by
`connect-src 'none'`. **On Windows, WebView2 runs the app's initialization scripts in every
frame (wry 0.57 documents it), so the page's frame does hold the IPC object and its key.** The
`http://ipc.localhost` request path is still refused by `connect-src 'none'`; the other path,
`window.chrome.webview.postMessage`, is not governed by CSP, and whether WebView2 delivers it
from a sandboxed sub-frame to the app's handler has **not been verified**. Tauri counts the
`panel` scheme as a local origin, so a call that did arrive would be treated as the app's own.
This must be checked on Windows before page panels are trusted there.

## Version 1 pages

Bridge version 1 (protocol 2.x: `onState`, `send`, `intent {choice|input|roll}`, the `state`
snapshot) is gone. A page that calls `onState` or `send`, or posts a version-1 message, gets
its fallback and a line saying it was written for an older client.

## Example

A complete page: it reads the `me` view (declared as `views: {me: me}`), shows the member's
character, and rolls a d20 for the table. It is a fixture: the component tests run it in the
frame against the real connection and session (`Tier2Frame.test.tsx`), and the round-trip
gate's pack ships it and fetches it from a real server (`scripts/gen_roundtrip_pack.ts`).

```yaml
# ui/panels.yaml
panels:
  - id: quick-roll
    title: { en: Quick roll, zh: 快速掷骰 }
    slot: sidebar
    views: { me: me }
    entry: ui/quick-roll.html
    fallback:
      - { kind: text, text: { $view: me.member.name } }
```

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Quick roll</title>
    <style>
      body {
        margin: 0;
        padding: 12px;
        font: 14px/1.5 var(--lw-font-ui, sans-serif);
        color: var(--lw-ink, #222);
        background: transparent;
      }
      button {
        font: inherit;
      }
    </style>
  </head>
  <body>
    <p id="who">…</p>
    <button id="roll" type="button" disabled>Roll 1d20</button>
    <p id="answer" role="status"></p>
    <script>
      const lw = window.loreweaver
      const who = document.getElementById("who")
      const button = document.getElementById("roll")
      const answer = document.getElementById("answer")

      lw.ready().then(({ member }) => {
        // `me` is the handle this panel declared: `views: { me: me }`.
        lw.onViews((views) => {
          const character = views.me && views.me.character
          who.textContent = character ? character.name : member.name
        })
        button.disabled = false
        button.addEventListener("click", async () => {
          button.disabled = true
          const result = await lw.run("roll", { expr: "1d20" })
          answer.textContent = result.ok ? result.text || "Rolled." : result.message
          button.disabled = false
        })
      })
    </script>
  </body>
</html>
```
