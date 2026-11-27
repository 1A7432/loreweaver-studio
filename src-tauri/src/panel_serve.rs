//! `panel://` — the locked-down scheme a page panel's frame loads from
//! (LWF panels §7 "Pages"; the bridge is `docs/PAGE-BRIDGE.md`).
//!
//! A page is ONE self-contained HTML file, fetched by hash over the byte channel
//! into the sha256-verified asset cache. One registration per MOUNTED frame,
//! keyed by an unguessable token the WebView mints, names that hash:
//! `panel://localhost/<token>/page.html` (WebView2 on Windows maps the same
//! thing to `http://panel.localhost/<token>/page.html`). The handler serves
//! exactly that one document, straight from the verified cache, with the
//! bridge's bootstrap script and the theme variables spliced into its `<head>`.
//! Nothing else resolves: no other path under the token, no other token, no
//! file of the cache that was not registered.
//!
//! The frame is `sandbox="allow-scripts"` (an opaque origin) and every response
//! carries [`PAGE_CSP`]: inline scripts and styles and `data:`/`blob:` pictures,
//! fonts and media — what a self-contained page needs — and nothing that
//! reaches out. A page holds room data, so it has no network at all.

use std::collections::HashMap;
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use tauri::http;
use tauri::{AppHandle, Runtime, State};

use crate::asset_cache;

/// The one path a registration serves under its token.
pub const ENTRY_PATH: &str = "page.html";

/// A page's HTML, in bytes (LWF panels §7; the engine refuses a bigger one).
pub const MAX_PAGE_BYTES: u64 = 2 * 1024 * 1024;
/// The host's own additions: the bridge bootstrap and the theme variables.
pub const MAX_BOOTSTRAP_BYTES: usize = 64 * 1024;
pub const MAX_THEME_BYTES: usize = 16 * 1024;

/// The Content-Security-Policy of every page document, as shipped. Each
/// directive, and what it is for:
///
/// - `default-src 'none'`: anything not named below is refused;
/// - `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`: the page's
///   own inline scripts (and the host's bootstrap), and run-time code from
///   them — no script from any URL. Eval opens no channel a page does not
///   already have, and bundled pages use it;
/// - `style-src 'unsafe-inline'`: inline `<style>` and `style=`, no stylesheet
///   from any URL (a remote `@import` is refused too);
/// - `img-src`, `font-src`, `media-src` `data: blob:`: pictures, fonts and
///   sound carried inside the file, or made by its script — never fetched;
/// - `connect-src 'none'`: no fetch, XHR, WebSocket, EventSource, beacon or
///   `<a ping>`;
/// - `frame-src`, `child-src`, `worker-src`, `object-src`, `manifest-src`
///   `'none'`: no nested frame, worker, plugin or manifest;
/// - `base-uri 'none'`, `form-action 'none'`: no `<base>` and no form
///   submission (the sandbox refuses forms as well).
pub const PAGE_CSP: &str = "default-src 'none'; \
     script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; \
     style-src 'unsafe-inline'; \
     img-src data: blob:; font-src data: blob:; media-src data: blob:; \
     connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; \
     object-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'";

/// What a refusal carries: nothing to run, nothing to load.
const DENY_CSP: &str = "default-src 'none'";

#[derive(Debug, Clone, PartialEq, Eq)]
struct PageRegistration {
    hash: String,
    bootstrap_js: String,
    theme_css: String,
}

type Table = Mutex<HashMap<String, PageRegistration>>;

#[derive(Default)]
pub struct PanelServeState(Table);

fn valid_token(token: &str) -> bool {
    (16..=64).contains(&token.len())
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'z'))
}

/// Check one registration before it is kept. The bootstrap and the theme are
/// spliced into the page as an inline `<script>` and `<style>`, so neither may
/// close its element early.
fn registration(
    hash: &str,
    bootstrap_js: String,
    theme_css: String,
) -> Result<PageRegistration, String> {
    let hash = hash.to_ascii_lowercase();
    if !asset_cache::is_sha256_hex(&hash) {
        return Err(format!("bad page hash: {hash:?}"));
    }
    if bootstrap_js.len() > MAX_BOOTSTRAP_BYTES {
        return Err("bootstrap too large".to_owned());
    }
    if bootstrap_js.to_ascii_lowercase().contains("</script") {
        return Err("the bootstrap would close its script element".to_owned());
    }
    if theme_css.len() > MAX_THEME_BYTES {
        return Err("theme too large".to_owned());
    }
    if theme_css.contains('<') {
        return Err("the theme would close its style element".to_owned());
    }
    Ok(PageRegistration {
        hash,
        bootstrap_js,
        theme_css,
    })
}

/// Mount one page's frame. Called by the page host right before the frame
/// gets its `src`, after the page's bytes are in the verified cache; replaced
/// wholesale on re-register.
#[tauri::command]
pub fn panel_serve_register(
    state: State<'_, PanelServeState>,
    token: String,
    hash: String,
    bootstrap_js: String,
    theme_css: String,
) -> Result<(), String> {
    if !valid_token(&token) {
        return Err("bad serve token".to_owned());
    }
    let registration = registration(&hash, bootstrap_js, theme_css)?;
    state
        .0
        .lock()
        .map_err(|_| "panel serve state poisoned".to_owned())?
        .insert(token, registration);
    Ok(())
}

#[tauri::command]
pub fn panel_serve_unregister(
    state: State<'_, PanelServeState>,
    token: String,
) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "panel serve state poisoned".to_owned())?
        .remove(&token);
    Ok(())
}

/// Split a request path (`/<token>/<file>`, percent-encoded) into the token and
/// the one file name. Anything with more or fewer segments is None.
pub fn split_token_path(request_path: &str) -> Option<(String, String)> {
    let trimmed = request_path.strip_prefix('/').unwrap_or(request_path);
    let mut segments = trimmed.split('/');
    let token = segments.next()?.to_owned();
    if !valid_token(&token) {
        return None;
    }
    let file = percent_decode_str(segments.next()?)
        .decode_utf8()
        .ok()?
        .into_owned();
    if segments.next().is_some() || file.is_empty() {
        return None;
    }
    Some((token, file))
}

/// Host-injected tags: the theme first (its custom properties are ready before
/// the author's styles), then the bridge bootstrap, a classic inline script,
/// so `window.loreweaver` exists before any author script runs.
fn head_snippet(registration: &PageRegistration) -> String {
    format!(
        "<style>{}</style>\n<script>{}</script>\n",
        registration.theme_css, registration.bootstrap_js
    )
}

/// Insert `snippet` where the browser will parse it first: right after
/// `<head…>`, else right after `<html…>`, else after a leading doctype, else
/// at the very top. Author documents are arbitrary built HTML — this stays a
/// byte-level splice, never a reparse.
pub fn inject_head(html: &str, snippet: &str) -> String {
    let lower = html.to_ascii_lowercase();
    for opener in ["<head", "<html"] {
        if let Some(start) = lower.find(opener) {
            // Only a real tag opener counts (`<header>` must not match `<head`).
            let after = lower.as_bytes().get(start + opener.len()).copied();
            let is_tag = matches!(
                after,
                Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')
            );
            if is_tag {
                if let Some(end) = lower[start..].find('>') {
                    let at = start + end + 1;
                    return format!("{}{}{}", &html[..at], snippet, &html[at..]);
                }
            }
        }
    }
    if let Some(start) = lower.find("<!doctype") {
        if lower[..start].trim().is_empty() {
            if let Some(end) = lower[start..].find('>') {
                let at = start + end + 1;
                return format!("{}{}{}", &html[..at], snippet, &html[at..]);
            }
        }
    }
    format!("{snippet}{html}")
}

fn respond(status: u16, csp: &str, mime: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Security-Policy", csp)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        // No speculative DNS lookups of host names in the page (in an engine
        // that honours it; once off, a page cannot turn it back on).
        .header("X-DNS-Prefetch-Control", "off")
        .body(body)
        .expect("static response headers are valid")
}

fn deny(status: u16) -> http::Response<Vec<u8>> {
    respond(status, DENY_CSP, "text/plain", Vec::new())
}

/// Answer one request against the registrations, reading a verified cache
/// entry by hash through `read`. Pure: the handler below gives it the app's
/// state and cache.
fn serve(
    table: &Table,
    method: &http::Method,
    path: &str,
    read: impl FnOnce(&str) -> Option<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    if method != http::Method::GET && method != http::Method::HEAD {
        return deny(405);
    }
    let Some((token, file)) = split_token_path(path) else {
        return deny(404);
    };
    if file != ENTRY_PATH {
        return deny(404);
    }
    // Resolve under the lock, read the cache after it drops.
    let registration = {
        let Ok(table) = table.lock() else {
            return deny(500);
        };
        match table.get(&token) {
            Some(registration) => registration.clone(),
            None => return deny(404),
        }
    };
    let Some(bytes) = read(&registration.hash) else {
        return deny(404);
    };
    if bytes.len() as u64 > MAX_PAGE_BYTES {
        return deny(413);
    }
    let Ok(html) = String::from_utf8(bytes) else {
        return deny(415);
    };
    let injected = inject_head(&html, &head_snippet(&registration));
    respond(
        200,
        PAGE_CSP,
        "text/html; charset=utf-8",
        injected.into_bytes(),
    )
}

pub fn handle_panel_request<R: Runtime>(
    app: &AppHandle<R>,
    request: &http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    use tauri::Manager;
    let state = app.state::<PanelServeState>();
    serve(&state.0, request.method(), request.uri().path(), |hash| {
        read_cached(app, hash)
    })
}

fn read_cached<R: Runtime>(app: &AppHandle<R>, hash: &str) -> Option<Vec<u8>> {
    let dir = asset_cache::cache_dir(app).ok()?;
    let path = asset_cache::lookup(&dir, hash)?;
    std::fs::read(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "abcdef0123456789abcdef0123456789";
    const PAGE: &str = "<!doctype html><html><head><title>t</title><script>author()</script></head><body>hi</body></html>";

    fn table_with(hash: &str) -> Table {
        let mut table = HashMap::new();
        table.insert(
            TOKEN.to_owned(),
            registration(
                hash,
                "window.loreweaver = {};".to_owned(),
                ":root { --lw-ink: #fff; }".to_owned(),
            )
            .expect("valid"),
        );
        Mutex::new(table)
    }

    /// GET `path`; the cache holds [`PAGE`] under the hash `c…c` only.
    fn get(table: &Table, path: &str) -> http::Response<Vec<u8>> {
        let hash = "c".repeat(64);
        serve(table, &http::Method::GET, path, |asked| {
            (asked == hash).then(|| PAGE.as_bytes().to_vec())
        })
    }

    fn header<'a>(response: &'a http::Response<Vec<u8>>, name: &str) -> &'a str {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
    }

    #[test]
    fn the_csp_is_pinned() {
        assert_eq!(
            PAGE_CSP,
            "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; \
             style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; \
             media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; \
             worker-src 'none'; object-src 'none'; manifest-src 'none'; base-uri 'none'; \
             form-action 'none'"
        );
        // Nothing in it names a scheme that reaches out, or any host.
        for reach in ["http", "ws:", "wss:", "*", "'self'", "panel:", "localhost"] {
            assert!(
                !PAGE_CSP.contains(reach),
                "the page CSP must not allow {reach}"
            );
        }
    }

    #[test]
    fn the_registered_page_is_served_by_its_hash_with_the_page_headers() {
        // Registered in upper case: the hash is kept lower-case, as the cache names it.
        let table = table_with(&"C".repeat(64));
        let response = get(&table, &format!("/{TOKEN}/{ENTRY_PATH}"));
        assert_eq!(response.status(), 200);
        assert_eq!(header(&response, "Content-Security-Policy"), PAGE_CSP);
        assert_eq!(
            header(&response, "Content-Type"),
            "text/html; charset=utf-8"
        );
        assert_eq!(header(&response, "X-Content-Type-Options"), "nosniff");
        assert_eq!(header(&response, "Cache-Control"), "no-store");
        assert_eq!(header(&response, "Referrer-Policy"), "no-referrer");
        assert_eq!(header(&response, "X-DNS-Prefetch-Control"), "off");
        assert!(response
            .headers()
            .get("Access-Control-Allow-Origin")
            .is_none());
        let body = String::from_utf8(response.body().clone()).unwrap();
        assert!(body.contains("<body>hi</body>"));
    }

    #[test]
    fn the_bootstrap_and_theme_are_injected_before_the_authors_head() {
        let table = table_with(&"c".repeat(64));
        let body =
            String::from_utf8(get(&table, &format!("/{TOKEN}/{ENTRY_PATH}")).into_body()).unwrap();
        let theme = body
            .find("<style>:root { --lw-ink: #fff; }</style>")
            .expect("theme");
        let boot = body
            .find("<script>window.loreweaver = {};</script>")
            .expect("bootstrap");
        let author = body.find("author()").unwrap();
        assert!(
            body.starts_with("<!doctype html><html><head><style>"),
            "{body}"
        );
        assert!(theme < boot && boot < author, "{body}");
    }

    #[test]
    fn an_unregistered_token_another_path_or_a_missing_page_is_not_found() {
        let table = table_with(&"c".repeat(64));
        let other = "0123456789abcdef0123456789abcdef";
        assert_eq!(get(&table, &format!("/{other}/{ENTRY_PATH}")).status(), 404);
        for path in [
            format!("/{TOKEN}/index.html"),
            format!("/{TOKEN}/__loreweaver__/bootstrap.js"),
            format!("/{TOKEN}/{ENTRY_PATH}/x"),
            format!("/{TOKEN}/"),
            format!("/{TOKEN}"),
            format!("/{TOKEN}/%2e%2e"),
            "/favicon.ico".to_owned(),
        ] {
            let response = get(&table, &path);
            assert_eq!(response.status(), 404, "{path}");
            assert_eq!(header(&response, "Content-Security-Policy"), DENY_CSP);
            assert!(response.body().is_empty());
        }
        // Registered, but its bytes are not in the cache.
        let missing = table_with(&"d".repeat(64));
        assert_eq!(
            get(&missing, &format!("/{TOKEN}/{ENTRY_PATH}")).status(),
            404
        );
        // Only GET and HEAD.
        let post = serve(
            &table,
            &http::Method::POST,
            &format!("/{TOKEN}/{ENTRY_PATH}"),
            |_| Some(PAGE.as_bytes().to_vec()),
        );
        assert_eq!(post.status(), 405);
    }

    #[test]
    fn a_page_over_the_cap_or_not_utf8_is_refused() {
        let table = table_with(&"c".repeat(64));
        let path = format!("/{TOKEN}/{ENTRY_PATH}");
        let big = serve(&table, &http::Method::GET, &path, |_| {
            Some(vec![b'a'; MAX_PAGE_BYTES as usize + 1])
        });
        assert_eq!(big.status(), 413);
        let binary = serve(&table, &http::Method::GET, &path, |_| {
            Some(vec![0xff, 0xfe])
        });
        assert_eq!(binary.status(), 415);
    }

    #[test]
    fn a_registration_is_checked() {
        let ok = || "x".to_owned();
        let hash = "a".repeat(64);
        assert!(registration(&hash, ok(), ok()).is_ok());
        assert!(registration("not-a-hash", ok(), ok()).is_err());
        assert!(registration(&hash, "a</SCRIPT>b".to_owned(), ok()).is_err());
        assert!(registration(&hash, ok(), "a</style>".to_owned()).is_err());
        assert!(registration(&hash, "x".repeat(MAX_BOOTSTRAP_BYTES + 1), ok()).is_err());
        assert!(registration(&hash, ok(), "x".repeat(MAX_THEME_BYTES + 1)).is_err());
    }

    #[test]
    fn token_paths_split_into_a_token_and_one_file() {
        assert_eq!(
            split_token_path(&format!("/{TOKEN}/page.html")),
            Some((TOKEN.to_owned(), "page.html".to_owned()))
        );
        for bad in [
            "/SHORT/page.html".to_owned(),
            "/UPPERCASETOKEN00/page.html".to_owned(),
            format!("/{TOKEN}/a/b"),
            format!("/{TOKEN}/"),
            format!("/{TOKEN}"),
        ] {
            assert!(split_token_path(&bad).is_none(), "must reject {bad:?}");
        }
    }

    #[test]
    fn head_injection_lands_before_author_content() {
        let snippet = "<script>boot()</script>";
        let no_head = "<html lang=\"en\"><body><p>hi</p></body></html>";
        assert!(inject_head(no_head, snippet).starts_with("<html lang=\"en\"><script>boot()"));
        let doctype_only = "<!DOCTYPE html>\n<p>bare</p>";
        assert!(inject_head(doctype_only, snippet).starts_with("<!DOCTYPE html><script>"));
        assert!(inject_head("<p>frag</p>", snippet).starts_with(snippet));
        // `<header>` is not `<head>`.
        assert!(inject_head("<header>x</header>", snippet).starts_with(snippet));
    }

    /// The app's own CSP per platform: the frame may navigate to the page scheme
    /// as that platform's WebView maps it, and to nothing else.
    #[test]
    fn the_apps_frame_src_names_only_the_page_scheme_of_each_platform() {
        let csp = |json: &str| -> String {
            let value: serde_json::Value = serde_json::from_str(json).expect("config is JSON");
            value["app"]["security"]["csp"]
                .as_str()
                .expect("a csp")
                .to_owned()
        };
        let frame_src = |csp: &str| -> String {
            csp.split(';')
                .map(str::trim)
                .find(|directive| directive.starts_with("frame-src"))
                .expect("a frame-src")
                .to_owned()
        };
        for (config, expected) in [
            (include_str!("../tauri.macos.conf.json"), "frame-src panel:"),
            (include_str!("../tauri.linux.conf.json"), "frame-src panel:"),
            (
                include_str!("../tauri.windows.conf.json"),
                "frame-src http://panel.localhost",
            ),
        ] {
            assert_eq!(frame_src(&csp(config)), expected);
        }
        // The platform files change frame-src only.
        let base = csp(include_str!("../tauri.conf.json"));
        for config in [
            include_str!("../tauri.macos.conf.json"),
            include_str!("../tauri.linux.conf.json"),
            include_str!("../tauri.windows.conf.json"),
        ] {
            let strip = |csp: &str| {
                csp.split(';')
                    .map(str::trim)
                    .filter(|directive| !directive.starts_with("frame-src"))
                    .collect::<Vec<_>>()
                    .join("; ")
            };
            assert_eq!(strip(&csp(config)), strip(&base));
        }
    }

    #[test]
    fn tokens_are_lowercase_alnum_and_long() {
        assert!(valid_token("abcdef0123456789"));
        assert!(!valid_token("short"));
        assert!(!valid_token("ABCDEF0123456789"));
        assert!(!valid_token("abcdef012345678."));
        assert!(!valid_token(&"a".repeat(65)));
    }
}
