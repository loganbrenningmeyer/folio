//! Serves HTML pages to the reading view over Folio's own `folio-page` scheme.
//!
//! An HTML page is shown in a frame rather than rendered into the app, and it
//! needs a document origin of its own for two reasons. The app's content
//! security policy forbids inline scripts, and a frame built from `srcdoc`
//! inherits that policy, so interactive pages would draw nothing. And a page
//! loaded from a real URL resolves its relative references (`figs/plot.png`,
//! `style.css`) against its own folder, the way a browser would.
//!
//! The renderer frames these URLs with `sandbox="allow-scripts"` and without
//! `allow-same-origin`, so a page runs in an opaque origin: it cannot reach
//! the app's DOM, storage, or cookies. The policy sent with every page also
//! leaves the IPC endpoints out of `connect-src`, so its scripts cannot talk
//! to the backend either. A small bridge script, added to each HTML response,
//! talks to the app by `postMessage` instead: it reports and sets the page's
//! scroll position and hands link clicks and app shortcuts back to Folio.

use std::{
    borrow::Cow,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Manager, State,
};

use crate::{
    resolve_existing_file, validate_relative_path, LibraryState, PathKind,
};

pub const PAGE_SCHEME: &str = "folio-page";

/// The origins a framed page loads from. WebView2 (Windows) serves custom
/// schemes as `http://<scheme>.localhost`; WebKit (macOS) uses the scheme.
const PAGE_ORIGINS: &str = "http://folio-page.localhost folio-page://localhost";

/// The content of the HTML page open in the editor, which may be ahead of
/// what autosave has written. One page at a time: only the open one is framed.
#[derive(Default)]
pub struct PagePreviewState {
    staged: Mutex<Option<(String, String)>>,
}

/// Records the open HTML page's current text, so the frame shows unsaved
/// edits in Split view rather than waiting for autosave.
#[tauri::command]
pub async fn stage_page_preview(
    path: String,
    content: String,
    state: State<'_, PagePreviewState>,
) -> Result<(), String> {
    let relative = validate_relative_path(&path, PathKind::MarkdownFile)?;
    if !has_html_extension(&relative) {
        return Err("Only HTML pages are shown in a frame.".to_string());
    }
    *state
        .staged
        .lock()
        .map_err(|_| "Folio's page preview is unavailable.".to_string())? = Some((path, content));
    Ok(())
}

/// Handles one `folio-page` request: a file inside the open library.
pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    match load(app, request.uri().path()) {
        Ok((body, content_type, html)) => {
            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header(header::CACHE_CONTROL, "no-store")
                // A sandboxed page has an opaque origin, so its own fetches of
                // sibling files are cross-origin requests.
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
            if html {
                response = response.header("Content-Security-Policy", page_policy());
            }
            response
                .body(Cow::Owned(body))
                .unwrap_or_else(|_| not_found())
        }
        Err(_) => not_found(),
    }
}

fn not_found() -> Response<Cow<'static, [u8]>> {
    let mut response = Response::new(Cow::Borrowed(&b"Not found"[..]));
    *response.status_mut() = StatusCode::NOT_FOUND;
    response
}

/// What a framed page may load and run. Scripts, styles, fonts, and media
/// from the library or the web are allowed — pages commonly pull a charting
/// library or web fonts from a CDN — but `connect-src` names no IPC endpoint.
fn page_policy() -> String {
    format!(
        "default-src 'none'; \
         script-src 'unsafe-inline' 'unsafe-eval' {PAGE_ORIGINS} https:; \
         style-src 'unsafe-inline' {PAGE_ORIGINS} https:; \
         img-src {PAGE_ORIGINS} data: blob: https:; \
         font-src {PAGE_ORIGINS} data: https:; \
         media-src {PAGE_ORIGINS} data: blob: https:; \
         connect-src {PAGE_ORIGINS} https:; \
         worker-src blob: {PAGE_ORIGINS}; \
         frame-src 'none'; \
         form-action 'none'"
    )
}

/// Reads the requested file: the staged text for the open HTML page, or the
/// file on disk. Returns the body, its content type, and whether it is HTML.
fn load(app: &AppHandle, uri_path: &str) -> Result<(Vec<u8>, &'static str, bool), String> {
    let root = app
        .state::<LibraryState>()
        .get()?
        .ok_or_else(|| "No library is open.".to_string())?;
    let path = percent_decode(uri_path.trim_start_matches('/'))?;
    let relative = request_relative_path(&path)?;
    let html = has_html_extension(&relative);

    let staged = if html {
        app.state::<PagePreviewState>()
            .staged
            .lock()
            .ok()
            .and_then(|staged| staged.clone())
            .filter(|(staged_path, _)| *staged_path == path)
            .map(|(_, content)| content)
    } else {
        None
    };
    let body = match staged {
        Some(content) => content.into_bytes(),
        None => {
            let file = resolve_existing_file(&root, &relative)?;
            fs::read(&file).map_err(|error| error.to_string())?
        }
    };

    if html {
        Ok((with_bridge(&body), "text/html; charset=utf-8", true))
    } else {
        Ok((body, content_type(&relative), false))
    }
}

/// A library-relative path from a request, refusing anything inside a dot
/// entry: `.git` and `.folio` hold machinery, not page resources.
fn request_relative_path(path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(path, PathKind::Folder)?;
    let hidden = relative.components().any(|component| {
        matches!(component, Component::Normal(segment)
            if segment.to_string_lossy().starts_with('.'))
    });
    if hidden {
        return Err("Hidden entries are not served.".to_string());
    }
    Ok(relative)
}

pub fn has_html_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "md" | "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Percent-decodes a URL path into UTF-8 text.
fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok())
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| "Malformed escape in a page URL.".to_string())?;
            decoded.push(hex);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "A page URL was not UTF-8.".to_string())
}

/// The bridge between a framed page and the app. Kept to `postMessage`: the
/// sandbox gives the page no other way out, which is the point.
///
/// The frame fills the reading pane and the page scrolls itself, as it would
/// in a browser, so its fixed and sticky elements stay on screen. The bridge
/// reports where the page is scrolled (`scrolled`, with `moved` set only when
/// the position changed, so a load or resize is not taken for the reader
/// scrolling) and scrolls it when Folio asks (`scrollTo`), which Split view's
/// scroll lock and the restore after a reload use. In-page `#` links scroll
/// the page here; other links are handed to Folio.
const BRIDGE_SCRIPT: &str = r##"<script>(function(){
var post=function(message){message.folio=1;try{parent.postMessage(message,"*");}catch(e){}};
var root=document.documentElement,lastTop=0;
function scroller(){return document.scrollingElement||root;}
function report(){var s=scroller(),top=s.scrollTop,max=Math.max(0,s.scrollHeight-s.clientHeight);
var moved=Math.abs(top-lastTop)>=1;lastTop=top;post({type:"scrolled",top:top,max:max,moved:moved});}
function observe(){try{var ro=new ResizeObserver(report);ro.observe(root);if(document.body)ro.observe(document.body);}catch(e){}report();}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",observe);else observe();
addEventListener("load",report);addEventListener("scroll",report,{passive:true});
addEventListener("message",function(event){if(event.source!==parent||!event.data||event.data.folio!==1)return;
var data=event.data;if(data.type==="theme")root.setAttribute("data-theme",data.value);
else if(data.type==="scrollTo"&&isFinite(data.top))scrollTo({top:data.top,behavior:"instant"});});
addEventListener("click",function(event){if(event.defaultPrevented||event.button!==0)return;
var anchor=event.target&&event.target.closest?event.target.closest("a[href]"):null;if(!anchor)return;
var href=anchor.getAttribute("href")||"";event.preventDefault();
if(href.charAt(0)==="#"){var id=decodeURIComponent(href.slice(1));var target=id?(document.getElementById(id)||document.getElementsByName(id)[0]):null;
if(target)target.scrollIntoView({block:"start"});else scrollTo({top:0});return;}
post({type:"link",href:href});});
addEventListener("keydown",function(event){if(!(event.ctrlKey||event.metaKey||event.key==="Escape"))return;
if((event.metaKey||event.ctrlKey)&&!event.shiftKey&&!event.altKey&&event.key.toLowerCase()==="f")event.preventDefault();
post({type:"key",key:event.key,code:event.code,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey,altKey:event.altKey});});
})();</script>"##;

/// Inserts the bridge right after the doctype, or at the very start when the
/// page has none. After the doctype rather than before it, which would drop
/// the page into quirks mode; before the page's own head content, so the
/// bridge is listening before any page script runs.
fn with_bridge(body: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(body);
    let insert_at = doctype_end(&text).unwrap_or(0);
    let mut output = String::with_capacity(text.len() + BRIDGE_SCRIPT.len());
    output.push_str(&text[..insert_at]);
    output.push_str(BRIDGE_SCRIPT);
    output.push_str(r#"<script type="module">"#);
    output.push_str(include_str!("../../app/reader-matches.js"));
    output.push_str(r#"
addEventListener("message", event => {
  const data = event.data;
  if (event.source !== parent || data?.folio !== 1 || data.type !== "find" ||
      typeof data.query !== "string" || !Number.isSafeInteger(data.index)) return;
  const result = findReaderMatch(document.body, data.query, data.index);
  parent.postMessage({ folio: 1, type: "findResult", query: data.query, index: data.index, ...result }, "*");
});
</script>"#);
    output.push_str(&text[insert_at..]);
    output.into_bytes()
}

/// The byte offset just past a leading `<!doctype …>`, ignoring a BOM and
/// leading whitespace.
fn doctype_end(text: &str) -> Option<usize> {
    let start = text.len() - text.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']).len();
    let rest = &text[start..];
    let opener = rest.get(..9)?;
    if !opener.eq_ignore_ascii_case("<!doctype") {
        return None;
    }
    rest.find('>').map(|end| start + end + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_page_urls() {
        assert_eq!(
            percent_decode("Rivet/Heading%20and%203DoF/Calibration%20Quality%20Verdict.html")
                .unwrap(),
            "Rivet/Heading and 3DoF/Calibration Quality Verdict.html"
        );
        assert_eq!(percent_decode("caf%C3%A9.html").unwrap(), "café.html");
        assert!(percent_decode("bad%2").is_err());
        assert!(percent_decode("bad%zz").is_err());
    }

    #[test]
    fn refuses_paths_outside_or_hidden() {
        assert!(request_relative_path("notes/figs/plot.png").is_ok());
        assert!(request_relative_path("../secret.html").is_err());
        assert!(request_relative_path("notes/../../x.html").is_err());
        assert!(request_relative_path(".git/config").is_err());
        assert!(request_relative_path("notes/.folio/order.json").is_err());
        assert!(request_relative_path("/etc/passwd").is_err());
    }

    #[test]
    fn inserts_the_bridge_after_the_doctype() {
        let page = with_bridge(b"<!doctype html><html><body>hi</body></html>");
        let page = String::from_utf8(page).unwrap();
        assert!(page.starts_with("<!doctype html><script>"));
        assert!(page.ends_with("<html><body>hi</body></html>"));

        let bare = String::from_utf8(with_bridge(b"<p>hi</p>")).unwrap();
        assert!(bare.starts_with("<script>"));
        assert!(bare.ends_with("<p>hi</p>"));

        let padded = String::from_utf8(with_bridge(b"\n  <!DOCTYPE html>\n<p>x</p>")).unwrap();
        assert!(padded.starts_with("\n  <!DOCTYPE html><script>"));
    }

    #[test]
    fn the_page_policy_never_names_ipc() {
        let policy = page_policy();
        assert!(!policy.contains("ipc"));
        assert!(policy.contains("script-src 'unsafe-inline'"));
    }
}
