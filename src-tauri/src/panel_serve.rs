//! `panel://` — the locked-down static origin Tier-2 panel iframes load from.
//!
//! One registration per MOUNTED panel iframe, keyed by an unguessable token
//! the frontend mints: `panel://localhost/<token>/<path>` (Windows WebView2
//! maps the same thing to `http://panel.localhost/<token>/<path>`). The
//! handler serves exactly what the registration names — the entry document,
//! the host-injected bootstrap/theme, and the panel's declared assets — all
//! straight from the sha256-verified cache. Nothing else resolves, so a panel
//! can never browse the cache, the disk, or another panel's namespace (tokens
//! are secrets).
//!
//! Every response carries the panel CSP: `default-src 'none'` with only the
//! panel's own path prefix whitelisted for scripts/styles/images/fonts/media
//! and **no `connect-src`** — a panel holds room state, so the network is
//! structurally out of reach (spec M15, "Tier-2 runtime").

use std::collections::HashMap;
use std::sync::Mutex;

use percent_encoding::percent_decode_str;
use serde::Deserialize;
use tauri::http;
use tauri::{AppHandle, Runtime, State};

use crate::asset_cache;

/// The entry document's reserved serving name. The wire manifest gives the
/// entry a hash but no path (`assets[].path` are relative to its directory),
/// so the host picks a root-level name that a declared asset can never claim
/// (the `__` prefix is rejected at registration).
pub const ENTRY_PATH: &str = "__entry__.html";
pub const BOOTSTRAP_PATH: &str = "__loreweaver__/bootstrap.js";
pub const THEME_PATH: &str = "__loreweaver__/theme.css";

#[derive(Debug, Clone, Deserialize)]
pub struct RegisteredAsset {
    pub path: String,
    pub hash: String,
    pub mime: String,
}

#[derive(Debug)]
struct PanelRegistration {
    entry_hash: String,
    /// Relative path → (hash, mime), exactly as the viewer's manifest declared.
    assets: HashMap<String, (String, String)>,
    bootstrap_js: String,
    theme_css: String,
}

#[derive(Default)]
pub struct PanelServeState(Mutex<HashMap<String, PanelRegistration>>);

fn valid_token(token: &str) -> bool {
    (16..=64).contains(&token.len())
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'z'))
}

/// A declared asset path must stay inside the panel's static root: relative,
/// forward slashes, no dot-segments, and never inside the host's reserved
/// `__…` namespace.
fn validate_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.len() > 512 {
        return Err(format!("bad asset path length: {path:?}"));
    }
    if path.contains('\\') || path.contains('\0') {
        return Err(format!("bad asset path characters: {path:?}"));
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(format!("asset path escapes its root: {path:?}"));
        }
        if segment.starts_with("__") {
            return Err(format!("asset path uses the reserved namespace: {path:?}"));
        }
    }
    Ok(())
}

/// Mount one panel's static namespace. Called by the Tier-2 host right before
/// the iframe gets its `src`; replaced wholesale on re-register.
#[tauri::command]
pub fn panel_serve_register(
    state: State<'_, PanelServeState>,
    token: String,
    entry_hash: String,
    assets: Vec<RegisteredAsset>,
    bootstrap_js: String,
    theme_css: String,
) -> Result<(), String> {
    if !valid_token(&token) {
        return Err("bad serve token".to_owned());
    }
    let entry_hash = entry_hash.to_ascii_lowercase();
    if !asset_cache::is_sha256_hex(&entry_hash) {
        return Err(format!("bad entry hash: {entry_hash:?}"));
    }
    let mut table = HashMap::with_capacity(assets.len());
    for asset in assets {
        validate_rel_path(&asset.path)?;
        let hash = asset.hash.to_ascii_lowercase();
        if !asset_cache::is_sha256_hex(&hash) {
            return Err(format!("bad asset hash for {:?}", asset.path));
        }
        table.insert(asset.path, (hash, asset.mime));
    }
    let registration = PanelRegistration {
        entry_hash,
        assets: table,
        bootstrap_js,
        theme_css,
    };
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

/// Split a request path (`/<token>/<rel path>`, percent-encoded) into the
/// token and the decoded relative path. Rejects traversal at the segment
/// level so a decoded `%2F` can never smuggle a separator.
pub fn split_token_path(request_path: &str) -> Option<(String, String)> {
    let trimmed = request_path.strip_prefix('/').unwrap_or(request_path);
    let mut segments = trimmed.split('/');
    let token = segments.next()?.to_owned();
    if !valid_token(&token) {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for raw in segments {
        let decoded = percent_decode_str(raw).decode_utf8().ok()?.into_owned();
        if decoded.is_empty()
            || decoded == "."
            || decoded == ".."
            || decoded.contains('/')
            || decoded.contains('\\')
            || decoded.contains('\0')
        {
            return None;
        }
        parts.push(decoded);
    }
    if parts.is_empty() {
        return None;
    }
    Some((token, parts.join("/")))
}

/// The per-panel Content-Security-Policy (see module docs). `origin` is the
/// scheme+authority the webview used for this request, so the policy is
/// correct on every platform mapping of the custom scheme.
pub fn build_csp(origin: &str, token: &str) -> String {
    let own = format!("{origin}/{token}/");
    format!(
        "default-src 'none'; script-src {own}; style-src {own}; img-src {own}; \
         font-src {own}; media-src {own}; frame-src 'none'; object-src 'none'; \
         base-uri 'none'; form-action 'none'"
    )
}

/// Host-injected tags: theme first (custom properties ready before author
/// styles), then the bridge bootstrap as a classic script so it runs before
/// any author script. Relative URLs resolve against the entry document's
/// directory — the panel's own namespace root.
fn head_snippet() -> String {
    format!(
        "<link rel=\"stylesheet\" href=\"{THEME_PATH}\">\n<script src=\"{BOOTSTRAP_PATH}\"></script>\n"
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

enum Resolved {
    Entry { hash: String },
    Inline { body: Vec<u8>, mime: &'static str },
    Asset { hash: String, mime: String },
}

fn resolve(registration: &PanelRegistration, path: &str) -> Option<Resolved> {
    match path {
        ENTRY_PATH => Some(Resolved::Entry {
            hash: registration.entry_hash.clone(),
        }),
        BOOTSTRAP_PATH => Some(Resolved::Inline {
            body: registration.bootstrap_js.clone().into_bytes(),
            mime: "text/javascript",
        }),
        THEME_PATH => Some(Resolved::Inline {
            body: registration.theme_css.clone().into_bytes(),
            mime: "text/css",
        }),
        _ => registration
            .assets
            .get(path)
            .map(|(hash, mime)| Resolved::Asset {
                hash: hash.clone(),
                mime: mime.clone(),
            }),
    }
}

fn respond(status: u16, csp: &str, mime: &str, body: Vec<u8>) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header("Content-Security-Policy", csp)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        // The iframe origin is opaque, which makes every CORS-mode subresource
        // load (module scripts, fonts) cross-origin. Only this webview can
        // reach the scheme at all, and each document's CSP pins what it may
        // load — so a wildcard here widens nothing.
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .expect("static response headers are valid")
}

pub fn handle_panel_request<R: Runtime>(
    app: &AppHandle<R>,
    request: &http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let uri = request.uri();
    let origin = match (uri.scheme_str(), uri.authority()) {
        (Some(scheme), Some(authority)) => format!("{scheme}://{authority}"),
        _ => "panel://localhost".to_owned(),
    };
    let deny = |status: u16| respond(status, "default-src 'none'", "text/plain", Vec::new());

    if request.method() != http::Method::GET && request.method() != http::Method::HEAD {
        return deny(405);
    }
    let Some((token, path)) = split_token_path(uri.path()) else {
        return deny(404);
    };
    let csp = build_csp(&origin, &token);

    // Resolve under the lock, read cache files after it drops.
    let resolved = {
        use tauri::Manager;
        let state = app.state::<PanelServeState>();
        let table = match state.0.lock() {
            Ok(table) => table,
            Err(_) => return deny(500),
        };
        let Some(registration) = table.get(&token) else {
            return deny(404);
        };
        match resolve(registration, &path) {
            Some(resolved) => resolved,
            None => return deny(404),
        }
    };
    match resolved {
        Resolved::Inline { body, mime } => respond(200, &csp, mime, body),
        Resolved::Entry { hash } => match read_cached(app, &hash) {
            Some(bytes) => {
                let html = String::from_utf8_lossy(&bytes);
                let injected = inject_head(&html, &head_snippet());
                respond(200, &csp, "text/html; charset=utf-8", injected.into_bytes())
            }
            None => deny(404),
        },
        Resolved::Asset { hash, mime } => match read_cached(app, &hash) {
            Some(bytes) => respond(200, &csp, &mime, bytes),
            None => deny(404),
        },
    }
}

fn read_cached<R: Runtime>(app: &AppHandle<R>, hash: &str) -> Option<Vec<u8>> {
    let dir = asset_cache::cache_dir(app).ok()?;
    let path = asset_cache::lookup(&dir, hash)?;
    std::fs::read(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration() -> PanelRegistration {
        let mut assets = HashMap::new();
        assets.insert(
            "app.js".to_owned(),
            ("a".repeat(64), "text/javascript".to_owned()),
        );
        assets.insert(
            "img/地图.webp".to_owned(),
            ("b".repeat(64), "image/webp".to_owned()),
        );
        PanelRegistration {
            entry_hash: "c".repeat(64),
            assets,
            bootstrap_js: "// boot".to_owned(),
            theme_css: ":root{}".to_owned(),
        }
    }

    #[test]
    fn token_paths_split_and_decode() {
        let (token, path) = split_token_path("/abcdef0123456789/app.js").expect("valid");
        assert_eq!(token, "abcdef0123456789");
        assert_eq!(path, "app.js");
        let (_, nested) = split_token_path("/abcdef0123456789/img/map.webp").expect("valid");
        assert_eq!(nested, "img/map.webp");
        let (_, cjk) =
            split_token_path("/abcdef0123456789/img/%E5%9C%B0%E5%9B%BE.webp").expect("valid");
        assert_eq!(cjk, "img/地图.webp");
    }

    #[test]
    fn token_paths_reject_traversal_and_junk() {
        for bad in [
            "/abcdef0123456789/../etc/passwd",
            "/abcdef0123456789/%2e%2e/secret",
            "/abcdef0123456789/a%2Fb/c",
            "/abcdef0123456789//double",
            "/abcdef0123456789/",
            "/abcdef0123456789",
            "/SHORT/app.js",
            "/UPPERCASETOKEN00/app.js",
            "/abcdef0123456789/back\\slash",
        ] {
            assert!(split_token_path(bad).is_none(), "must reject {bad:?}");
        }
    }

    #[test]
    fn resolve_serves_only_the_registered_namespace() {
        let reg = registration();
        assert!(matches!(
            resolve(&reg, ENTRY_PATH),
            Some(Resolved::Entry { .. })
        ));
        assert!(matches!(
            resolve(&reg, BOOTSTRAP_PATH),
            Some(Resolved::Inline { .. })
        ));
        assert!(matches!(
            resolve(&reg, THEME_PATH),
            Some(Resolved::Inline { .. })
        ));
        assert!(matches!(
            resolve(&reg, "app.js"),
            Some(Resolved::Asset { .. })
        ));
        assert!(matches!(
            resolve(&reg, "img/地图.webp"),
            Some(Resolved::Asset { .. })
        ));
        assert!(resolve(&reg, "missing.js").is_none());
        assert!(resolve(&reg, "__loreweaver__/other.js").is_none());
    }

    #[test]
    fn csp_is_default_none_with_no_connect_src() {
        let csp = build_csp("panel://localhost", "abcdef0123456789");
        assert!(csp.starts_with("default-src 'none'"));
        assert!(csp.contains("script-src panel://localhost/abcdef0123456789/"));
        assert!(csp.contains("style-src panel://localhost/abcdef0123456789/"));
        assert!(csp.contains("img-src panel://localhost/abcdef0123456789/"));
        assert!(csp.contains("font-src panel://localhost/abcdef0123456789/"));
        assert!(csp.contains("media-src panel://localhost/abcdef0123456789/"));
        assert!(csp.contains("frame-src 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(csp.contains("base-uri 'none'"));
        assert!(csp.contains("form-action 'none'"));
        assert!(
            !csp.contains("connect-src"),
            "panels must have no network at all"
        );
        assert!(!csp.contains("unsafe-inline"));
    }

    #[test]
    fn head_injection_lands_before_author_content() {
        let snippet = "<script src=\"__loreweaver__/bootstrap.js\"></script>";
        let with_head = "<!doctype html><html><head><script src=\"app.js\"></script></head><body></body></html>";
        let injected = inject_head(with_head, snippet);
        let boot = injected.find("__loreweaver__/bootstrap.js").unwrap();
        let author = injected.find("app.js").unwrap();
        assert!(boot < author, "bootstrap must run before author scripts");

        let no_head = "<html lang=\"en\"><body><p>hi</p></body></html>";
        let injected = inject_head(no_head, snippet);
        assert!(injected.starts_with("<html lang=\"en\">"));
        assert!(injected.contains("<html lang=\"en\"><script"));

        let doctype_only = "<!DOCTYPE html>\n<p>bare</p>";
        let injected = inject_head(doctype_only, snippet);
        assert!(injected.starts_with("<!DOCTYPE html>"));
        let boot = injected.find(snippet).unwrap();
        assert!(boot < injected.find("<p>bare</p>").unwrap());

        let fragment = "<p>frag</p>";
        assert!(inject_head(fragment, snippet).starts_with(snippet));

        // `<header>` is not `<head>`.
        let header_only = "<header>x</header>";
        let injected = inject_head(header_only, snippet);
        assert!(injected.starts_with(snippet));
    }

    #[test]
    fn rel_path_validation_guards_the_namespace() {
        assert!(validate_rel_path("app.js").is_ok());
        assert!(validate_rel_path("img/map.webp").is_ok());
        assert!(validate_rel_path("字体/文泉驿.woff2").is_ok());
        for bad in [
            "",
            "/abs.js",
            "a//b.js",
            "../up.js",
            "a/../b.js",
            "./same.js",
            "back\\slash.js",
            "__entry__.html",
            "__loreweaver__/bootstrap.js",
            "sub/__shadow__/x.js",
        ] {
            assert!(validate_rel_path(bad).is_err(), "must reject {bad:?}");
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
