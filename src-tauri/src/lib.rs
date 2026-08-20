mod sync;

use base64::Engine as _;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs::{self, File, OpenOptions, Permissions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering},
        mpsc, LazyLock, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

const PREFERENCES_FILE: &str = "library.json";
/// Folio's own bookkeeping inside a library, kept in a dot folder so it stays
/// out of the way of the Markdown it describes. See `app/library-order.js`.
const LIBRARY_DIRECTORY: &str = ".folio";
const ORDER_FILE: &str = "order.json";
/// How the library's folders should be drawn. See `app/folder-icons.js`.
const ICONS_FILE: &str = "icons.json";
/// A folder mark is a 24px drawing, and the renderer scales a picture down to
/// icon size before storing it, so the file handed over is only ever a source.
/// The cap keeps a photo library's worth of pixels from crossing the bridge.
const MAX_ICON_SOURCE_BYTES: u64 = 24 * 1024 * 1024;
const MAIN_WINDOW: &str = "main";
/// How long Folio waits for the frontend to report a painted first frame
/// before showing its window anyway. Long enough for a large library to be
/// read from disk, short enough that a broken frontend is not a hang.
const WINDOW_REVEAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
/// Set once the frontend has finished its closing ritual — the quit prompt
/// answered, or nothing worth asking about — after which close and exit
/// requests pass instead of being turned into a "close-requested" event.
static CLOSE_APPROVED: AtomicBool = AtomicBool::new(false);

/// How long one of Folio's own writes stays recognisable to the library
/// watcher. Long enough to cover the lag between a write and the filesystem
/// reporting it, short enough that a sync overwriting the same file moments
/// later still reads as the external change it is.
const SELF_WRITE_TTL: Duration = Duration::from_secs(5);
/// Quiet time before a burst of filesystem events becomes one refresh: a sync
/// landing twenty pages should read as one change, not twenty.
const WATCH_DEBOUNCE: Duration = Duration::from_millis(600);
/// The longest a continuous stream of events may hold the refresh back, so a
/// large sync starts appearing while it is still arriving.
const WATCH_DEBOUNCE_CAP: Duration = Duration::from_secs(2);

/// Paths Folio itself wrote just now, so the watcher can tell its own saves
/// from changes arriving from outside. Recorded where the writes happen — a
/// static, because the write helpers are plain functions shared with tests.
static RECENT_SELF_WRITES: LazyLock<Mutex<HashMap<PathBuf, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    id: String,
    path: String,
    title: String,
    content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    name: String,
    notes: Vec<NoteRecord>,
    folders: Vec<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    library_root: Option<PathBuf>,
    /// The page open when Folio last closed, relative to `library_root`, so a
    /// library reopens where its reader left off. Absent until a page has been
    /// opened, and ignored when it no longer names a page in the library.
    #[serde(default)]
    open_note: Option<String>,
    /// The access token for an https sync remote. It lives here, outside the
    /// library, so it can never be committed and synced along with the pages.
    /// Plain text, like the git credential files it stands in for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sync_token: Option<String>,
}

/// A library reopened from Folio's settings, with the page to open in it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredLibrary {
    snapshot: LibrarySnapshot,
    open_note: Option<String>,
}

#[derive(Default)]
struct LibraryState {
    root: Mutex<Option<PathBuf>>,
    operations: Mutex<()>,
}

impl LibraryState {
    fn get(&self) -> Result<Option<PathBuf>, String> {
        self.root
            .lock()
            .map(|root| root.clone())
            .map_err(|_| "Folio's library state is unavailable.".to_string())
    }

    fn set(&self, root: Option<PathBuf>) -> Result<(), String> {
        *self
            .root
            .lock()
            .map_err(|_| "Folio's library state is unavailable.".to_string())? = root;
        Ok(())
    }

    fn lock_operation(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.operations
            .lock()
            .map_err(|_| "Folio's filesystem operation queue is unavailable.".to_string())
    }
}

#[tauri::command]
async fn restore_library(
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<Option<RestoredLibrary>, String> {
    let _operation = state.lock_operation()?;
    let preferences = load_preferences(&app)?;
    let Some(stored_root) = preferences.library_root else {
        state.set(None)?;
        watch_library(&app, None);
        return Ok(None);
    };

    let root = canonical_library_root(&stored_root)?;
    let snapshot = scan_library_root(&root)?;
    watch_library(&app, Some(&root));
    state.set(Some(root))?;

    // A page renamed, moved, or deleted outside Folio is no longer somewhere to
    // reopen at, so the library simply comes back at its first page.
    let open_note = preferences
        .open_note
        .filter(|path| snapshot.notes.iter().any(|note| note.path == *path));
    Ok(Some(RestoredLibrary {
        snapshot,
        open_note,
    }))
}

/// Puts Folio's window on screen. The window is created hidden so its first
/// frame is the reader's own theme and library rather than a white flash of the
/// starting state; the frontend calls this once that frame has been painted.
#[tauri::command]
async fn show_window(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    // A window that cannot be shown is not something a reader can act on, and
    // the alternative — reporting it into a window they cannot see — is worse.
    let _ = window.show();
    let _ = window.set_focus();
}

/// Records the page to reopen this library at. `path` is a page's library
/// path, or null to forget one. A path that no longer exists is kept rather
/// than rejected: the page may be on its way back from a rename, and
/// `restore_library` checks it against the library anyway.
#[tauri::command]
async fn remember_open_note(
    app: AppHandle,
    path: Option<String>,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    let _operation = state.lock_operation()?;
    let path = match path {
        Some(path) => Some(relative_path_to_string(&validate_relative_path(
            &path,
            PathKind::MarkdownFile,
        )?)?),
        None => None,
    };
    save_open_note(&app, path)
}

#[tauri::command]
async fn choose_library(
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<Option<LibrarySnapshot>, String> {
    // This command must stay async: the plugin's blocking picker deadlocks the
    // macOS event loop when invoked by a synchronous main-thread command.
    let Some(selection) = app
        .dialog()
        .file()
        .set_title("Choose a Markdown library")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };

    let selected_path = selection
        .into_path()
        .map_err(|_| "The selected folder is not available as a local path.".to_string())?;
    let _operation = state.lock_operation()?;
    let root = canonical_library_root(&selected_path)?;
    let snapshot = scan_library_root(&root)?;

    // Persist only after a complete scan succeeds, so a cancelled or unreadable
    // selection cannot replace the last working library.
    save_preferences(&app, Some(&root))?;
    watch_library(&app, Some(&root));
    state.set(Some(root))?;
    Ok(Some(snapshot))
}

#[tauri::command]
async fn scan_library(state: State<'_, LibraryState>) -> Result<Option<LibrarySnapshot>, String> {
    let _operation = state.lock_operation()?;
    let Some(root) = state.get()? else {
        return Ok(None);
    };
    Ok(Some(scan_library_root(&root)?))
}

/// Entry budget for a folder Folio decides to open by itself. Following a link
/// out of the library reopens it at the folder holding both pages, and that
/// shared folder is only a library if it is small enough to read — a home
/// folder is not. Counting stops as soon as the budget is spent, so a huge tree
/// costs no more than a glance.
const LINKED_LIBRARY_ENTRY_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedNote {
    snapshot: LibrarySnapshot,
    path: String,
    rerooted: bool,
}

/// Follows a Markdown link to a page that may sit outside the open library.
///
/// `href` is resolved against the folder of the page that holds it, `..`
/// included, so a link may point above the library root. When it does, Folio
/// reopens the library at the nearest folder containing both pages — or at the
/// linked page's own folder when the two only meet somewhere unreadably large —
/// and the returned snapshot replaces the open one. `Ok(None)` means the link
/// names no existing Markdown file, which the reading view reports as "not
/// found" rather than as a failure.
#[tauri::command]
async fn open_linked_note(
    app: AppHandle,
    note_path: String,
    href: String,
    state: State<'_, LibraryState>,
) -> Result<Option<LinkedNote>, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let Some((new_root, linked)) = follow_link_in_library(&root, &note_path, &href)? else {
        return Ok(None);
    };

    if linked.rerooted {
        // Persist only after the scan succeeds, matching choose_library: a
        // folder Folio could not read must not replace the working library.
        save_preferences(&app, Some(&new_root))?;
        watch_library(&app, Some(&new_root));
        state.set(Some(new_root))?;
    }
    Ok(Some(linked))
}

/// The filesystem half of `open_linked_note`, split out so it can be tested
/// against a real directory without a Tauri state handle. Returns the folder
/// the library should now be rooted at along with the snapshot of it.
fn follow_link_in_library(
    root: &Path,
    note_path: &str,
    href: &str,
) -> Result<Option<(PathBuf, LinkedNote)>, String> {
    let note_relative = validate_relative_path(note_path, PathKind::MarkdownFile)?;
    let note_directory = resolve_existing_directory(
        root,
        note_relative.parent().unwrap_or_else(|| Path::new("")),
    )?;

    let Some(target) = resolve_link_target(root, &note_directory, href) else {
        return Ok(None);
    };
    let target_directory = target.parent().unwrap_or(root).to_path_buf();

    // A link that stays inside the open library only needs a fresh scan: the
    // file may have appeared since the last one. Re-rooting on it would shrink
    // the library to a subfolder, which is never what a link click asked for.
    let new_root = if target.starts_with(root) {
        root.to_path_buf()
    } else {
        linked_library_root(&note_directory, &target_directory)
    };

    let snapshot = scan_library_root(&new_root)?;
    let relative = target
        .strip_prefix(&new_root)
        .map_err(|_| "The linked page is outside the folder Folio opened.".to_string())?;
    let relative = relative_path_to_string(relative)?;
    // A case-insensitive volume opens a differently spelled link happily, but
    // the reading view can only select the page under its scanned name.
    let path = snapshot
        .notes
        .iter()
        .find(|note| note.path == relative)
        .or_else(|| {
            snapshot
                .notes
                .iter()
                .find(|note| note.path.eq_ignore_ascii_case(&relative))
        })
        .map(|note| note.path.clone())
        .unwrap_or(relative);

    let rerooted = new_root != root;
    Ok(Some((
        new_root,
        LinkedNote {
            snapshot,
            path,
            rerooted,
        },
    )))
}

/// Resolves a Markdown link to an existing `.md` file. The href is joined onto
/// the linking page's folder lexically — `..` may leave the library — and the
/// result must be a real file reached without crossing a symbolic link.
fn resolve_link_target(root: &Path, note_directory: &Path, href: &str) -> Option<PathBuf> {
    let href = href.trim();
    if href.is_empty() || href.contains('\0') || href.chars().any(char::is_control) {
        return None;
    }

    let href = href.replace('\\', "/");
    let destination = href.split(['#', '?']).next()?;
    let (base, destination) = match destination.strip_prefix('/') {
        // A leading slash reads as "from the library root", the same way the
        // reading view resolves it.
        Some(rest) => (root, rest),
        None => (note_directory, destination),
    };

    let mut resolved = base.to_path_buf();
    for segment in destination.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if !resolved.pop() {
                    return None;
                }
            }
            segment => resolved.push(segment),
        }
    }
    if !has_markdown_extension(&resolved) {
        return None;
    }

    // The library root, and so every folder above and inside it that Folio
    // resolved, is canonical. An unchanged path therefore proves the link
    // crossed no symbolic link on its way here.
    let canonical = canonical_path(&resolved).ok()?;
    if canonical != resolved || !fs::metadata(&canonical).ok()?.is_file() {
        return None;
    }
    Some(canonical)
}

/// The folder Folio opens to show both ends of a link: the deepest folder that
/// holds them both, or the linked page's own folder when the two share nothing
/// but the filesystem root, or share a folder too large to read as a library.
fn linked_library_root(note_directory: &Path, target_directory: &Path) -> PathBuf {
    shared_parent(note_directory, target_directory)
        .filter(|shared| within_entry_budget(shared, LINKED_LIBRARY_ENTRY_LIMIT))
        .unwrap_or_else(|| target_directory.to_path_buf())
}

/// The deepest folder containing both paths, or None when they meet only at the
/// filesystem root (or, on Windows, not at all).
fn shared_parent(left: &Path, right: &Path) -> Option<PathBuf> {
    let mut shared = PathBuf::new();
    let mut named_segments = 0;
    for (left_component, right_component) in left.components().zip(right.components()) {
        if left_component != right_component {
            break;
        }
        if matches!(left_component, Component::Normal(_)) {
            named_segments += 1;
        }
        shared.push(left_component);
    }
    (named_segments > 0).then_some(shared)
}

/// Whether `directory` holds at most `budget` entries. Symbolic links are not
/// followed, matching the library scan, and an unreadable folder counts as over
/// budget because scanning it would fail anyway.
fn within_entry_budget(directory: &Path, budget: usize) -> bool {
    let mut remaining = budget;
    let mut pending = vec![directory.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            return false;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return false;
            };
            if remaining == 0 {
                return false;
            }
            remaining -= 1;
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                pending.push(entry.path());
            }
        }
    }
    true
}

#[tauri::command]
async fn create_folder(
    path: String,
    state: State<'_, LibraryState>,
) -> Result<LibrarySnapshot, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let relative = validate_relative_path(&path, PathKind::Folder)?;
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let parent_directory = resolve_existing_directory(&root, parent)?;
    let destination = parent_directory.join(
        relative
            .file_name()
            .ok_or_else(|| "A folder name is required.".to_string())?,
    );

    ensure_destination_absent(&destination)?;
    note_self_write(&destination);
    fs::create_dir(&destination)
        .map_err(|error| io_error("create the folder", &destination, error))?;

    scan_library_root(&root)
}

#[tauri::command]
async fn create_note(
    path: String,
    content: String,
    state: State<'_, LibraryState>,
) -> Result<LibrarySnapshot, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let relative = validate_relative_path(&path, PathKind::MarkdownFile)?;
    let parent = relative.parent().unwrap_or_else(|| Path::new(""));
    let parent_directory = resolve_existing_directory(&root, parent)?;
    let destination = parent_directory.join(
        relative
            .file_name()
            .ok_or_else(|| "A Markdown file name is required.".to_string())?,
    );

    ensure_destination_absent(&destination)?;
    atomic_write(&destination, content.as_bytes(), None, false)
        .map_err(|error| io_error("create the Markdown file", &destination, error))?;

    scan_library_root(&root)
}

/// Reads the page order a library records for itself. A library that has never
/// been reordered has no file, which is not an error — it simply reads
/// alphabetically. The contents are handed to the frontend as they are: the
/// order's shape belongs to `app/library-order.js`, which is shared with the
/// browser build.
#[tauri::command]
async fn read_library_order(state: State<'_, LibraryState>) -> Result<Option<String>, String> {
    let _operation = state.lock_operation()?;
    let Some(root) = state.get()? else {
        return Ok(None);
    };
    read_order_file(&root)
}

#[tauri::command]
async fn write_library_order(
    contents: String,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    write_order_file(&root, &contents)
}

#[tauri::command]
async fn read_library_icons(state: State<'_, LibraryState>) -> Result<Option<String>, String> {
    let _operation = state.lock_operation()?;
    let Some(root) = state.get()? else {
        return Ok(None);
    };
    read_library_file(&root, ICONS_FILE, "read the folder icons")
}

#[tauri::command]
async fn write_library_icons(
    contents: String,
    state: State<'_, LibraryState>,
) -> Result<(), String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    write_library_file(&root, ICONS_FILE, &contents, "save the folder icons")
}

/// A picture for a folder's mark, as a data URI. The library root is not
/// consulted: a folder can be given a look before its library is one Folio
/// can write to, and nothing is stored here in any case.
#[tauri::command]
async fn pick_icon_image(app: AppHandle) -> Result<Option<String>, String> {
    // Like choose_library, the blocking picker must run on an async command.
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Choose a folder icon")
        .add_filter("Images", &ICON_IMAGE_EXTENSIONS)
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| "That picture is not available as a local file.".to_string())?;
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let Some(mime) = icon_image_mime(&extension) else {
        return Err(
            "Folio can use a PNG, JPEG, GIF, or WebP picture as a folder icon.".to_string(),
        );
    };
    let size = fs::metadata(&path)
        .map_err(|error| io_error("read the selected picture", &path, error))?
        .len();
    if size > MAX_ICON_SOURCE_BYTES {
        return Err(format!(
            "That picture is {} MB. Choose one under {} MB.",
            size / (1024 * 1024),
            MAX_ICON_SOURCE_BYTES / (1024 * 1024)
        ));
    }
    let bytes =
        fs::read(&path).map_err(|error| io_error("read the selected picture", &path, error))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(format!("data:{mime};base64,{encoded}")))
}

/// The picture formats a webview can draw into a canvas to scale down. SVG is
/// left out on purpose: it is a document, and one that can carry script.
const ICON_IMAGE_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

fn icon_image_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

fn read_order_file(root: &Path) -> Result<Option<String>, String> {
    read_library_file(root, ORDER_FILE, "read the page order")
}

fn write_order_file(root: &Path, contents: &str) -> Result<(), String> {
    write_library_file(root, ORDER_FILE, contents, "save the page order")
}

/// One of Folio's own files inside a library. A file that was never written
/// reads as nothing recorded, which is how a library it has not touched opens.
fn read_library_file(root: &Path, name: &str, action: &str) -> Result<Option<String>, String> {
    let source = root.join(LIBRARY_DIRECTORY).join(name);
    match fs::read_to_string(&source) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(action, &source, error)),
    }
}

fn write_library_file(root: &Path, name: &str, contents: &str, action: &str) -> Result<(), String> {
    let directory = root.join(LIBRARY_DIRECTORY);
    fs::create_dir_all(&directory)
        .map_err(|error| io_error("create Folio's library folder", &directory, error))?;

    let destination = directory.join(name);
    atomic_write(&destination, contents.as_bytes(), None, true)
        .map_err(|error| io_error(action, &destination, error))
}

/// How the library stands against its sync remote. Cheap and offline: no
/// network is touched, so the footer and the quit prompt can ask freely.
#[tauri::command]
async fn sync_status(state: State<'_, LibraryState>) -> Result<sync::SyncStatus, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    sync::status(&root)
}

/// Connects the open library to a git remote and runs the first sync. The
/// token is kept in Folio's own settings, never inside the library.
#[tauri::command]
async fn sync_connect(
    app: AppHandle,
    remote_url: String,
    token: Option<String>,
    state: State<'_, LibraryState>,
) -> Result<sync::SyncOutcome, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let token = token
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty());

    // The token is recorded before the first sync runs, not after it succeeds.
    // A first sync can fail for reasons that have nothing to do with the token
    // — offline, a typo in the URL — and saving it afterwards would leave the
    // library with a remote configured and no credential to reach it with,
    // which reads later as a mysterious refusal.
    let mut preferences = load_preferences(&app)?;
    preferences.sync_token = token.clone();
    write_preferences(&app, preferences)?;

    sync::connect(&root, &remote_url, token.as_deref())
}

/// Replaces the stored token for a library that is already connected — one
/// that has expired, or one that was never recorded because an early sync
/// failed before it could be saved.
#[tauri::command]
async fn sync_set_token(app: AppHandle, token: String) -> Result<(), String> {
    let token = token.trim().to_string();
    let mut preferences = load_preferences(&app)?;
    preferences.sync_token = (!token.is_empty()).then_some(token);
    write_preferences(&app, preferences)
}

/// One beat of sync: commit whatever changed, pull, merge, push.
#[tauri::command]
async fn sync_now(
    app: AppHandle,
    state: State<'_, LibraryState>,
) -> Result<sync::SyncOutcome, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let token = load_preferences(&app)?.sync_token;
    sync::synchronize(&root, token.as_deref())
}

/// Forgets the sync remote and the stored token. History stays in the
/// library's `.git`; Folio just stops using it.
#[tauri::command]
async fn sync_disconnect(app: AppHandle, state: State<'_, LibraryState>) -> Result<(), String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    sync::disconnect(&root)?;
    let mut preferences = load_preferences(&app)?;
    preferences.sync_token = None;
    write_preferences(&app, preferences)
}

/// The frontend's word that closing may proceed — the quit prompt was
/// answered, or there was nothing to ask.
#[tauri::command]
fn approve_close(app: AppHandle) {
    CLOSE_APPROVED.store(true, AtomicOrdering::Relaxed);
    app.exit(0);
}

/// The id of Folio's own Quit item. macOS's standard one terminates the
/// process outright — the application never sees an exit it could hold — so
/// Folio installs a Quit of its own to ask its question first.
#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "folio-quit";

/// Folio's menu bar. Replacing the default one costs the standard items, so
/// they are all rebuilt here: an editor without Copy and Paste on their usual
/// keys would be a poor trade for a quit prompt.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit Folio", true, Some("CmdOrCtrl+Q"))?;
    let folio = Submenu::with_items(
        app,
        "Folio",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&folio, &edit, &window])
}

/// Starts the closing ritual, or lets the close through when it has already
/// run. Both ways out — the window's close button and Quit — arrive here.
fn request_close(app: &AppHandle) -> bool {
    if CLOSE_APPROVED.load(AtomicOrdering::Relaxed) {
        return true;
    }
    let _ = app.emit("close-requested", ());
    false
}

/// The watcher on the open library, held so it can be dropped — which stops
/// its thread — whenever the library root changes or closes.
#[derive(Default)]
struct WatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

/// Records that Folio itself is writing `path`, so the filesystem event that
/// write causes is not mistaken for a change arriving from outside. Recording
/// a folder covers everything inside it: renaming one reports events for each
/// page it carries along.
fn note_self_write(path: &Path) {
    let mut writes = match RECENT_SELF_WRITES.lock() {
        Ok(writes) => writes,
        Err(poisoned) => poisoned.into_inner(),
    };
    let now = Instant::now();
    writes.retain(|_, written| now.duration_since(*written) <= SELF_WRITE_TTL);
    writes.insert(path.to_path_buf(), now);
}

/// True for library paths the watcher has no business reacting to: anything
/// inside a dot entry, which is where sync engines and Folio alike keep their
/// machinery — except Folio's own bookkeeping files, whose arrival from
/// another device is exactly the kind of change worth showing.
fn hidden_relative_path(relative: &Path) -> bool {
    let bookkeeping = relative.parent() == Some(Path::new(LIBRARY_DIRECTORY))
        && relative
            .file_name()
            .is_some_and(|name| name == ORDER_FILE || name == ICONS_FILE);
    if bookkeeping {
        return false;
    }
    relative.components().any(|component| match component {
        Component::Normal(name) => name.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

/// True when `path` — or a folder it sits in — is one Folio wrote within the
/// last few seconds, which makes the event an echo of Folio's own work.
fn recently_self_written(
    writes: &HashMap<PathBuf, Instant>,
    root: &Path,
    path: &Path,
    now: Instant,
) -> bool {
    let mut candidate = Some(path);
    while let Some(current) = candidate {
        if writes
            .get(current)
            .is_some_and(|written| now.duration_since(*written) <= SELF_WRITE_TTL)
        {
            return true;
        }
        if current == root {
            break;
        }
        candidate = current.parent();
    }
    false
}

/// True when the event describes a change someone other than Folio made to
/// something the library actually shows. A read is not, and neither is a
/// folder's own clock moving: every write Folio makes also bumps its parent
/// folder's timestamps, which the platform reports as a change to the folder
/// — an echo, not news, whichever kind the platform files it under.
fn event_is_external(root: &Path, event: &notify::Event) -> bool {
    use notify::{event::ModifyKind, EventKind};
    if matches!(
        event.kind,
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))
    ) {
        return false;
    }
    // The same folder echo reaches Windows wearing different clothes: a page
    // saved inside a folder bumps that folder's clock, and
    // ReadDirectoryChangesW reports it as a plain modification of the folder
    // rather than as the metadata change macOS calls it. A folder's own
    // timestamps are never news — what the folder holds is, and every one of
    // those changes carries its own event for the entry that changed. Folders
    // arriving, going, and being renamed keep their own kinds, which this
    // leaves alone.
    let folder_clock = matches!(
        event.kind,
        EventKind::Modify(ModifyKind::Any | ModifyKind::Data(_))
    );
    let writes = match RECENT_SELF_WRITES.lock() {
        Ok(writes) => writes,
        Err(poisoned) => poisoned.into_inner(),
    };
    let now = Instant::now();
    event.paths.iter().any(|path| {
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        // The root itself changing says nothing its children's events do not.
        if relative.as_os_str().is_empty() {
            return false;
        }
        if hidden_relative_path(relative) || recently_self_written(&writes, root, path, now) {
            return false;
        }
        !(folder_clock && path.is_dir())
    })
}

/// Watches `root` and calls `on_change` once per settled burst of external
/// changes. The returned watcher owns the subscription: dropping it closes the
/// event channel, which ends the debounce thread.
fn start_watcher(
    root: PathBuf,
    on_change: impl Fn() + Send + 'static,
) -> notify::Result<RecommendedWatcher> {
    let (sender, receiver) = mpsc::channel::<notify::Event>();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            let _ = sender.send(event);
        }
    })?;
    watcher.watch(&root, RecursiveMode::Recursive)?;

    std::thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut relevant = event_is_external(&root, &first);
            let deadline = Instant::now() + WATCH_DEBOUNCE_CAP;
            loop {
                match receiver.recv_timeout(WATCH_DEBOUNCE) {
                    Ok(event) => {
                        relevant = relevant || event_is_external(&root, &event);
                        if Instant::now() >= deadline {
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if relevant {
                            on_change();
                        }
                        return;
                    }
                }
            }
            if relevant {
                on_change();
            }
        }
    });
    Ok(watcher)
}

/// Points the library watcher at `root`, or turns it off. A watcher that
/// cannot start is not worth failing the open over: the library still works,
/// with external changes behind the Refresh button as before.
fn watch_library(app: &AppHandle, root: Option<&Path>) {
    let state = app.state::<WatcherState>();
    let mut slot = match state.watcher.lock() {
        Ok(slot) => slot,
        Err(poisoned) => poisoned.into_inner(),
    };
    *slot = None;
    let Some(root) = root else {
        return;
    };
    let handle = app.clone();
    match start_watcher(root.to_path_buf(), move || {
        let _ = handle.emit("library-changed", ());
    }) {
        Ok(watcher) => *slot = Some(watcher),
        Err(error) => eprintln!("Folio could not watch the library folder: {error}"),
    }
}

#[tauri::command]
async fn write_note(
    path: String,
    content: String,
    state: State<'_, LibraryState>,
) -> Result<NoteRecord, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let relative = validate_relative_path(&path, PathKind::MarkdownFile)?;
    let destination = resolve_existing_file(&root, &relative)?;
    let permissions = fs::metadata(&destination)
        .map_err(|error| io_error("inspect the Markdown file", &destination, error))?
        .permissions();

    atomic_write(&destination, content.as_bytes(), Some(permissions), true)
        .map_err(|error| io_error("save the Markdown file", &destination, error))?;

    let normalized_path = relative_path_to_string(&relative)?;
    Ok(note_record(normalized_path, content))
}

#[tauri::command]
async fn move_note(
    from_path: String,
    to_path: String,
    state: State<'_, LibraryState>,
) -> Result<LibrarySnapshot, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let source_relative = validate_relative_path(&from_path, PathKind::MarkdownFile)?;
    let destination_relative = validate_relative_path(&to_path, PathKind::MarkdownFile)?;

    if source_relative == destination_relative {
        return scan_library_root(&root);
    }

    let source = resolve_existing_file(&root, &source_relative)?;
    let destination_parent = resolve_existing_directory(
        &root,
        destination_relative
            .parent()
            .unwrap_or_else(|| Path::new("")),
    )?;
    let destination = destination_parent.join(
        destination_relative
            .file_name()
            .ok_or_else(|| "A destination file name is required.".to_string())?,
    );

    // A case-only rename on a case-insensitive volume resolves to the same file
    // and is safe. Every other existing destination is left untouched.
    let destination_is_source = if let Ok(destination_canonical) = canonical_path(&destination) {
        if destination_canonical != source {
            return Err(format!(
                "A file already exists at {}.",
                display_path(&destination)
            ));
        }
        true
    } else {
        ensure_destination_absent(&destination)?;
        false
    };

    let source_parent = source.parent().map(Path::to_path_buf);
    note_self_write(&source);
    note_self_write(&destination);
    let move_result = if destination_is_source {
        // Case-only renames on case-insensitive volumes already refer to this
        // inode, so a normal rename cannot clobber a different file.
        fs::rename(&source, &destination)
    } else {
        move_file_without_replacing(&source, &destination)
    };
    move_result.map_err(|error| io_error("move the Markdown file", &destination, error))?;
    sync_directory(&destination_parent);
    if let Some(source_parent) = source_parent {
        if source_parent != destination_parent {
            sync_directory(&source_parent);
        }
    }

    scan_library_root(&root)
}

/// Renames a note or folder in place. `name` is a single path segment; a note
/// keeps (or gains) its `.md` extension.
#[tauri::command]
async fn rename_entry(
    path: String,
    name: String,
    folder: bool,
    state: State<'_, LibraryState>,
) -> Result<LibrarySnapshot, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let kind = if folder {
        PathKind::Folder
    } else {
        PathKind::MarkdownFile
    };
    rename_in_library(&root, &path, &name, kind)?;
    scan_library_root(&root)
}

/// The filesystem half of `rename_entry`, split out so it can be tested
/// against a real directory without a Tauri state handle.
fn rename_in_library(root: &Path, path: &str, name: &str, kind: PathKind) -> Result<(), String> {
    let folder = matches!(kind, PathKind::Folder);
    let relative = validate_relative_path(path, kind)?;
    let new_name = validate_entry_name(name, kind)?;

    let source = if folder {
        resolve_existing_directory(root, &relative)?
    } else {
        resolve_existing_file(root, &relative)?
    };
    let parent =
        resolve_existing_directory(root, relative.parent().unwrap_or_else(|| Path::new("")))?;
    let destination = parent.join(&new_name);

    if destination == source {
        return Ok(());
    }

    note_self_write(&source);
    note_self_write(&destination);
    // A case-only rename on a case-insensitive volume resolves to the same
    // entry and is safe; any other existing destination is left untouched.
    let same_entry = canonical_path(&destination)
        .map(|canonical| canonical == source)
        .unwrap_or(false);
    if same_entry {
        fs::rename(&source, &destination)
            .map_err(|error| io_error("rename the entry", &destination, error))?;
    } else {
        ensure_destination_absent(&destination)?;
        if folder {
            // Directories cannot be hard-linked, so this is the atomic option
            // available; the absence check above closes the common case.
            fs::rename(&source, &destination)
                .map_err(|error| io_error("rename the folder", &destination, error))?;
        } else {
            move_file_without_replacing(&source, &destination)
                .map_err(|error| io_error("rename the Markdown file", &destination, error))?;
        }
    }

    sync_directory(&parent);
    Ok(())
}

/// Moves a note or folder to the system trash, so a mistake stays undoable.
#[tauri::command]
async fn delete_entry(
    path: String,
    folder: bool,
    state: State<'_, LibraryState>,
) -> Result<LibrarySnapshot, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let kind = if folder {
        PathKind::Folder
    } else {
        PathKind::MarkdownFile
    };
    let relative = validate_relative_path(&path, kind)?;
    let target = if folder {
        resolve_existing_directory(&root, &relative)?
    } else {
        resolve_existing_file(&root, &relative)?
    };
    if target == root {
        return Err("The library folder itself cannot be deleted.".to_string());
    }

    let parent = target.parent().map(Path::to_path_buf);
    note_self_write(&target);
    trash::delete(&target).map_err(|error| {
        format!(
            "Folio could not move {} to the trash: {error}",
            display_path(&target)
        )
    })?;
    if let Some(parent) = parent {
        sync_directory(&parent);
    }
    scan_library_root(&root)
}

/// Validates a single path segment typed by the user. Markdown files keep an
/// `.md` extension whether or not the typed name included one.
fn validate_entry_name(value: &str, kind: PathKind) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("A name is required.".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Names cannot contain slashes.".to_string());
    }
    if trimmed.contains('\0') || trimmed.chars().any(char::is_control) {
        return Err("Names cannot contain control characters.".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("That name is reserved.".to_string());
    }
    // A leading dot would hide the entry from the library scan.
    if trimmed.starts_with('.') {
        return Err("Names cannot start with a dot.".to_string());
    }
    reject_unusable_windows_name(trimmed)?;

    let name = match kind {
        PathKind::Folder => trimmed.to_string(),
        PathKind::MarkdownFile => {
            if has_markdown_extension(Path::new(trimmed)) {
                trimmed.to_string()
            } else {
                format!("{trimmed}.md")
            }
        }
        // The caller settles the extension before asking for the rename, so
        // that the file keeps the format its bytes actually are.
        PathKind::ImageFile => {
            if has_image_extension(Path::new(trimmed)) {
                trimmed.to_string()
            } else {
                return Err("Images keep their file extension.".to_string());
            }
        }
    };

    // Round-trip through the strict validator so a rename can never widen what
    // a path is allowed to be.
    validate_relative_path(&name, kind)?;
    Ok(name)
}

/// Characters Windows forbids in a file name. macOS accepts all of them.
const WINDOWS_RESERVED_CHARACTERS: [char; 7] = ['<', '>', ':', '"', '|', '?', '*'];

/// Device names Windows still reserves, with or without an extension, so
/// `CON.md` is refused as surely as `CON`.
const WINDOWS_RESERVED_STEMS: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Why Windows could not store a file under this name, if it could not.
///
/// Compiled on every platform so the rule stays testable from a Mac, and so a
/// change here cannot break the Windows build unnoticed.
fn unusable_windows_name_reason(name: &str) -> Option<String> {
    if let Some(character) = name
        .chars()
        .find(|c| WINDOWS_RESERVED_CHARACTERS.contains(c))
    {
        return Some(format!("Names on Windows cannot contain {character}."));
    }
    // Windows silently drops a trailing dot or space, so the file would not
    // keep the name that was typed.
    if name.ends_with('.') || name.ends_with(' ') {
        return Some("Names cannot end with a dot or a space.".to_string());
    }
    let stem = name.split('.').next().unwrap_or(name);
    WINDOWS_RESERVED_STEMS
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
        .then(|| format!("{stem} is a name Windows reserves for a device."))
}

/// Refuses names Windows cannot store, so a rename reports Folio's own message
/// instead of letting the failure surface as a raw operating system error.
///
/// Only the Windows build enforces this. macOS accepts these names, and
/// rejecting them there would stop readers from renaming pages that their
/// existing libraries already hold.
fn reject_unusable_windows_name(name: &str) -> Result<(), String> {
    if !cfg!(windows) {
        return Ok(());
    }
    match unusable_windows_name_reason(name) {
        Some(reason) => Err(reason),
        None => Ok(()),
    }
}

/// Saves image bytes (base64) beside the note and returns the file name that
/// was actually used, deduplicated against existing files.
#[tauri::command]
async fn write_asset(
    note_path: String,
    file_name: String,
    contents_base64: String,
    state: State<'_, LibraryState>,
) -> Result<String, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|_| "The image data could not be decoded.".to_string())?;
    store_asset(&root, &note_path, &file_name, &bytes)
}

/// Opens the native image picker and brings each selection into the note's
/// folder. Returns the file names to reference; an empty list means
/// "cancelled".
#[tauri::command]
async fn import_assets(
    app: AppHandle,
    note_path: String,
    state: State<'_, LibraryState>,
) -> Result<Vec<String>, String> {
    // Like choose_library, the blocking picker must run on an async command.
    let Some(selection) = app
        .dialog()
        .file()
        .set_title("Insert images")
        .add_filter("Images", &IMAGE_EXTENSIONS)
        .blocking_pick_files()
    else {
        return Ok(Vec::new());
    };

    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let directory = resolve_existing_directory(&root, &note_directory(&note_path)?)?;
    let mut names = Vec::new();
    for picked in selection {
        let path = picked
            .into_path()
            .map_err(|_| "A selected image is not available as a local file.".to_string())?;
        // An image already sitting beside the page is referenced where it is.
        // Copying it would leave the folder holding the same picture twice.
        if let Some(name) = asset_already_beside_note(&directory, &path) {
            names.push(name);
            continue;
        }
        let bytes =
            fs::read(&path).map_err(|error| io_error("read the selected image", &path, error))?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image.png");
        names.push(store_asset(&root, &note_path, name, &bytes)?);
    }
    Ok(names)
}

/// The file name to link, when `path` is already a file in the note's own
/// folder. `directory` is canonical, so this compares canonical parents and
/// never mistakes a symlinked or aliased route to the folder for a copy.
fn asset_already_beside_note(directory: &Path, path: &Path) -> Option<String> {
    let parent = canonical_path(path.parent()?).ok()?;
    if parent != directory {
        return None;
    }
    referenceable_asset_name(path)
}

/// An image file's name, when Markdown can point back at it. A name holding a
/// separator or a control character returns None, which sends the image down
/// the copying path instead — that rewrites the name into something safe.
fn referenceable_asset_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let usable = !name.contains('\\')
        && !name.contains('/')
        && !name.chars().any(char::is_control)
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(is_image_extension);
    usable.then(|| name.to_string())
}

/// Renames an image a page points at, in the folder it already lives in, and
/// returns the new file name. Rewriting the Markdown that points at the image
/// is the caller's half of the job: the pages that reference it are open in the
/// app, where an unsaved edit would otherwise be lost to a write from here.
#[tauri::command]
async fn rename_asset(
    note_path: String,
    src: String,
    name: String,
    state: State<'_, LibraryState>,
) -> Result<String, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let relative = resolve_asset_src(&note_directory(&note_path)?, &src)?;
    let extension = relative
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| is_image_extension(extension))
        .ok_or_else(|| "Only images can be renamed from a page.".to_string())?
        .to_string();
    let new_name = asset_rename_name(&name, &extension)?;
    rename_in_library(
        &root,
        &relative_path_to_string(&relative)?,
        &new_name,
        PathKind::ImageFile,
    )?;
    Ok(new_name)
}

/// Settles the extension of a typed image name. The format follows the bytes,
/// not the typing: a name given without an extension keeps the file's own, and
/// a name that would change one image format into another is refused rather
/// than quietly producing a file that lies about its contents.
fn asset_rename_name(value: &str, extension: &str) -> Result<String, String> {
    let trimmed = value.trim();
    match trimmed.rsplit_once('.') {
        Some((stem, given)) if given.eq_ignore_ascii_case(extension) => {
            if stem.trim().is_empty() {
                Err("A name is required.".to_string())
            } else {
                Ok(trimmed.to_string())
            }
        }
        Some((_, given)) if is_image_extension(given) => Err(format!(
            "This image is a .{extension} file, so it cannot be renamed to .{given}."
        )),
        _ => Ok(format!("{trimmed}.{extension}")),
    }
}

/// Reads an image a note references and returns it as base64. The source is
/// resolved relative to the note's folder, `..` allowed but always confined to
/// the library root by the canonical-path check in resolve_existing_file.
#[tauri::command]
async fn read_asset(
    note_path: String,
    src: String,
    state: State<'_, LibraryState>,
) -> Result<String, String> {
    let _operation = state.lock_operation()?;
    let root = require_library_root(&state)?;
    let note_directory = note_directory(&note_path)?;
    let relative = resolve_asset_src(&note_directory, &src)?;
    if !relative
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(is_image_extension)
    {
        return Err("Only image files can be loaded into a page.".to_string());
    }
    let path = resolve_existing_file(&root, &relative)?;
    let bytes = fs::read(&path).map_err(|error| io_error("read an image", &path, error))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

const IMAGE_EXTENSIONS: [&str; 8] = ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"];

fn is_image_extension(extension: &str) -> bool {
    IMAGE_EXTENSIONS
        .iter()
        .any(|candidate| extension.eq_ignore_ascii_case(candidate))
}

fn note_directory(note_path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(note_path, PathKind::MarkdownFile)?;
    Ok(relative
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .to_path_buf())
}

/// Reduces an image name to a single safe path segment: ASCII alphanumerics,
/// hyphens, and underscores over a known image extension. Anything else
/// becomes a hyphen, which also removes any need for URL escaping in the
/// Markdown that references the file.
fn sanitize_asset_name(value: &str) -> Result<(String, String), String> {
    let name = value.rsplit(['/', '\\']).next().unwrap_or("");
    let (stem, extension) = name
        .rsplit_once('.')
        .ok_or_else(|| "Image files need an extension.".to_string())?;
    let extension = extension.to_ascii_lowercase();
    if !is_image_extension(&extension) {
        return Err(format!("Folio cannot embed .{extension} files."));
    }

    let mut cleaned = String::new();
    for character in stem.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            cleaned.push(character);
        } else if !cleaned.is_empty() && !cleaned.ends_with('-') {
            cleaned.push('-');
        }
    }
    let cleaned = cleaned.trim_end_matches('-');
    let stem = if cleaned.is_empty() { "image" } else { cleaned };
    Ok((stem.to_string(), extension))
}

/// The name of an image in the folder that already holds exactly these bytes.
///
/// Pasting and dropping carry pixels, not a path, so this is what recognizes an
/// image that is already beside the page: a file dragged out of the page's own
/// folder, or the same picture pasted twice. Lengths are compared first, so
/// only a genuine candidate is ever read. Names are sorted for a stable answer
/// when the folder holds more than one copy.
fn asset_with_same_bytes(directory: &Path, bytes: &[u8]) -> Option<String> {
    let mut candidates: Vec<String> = fs::read_dir(directory)
        .ok()?
        .flatten()
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry
                    .metadata()
                    .is_ok_and(|metadata| metadata.len() == bytes.len() as u64)
        })
        .filter_map(|entry| referenceable_asset_name(&entry.path()))
        .collect();
    candidates.sort();
    candidates
        .into_iter()
        .find(|name| fs::read(directory.join(name)).is_ok_and(|existing| existing == bytes))
}

fn store_asset(root: &Path, note_path: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    let note_directory = note_directory(note_path)?;
    let directory = resolve_existing_directory(root, &note_directory)?;
    let (stem, extension) = sanitize_asset_name(name)?;

    // Nothing is copied into a folder that already holds this picture; the
    // page points at the file that is there.
    if let Some(existing) = asset_with_same_bytes(&directory, bytes) {
        return Ok(existing);
    }

    for attempt in 1..1000u32 {
        let candidate = if attempt == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{attempt}.{extension}")
        };
        let destination = directory.join(&candidate);
        // atomic_write without replace fails on existing files, which makes
        // the dedup loop race-free.
        match atomic_write(&destination, bytes, None, false) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error("save an image", &destination, error)),
        }
    }
    Err("Could not find a free image file name.".to_string())
}

/// Joins a Markdown image src onto the note's folder lexically. `.` and `..`
/// are resolved here so relative references between folders work; escaping the
/// library root is rejected, and the caller re-checks the canonical path.
fn resolve_asset_src(note_directory: &Path, src: &str) -> Result<PathBuf, String> {
    if src.is_empty()
        || src.contains('\0')
        || src.chars().any(char::is_control)
        || src.contains('\\')
        || src.starts_with('/')
        || src.ends_with('/')
    {
        return Err("The image path must be relative to its page.".to_string());
    }

    let mut segments = note_directory
        .components()
        .filter_map(|component| match component {
            Component::Normal(segment) => segment.to_str().map(String::from),
            _ => None,
        })
        .collect::<Vec<_>>();

    for part in src.split('/') {
        match part {
            "" => return Err("The image path contains an empty segment.".to_string()),
            "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err("The image is outside the selected library.".to_string());
                }
            }
            segment => segments.push(segment.to_string()),
        }
    }

    if segments.is_empty() {
        return Err("The image path must name a file.".to_string());
    }
    Ok(segments.iter().collect())
}

fn require_library_root(state: &State<'_, LibraryState>) -> Result<PathBuf, String> {
    state
        .get()?
        .ok_or_else(|| "Choose a Markdown library before changing files.".to_string())
}

fn preferences_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Folio could not locate its settings folder: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| io_error("create Folio's settings folder", &directory, error))?;
    Ok(directory.join(PREFERENCES_FILE))
}

fn load_preferences(app: &AppHandle) -> Result<Preferences, String> {
    let path = preferences_path(app)?;
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Preferences::default()),
        Err(error) => return Err(io_error("read Folio's settings", &path, error)),
    };

    serde_json::from_slice(&contents)
        .map_err(|error| format!("Folio's saved library setting is invalid: {error}"))
}

/// Remembers the library folder. The page to reopen at belongs to whichever
/// library was open, so pointing Folio at another folder forgets it; the page
/// opened there is recorded a moment later, once it is on screen.
fn save_preferences(app: &AppHandle, root: Option<&Path>) -> Result<(), String> {
    // The open page belongs to the library being left behind; the sync token
    // belongs to the reader's account and follows them to the next one.
    let sync_token = load_preferences(app)?.sync_token;
    write_preferences(
        app,
        Preferences {
            library_root: root.map(Path::to_path_buf),
            open_note: None,
            sync_token,
        },
    )
}

fn save_open_note(app: &AppHandle, open_note: Option<String>) -> Result<(), String> {
    let preferences = load_preferences(app)?;
    write_preferences(
        app,
        Preferences {
            open_note,
            ..preferences
        },
    )
}

fn write_preferences(app: &AppHandle, preferences: Preferences) -> Result<(), String> {
    let path = preferences_path(app)?;
    let contents = serde_json::to_vec_pretty(&preferences)
        .map_err(|error| format!("Folio could not encode its settings: {error}"))?;
    atomic_write(&path, &contents, None, true)
        .map_err(|error| io_error("save Folio's settings", &path, error))
}

fn canonical_library_root(path: &Path) -> Result<PathBuf, String> {
    let metadata =
        fs::metadata(path).map_err(|error| io_error("open the selected library", path, error))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a folder.", display_path(path)));
    }

    canonical_path(path).map_err(|error| io_error("open the selected library", path, error))
}

fn scan_library_root(root: &Path) -> Result<LibrarySnapshot, String> {
    let root = canonical_library_root(root)?;
    let mut notes = Vec::new();
    let mut folders = Vec::new();
    scan_directory(&root, &root, &mut notes, &mut folders)?;
    notes.sort_by(|left, right| natural_compare(&left.path, &right.path));
    folders.sort_by(|left, right| natural_compare(left, right));

    let name = root
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .unwrap_or_else(|| display_path(&root));

    Ok(LibrarySnapshot {
        name,
        notes,
        folders,
    })
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    notes: &mut Vec<NoteRecord>,
    folders: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| io_error("read the library folder", directory, error))?;
    let mut entries = entries
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| io_error("read the library folder", directory, error))?;
    entries.sort_by(|left, right| {
        natural_compare(
            &left.file_name().to_string_lossy(),
            &right.file_name().to_string_lossy(),
        )
    });

    for entry in entries {
        let entry_path = entry.path();

        // Hidden entries are not pages a reader put in the library, and Folio's
        // own `.folio` folder is one of them.
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|error| io_error("inspect a library entry", &entry_path, error))?;

        // Folio deliberately does not follow symlinks. That keeps every native
        // operation inside the one folder the user selected and prevents loops.
        if file_type.is_symlink() {
            continue;
        }

        let relative = entry_path.strip_prefix(root).map_err(|_| {
            format!(
                "{} is outside the selected Markdown library.",
                display_path(&entry_path)
            )
        })?;
        let relative_path = relative_path_to_string(relative)?;

        if file_type.is_dir() {
            folders.push(relative_path);
            scan_directory(root, &entry_path, notes, folders)?;
        } else if file_type.is_file() && has_markdown_extension(relative) {
            let content = fs::read_to_string(&entry_path)
                .map_err(|error| io_error("read a Markdown file", &entry_path, error))?;
            notes.push(note_record(relative_path, content));
        }
    }

    Ok(())
}

fn note_record(path: String, content: String) -> NoteRecord {
    NoteRecord {
        id: path.clone(),
        title: clean_title(&path),
        path,
        content,
    }
}

fn clean_title(path: &str) -> String {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    let stem = if file_name
        .get(file_name.len().saturating_sub(3)..)
        .is_some_and(|extension| extension.eq_ignore_ascii_case(".md"))
    {
        &file_name[..file_name.len() - 3]
    } else {
        file_name
    };
    let digits = stem
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .count();
    if digits == 0 {
        return stem.to_string();
    }

    let cleaned = stem[digits..].trim_start_matches(['.', '_', ' ', '-']);
    if cleaned.is_empty() {
        stem.to_string()
    } else {
        cleaned.to_string()
    }
}

#[derive(Clone, Copy)]
enum PathKind {
    Folder,
    MarkdownFile,
    ImageFile,
}

fn validate_relative_path(value: &str, kind: PathKind) -> Result<PathBuf, String> {
    if value.is_empty() {
        return Err("A relative path is required.".to_string());
    }
    if value.contains('\0') || value.chars().any(char::is_control) {
        return Err("Paths cannot contain control characters.".to_string());
    }
    if value.contains('\\') {
        return Err("Use forward slashes between folders.".to_string());
    }
    if value.starts_with('/') || value.ends_with('/') {
        return Err("Paths must be relative to the selected library.".to_string());
    }

    let segments = value.split('/').collect::<Vec<_>>();
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err("Paths cannot contain empty, current, or parent segments.".to_string());
    }

    let relative = PathBuf::from(value);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Paths must stay inside the selected library.".to_string());
    }

    if matches!(kind, PathKind::MarkdownFile) && !has_markdown_extension(&relative) {
        return Err("Markdown file paths must end in .md.".to_string());
    }
    if matches!(kind, PathKind::ImageFile) && !has_image_extension(&relative) {
        return Err("Image paths must end in an image extension.".to_string());
    }

    Ok(relative)
}

fn has_markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(is_image_extension)
}

fn resolve_existing_directory(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative.as_os_str().is_empty() {
        return Ok(root.to_path_buf());
    }
    let path = resolve_existing_path(root, relative)?;
    let metadata =
        fs::metadata(&path).map_err(|error| io_error("inspect a library folder", &path, error))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a folder.", display_path(&path)));
    }
    Ok(path)
}

fn resolve_existing_file(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let path = resolve_existing_path(root, relative)?;
    let metadata =
        fs::metadata(&path).map_err(|error| io_error("inspect a Markdown file", &path, error))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file.", display_path(&path)));
    }
    Ok(path)
}

fn resolve_existing_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err("Paths must stay inside the selected library.".to_string());
        };
        current.push(segment);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| io_error("open a library entry", &current, error))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Folio does not follow symbolic links: {}.",
                display_path(&current)
            ));
        }
    }

    let canonical = canonical_path(&current)
        .map_err(|error| io_error("open a library entry", &current, error))?;
    if !canonical.starts_with(root) {
        return Err(format!(
            "{} is outside the selected Markdown library.",
            display_path(&current)
        ));
    }
    Ok(canonical)
}

fn ensure_destination_absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(format!("An item already exists at {}.", display_path(path))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error("inspect the destination", path, error)),
    }
}

fn relative_path_to_string(path: &Path) -> Result<String, String> {
    let mut segments = Vec::new();
    for component in path.components() {
        let Component::Normal(segment) = component else {
            return Err("A library entry has an invalid relative path.".to_string());
        };
        let segment = segment.to_str().ok_or_else(|| {
            format!(
                "Folio cannot display a non-Unicode path: {}.",
                display_path(path)
            )
        })?;
        segments.push(segment);
    }
    Ok(segments.join("/"))
}

fn atomic_write(
    destination: &Path,
    contents: &[u8],
    permissions: Option<Permissions>,
    replace: bool,
) -> io::Result<()> {
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "the destination has no parent")
    })?;
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("folio");

    note_self_write(destination);
    let (temporary_path, mut temporary_file) = (0..64)
        .find_map(|_| {
            let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
            let candidate = parent.join(format!(
                ".{destination_name}.folio-save-{}-{sequence}.tmp",
                std::process::id()
            ));
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&candidate)
            {
                Ok(file) => Some(Ok((candidate, file))),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => None,
                Err(error) => Some(Err(error)),
            }
        })
        .transpose()?
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::AlreadyExists,
                "could not allocate a temporary save file",
            )
        })?;

    let result = (|| {
        temporary_file.write_all(contents)?;
        temporary_file.flush()?;
        if let Some(permissions) = permissions {
            temporary_file.set_permissions(permissions)?;
        }
        temporary_file.sync_all()?;
        drop(temporary_file);

        if replace {
            fs::rename(&temporary_path, destination)?;
        } else {
            // Creating a hard link is an atomic no-replace operation. Unlike
            // an existence check followed by rename, another process cannot
            // slip a file into the destination and have Folio overwrite it.
            fs::hard_link(&temporary_path, destination)?;
            // The destination now owns the fully written inode. A failure to
            // remove the private temporary name must not turn a committed
            // create into an apparent failure that a caller might retry.
            let _ = fs::remove_file(&temporary_path);
        }
        sync_directory(parent);
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn move_file_without_replacing(source: &Path, destination: &Path) -> io::Result<()> {
    // hard_link is atomic and fails when destination already exists. Removing
    // the source then gives rename semantics without an overwrite window.
    fs::hard_link(source, destination)?;
    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(destination);
        return Err(error);
    }
    Ok(())
}

fn sync_directory(directory: &Path) {
    if let Ok(file) = File::open(directory) {
        let _ = file.sync_all();
    }
}

fn natural_compare(left: &str, right: &str) -> Ordering {
    let left_chars = left.chars().collect::<Vec<_>>();
    let right_chars = right.chars().collect::<Vec<_>>();
    let (mut left_index, mut right_index) = (0, 0);

    while left_index < left_chars.len() && right_index < right_chars.len() {
        if left_chars[left_index].is_ascii_digit() && right_chars[right_index].is_ascii_digit() {
            let left_start = left_index;
            let right_start = right_index;
            while left_index < left_chars.len() && left_chars[left_index].is_ascii_digit() {
                left_index += 1;
            }
            while right_index < right_chars.len() && right_chars[right_index].is_ascii_digit() {
                right_index += 1;
            }

            let left_digits = &left_chars[left_start..left_index];
            let right_digits = &right_chars[right_start..right_index];
            let left_significant = left_digits
                .iter()
                .position(|digit| *digit != '0')
                .map(|index| &left_digits[index..])
                .unwrap_or(&left_digits[left_digits.len().saturating_sub(1)..]);
            let right_significant = right_digits
                .iter()
                .position(|digit| *digit != '0')
                .map(|index| &right_digits[index..])
                .unwrap_or(&right_digits[right_digits.len().saturating_sub(1)..]);

            match left_significant.len().cmp(&right_significant.len()) {
                Ordering::Equal => {}
                ordering => return ordering,
            }
            match left_significant.cmp(right_significant) {
                Ordering::Equal => {}
                ordering => return ordering,
            }
            continue;
        }

        match left_chars[left_index]
            .to_ascii_lowercase()
            .cmp(&right_chars[right_index].to_ascii_lowercase())
        {
            Ordering::Equal => {
                left_index += 1;
                right_index += 1;
            }
            ordering => return ordering,
        }
    }

    left_chars
        .len()
        .cmp(&right_chars.len())
        .then_with(|| left.cmp(right))
}

fn io_error(action: &str, path: &Path, error: io::Error) -> String {
    format!(
        "Folio could not {action} at {}: {error}",
        display_path(path)
    )
}

/// Resolves a path to its real location, the way `fs::canonicalize` does.
///
/// Windows `fs::canonicalize` returns a verbatim path (`\\?\C:\…`). That form
/// is correct but leaks into anything a reader sees, and is not what other
/// Windows programs accept, so it is reduced back to `C:\…` whenever the plain
/// form means the same thing. On macOS this is `fs::canonicalize` unchanged.
fn canonical_path(path: &Path) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LibraryState::default())
        .manage(WatcherState::default())
        // Closing goes through the frontend first: uncommitted work in a
        // synced library earns one question before the window goes. Both ways
        // out — the window's close button and Quit — raise the same event.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !request_close(&window.app_handle().clone()) {
                    api.prevent_close();
                }
            }
        })
        .setup(|app| {
            // macOS keeps the application alive when its last window closes,
            // and its own Quit item bypasses the app entirely, so the menu is
            // rebuilt with a Quit that Folio can answer for.
            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app.handle())?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id() == QUIT_MENU_ID {
                        let app = app.clone();
                        if request_close(&app) {
                            app.exit(0);
                        }
                    }
                });
            }

            // Folio's window waits for the frontend to say it has something
            // worth looking at. This is the backstop: a frontend that fails to
            // load must still end up with a window, rather than an app that
            // runs with nothing on screen and no way to reach it.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(WINDOW_REVEAL_TIMEOUT);
                show_main_window(&handle);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            restore_library,
            choose_library,
            scan_library,
            open_linked_note,
            create_folder,
            create_note,
            remember_open_note,
            show_window,
            read_library_order,
            write_library_order,
            read_library_icons,
            write_library_icons,
            pick_icon_image,
            sync_status,
            sync_connect,
            sync_set_token,
            sync_now,
            sync_disconnect,
            approve_close,
            write_note,
            move_note,
            rename_entry,
            delete_entry,
            write_asset,
            import_assets,
            read_asset,
            rename_asset
        ])
        .build(tauri::generate_context!())
        .expect("error while building Folio")
        .run(|_app, event| {
            // Clicking the dock icon of a running app raises this rather than
            // starting a second one. Folio holds its window open across a
            // cancelled quit, so the window is there — it just needs bringing
            // back to the front, and without this nothing appears to happen.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                show_main_window(_app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_entry_names_for_renames() {
        assert_eq!(
            validate_entry_name("Field notes", PathKind::MarkdownFile).unwrap(),
            "Field notes.md"
        );
        // An existing extension is kept rather than doubled.
        assert_eq!(
            validate_entry_name("Field notes.md", PathKind::MarkdownFile).unwrap(),
            "Field notes.md"
        );
        assert_eq!(
            validate_entry_name("  Research  ", PathKind::Folder).unwrap(),
            "Research"
        );
        assert!(validate_entry_name("", PathKind::Folder).is_err());
        assert!(validate_entry_name("   ", PathKind::Folder).is_err());
        assert!(validate_entry_name("a/b", PathKind::Folder).is_err());
        assert!(validate_entry_name("a\\b", PathKind::Folder).is_err());
        assert!(validate_entry_name("..", PathKind::Folder).is_err());
        assert!(validate_entry_name(".hidden", PathKind::Folder).is_err());
        assert!(validate_entry_name("bad\nname", PathKind::Folder).is_err());
    }

    #[test]
    fn sanitizes_asset_names_to_safe_segments() {
        assert_eq!(
            sanitize_asset_name("My Cat (1).PNG").unwrap(),
            ("My-Cat-1".to_string(), "png".to_string())
        );
        assert_eq!(
            sanitize_asset_name("../../evil/pasted_image.png").unwrap(),
            ("pasted_image".to_string(), "png".to_string())
        );
        assert_eq!(
            sanitize_asset_name("()().webp").unwrap(),
            ("image".to_string(), "webp".to_string())
        );
        assert!(sanitize_asset_name("script.js").is_err());
        assert!(sanitize_asset_name("noextension").is_err());
    }

    #[test]
    fn resolves_asset_src_relative_to_the_note() {
        let note_dir = Path::new("02 Research");
        assert_eq!(
            resolve_asset_src(note_dir, "cat.png").unwrap(),
            PathBuf::from("02 Research/cat.png")
        );
        assert_eq!(
            resolve_asset_src(note_dir, "../attachments/cat.png").unwrap(),
            PathBuf::from("attachments/cat.png")
        );
        assert_eq!(
            resolve_asset_src(Path::new(""), "img/cat.png").unwrap(),
            PathBuf::from("img/cat.png")
        );
        assert!(resolve_asset_src(note_dir, "../../cat.png").is_err());
        assert!(resolve_asset_src(note_dir, "/etc/passwd").is_err());
        assert!(resolve_asset_src(note_dir, "a//b.png").is_err());
        assert!(resolve_asset_src(note_dir, "..").is_err());
    }

    #[test]
    fn accepts_only_strict_relative_markdown_paths() {
        assert!(validate_relative_path("01 Notes/Idea.md", PathKind::MarkdownFile).is_ok());
        assert!(validate_relative_path("../Idea.md", PathKind::MarkdownFile).is_err());
        assert!(validate_relative_path("Notes//Idea.md", PathKind::MarkdownFile).is_err());
        assert!(validate_relative_path("/tmp/Idea.md", PathKind::MarkdownFile).is_err());
        assert!(validate_relative_path("Notes\\Idea.md", PathKind::MarkdownFile).is_err());
        assert!(validate_relative_path("Notes/Idea.txt", PathKind::MarkdownFile).is_err());
    }

    #[test]
    fn cleans_numbered_note_titles_like_the_web_app() {
        assert_eq!(
            clean_title("01 Foundations/002 - First idea.md"),
            "First idea"
        );
        assert_eq!(clean_title("Notes/Mixed case.Md"), "Mixed case");
        assert_eq!(clean_title("Notes/Plain title.md"), "Plain title");
    }

    #[test]
    fn natural_sort_keeps_numbered_pages_in_reading_order() {
        let mut paths = vec!["Page 10.md", "Page 2.md", "Page 1.md"];
        paths.sort_by(|left, right| natural_compare(left, right));
        assert_eq!(paths, vec!["Page 1.md", "Page 2.md", "Page 10.md"]);
    }

    #[test]
    fn create_and_move_never_replace_an_existing_destination() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "folio-no-replace-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create test directory");

        let create_destination = directory.join("created.md");
        fs::write(&create_destination, "keep create destination")
            .expect("write create destination");
        assert!(atomic_write(&create_destination, b"replacement", None, false).is_err());
        assert_eq!(
            fs::read_to_string(&create_destination).expect("read create destination"),
            "keep create destination"
        );

        let move_source = directory.join("source.md");
        let move_destination = directory.join("moved.md");
        fs::write(&move_source, "keep source").expect("write move source");
        fs::write(&move_destination, "keep move destination").expect("write move destination");
        assert!(move_file_without_replacing(&move_source, &move_destination).is_err());
        assert_eq!(
            fs::read_to_string(&move_source).expect("read move source"),
            "keep source"
        );
        assert_eq!(
            fs::read_to_string(&move_destination).expect("read move destination"),
            "keep move destination"
        );

        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn the_watcher_ignores_hidden_entries_but_not_folios_bookkeeping() {
        // Sync engines and Folio alike keep their machinery in dot entries,
        // including Folio's own atomic-save temporary files.
        assert!(hidden_relative_path(Path::new(".DS_Store")));
        assert!(hidden_relative_path(Path::new(".git/objects/ab/cdef")));
        assert!(hidden_relative_path(Path::new(".stfolder/marker")));
        assert!(hidden_relative_path(Path::new(
            "notes/.Idea.md.folio-save-42-7.tmp"
        )));
        // The bookkeeping files are the exception: an order or icons file
        // arriving from another device is a change worth showing.
        assert!(!hidden_relative_path(Path::new(".folio/order.json")));
        assert!(!hidden_relative_path(Path::new(".folio/icons.json")));
        assert!(hidden_relative_path(Path::new(".folio/anything-else.json")));
        assert!(hidden_relative_path(Path::new(
            ".folio/.order.json.folio-save-1-1.tmp"
        )));
        assert!(!hidden_relative_path(Path::new("notes/Idea.md")));
    }

    #[test]
    fn the_watcher_recognises_folios_own_writes_and_forgets_them() {
        let root = Path::new("/library");
        let now = Instant::now();
        let mut writes = HashMap::new();
        writes.insert(PathBuf::from("/library/notes/Idea.md"), now);
        writes.insert(PathBuf::from("/library/archive"), now);

        assert!(recently_self_written(
            &writes,
            root,
            Path::new("/library/notes/Idea.md"),
            now
        ));
        // A renamed folder reports events for the pages it carries along, so
        // recording the folder covers everything inside it.
        assert!(recently_self_written(
            &writes,
            root,
            Path::new("/library/archive/deep/Page.md"),
            now
        ));
        assert!(!recently_self_written(
            &writes,
            root,
            Path::new("/library/notes/Other.md"),
            now
        ));

        // A write is only recognisable for a moment; the same path changing
        // later is an external change again.
        let later = now + SELF_WRITE_TTL + Duration::from_secs(1);
        assert!(!recently_self_written(
            &writes,
            root,
            Path::new("/library/notes/Idea.md"),
            later
        ));
    }

    #[test]
    fn a_folders_own_clock_is_not_news_but_the_folder_itself_can_be() {
        use notify::event::{CreateKind, RenameMode};
        use notify::{event::ModifyKind, Event, EventKind};

        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-folder-clock-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        let root = canonical_library_root(&root).expect("canonicalize root");
        let folder = root.join("notes");
        fs::create_dir(&folder).expect("create test folder");
        let page = folder.join("Idea.md");
        fs::write(&page, "a page\n").expect("write page");

        // What Windows calls a save inside a folder: the folder was touched,
        // because the page it holds was written.
        assert!(!event_is_external(
            &root,
            &Event::new(EventKind::Modify(ModifyKind::Any)).add_path(folder.clone())
        ));
        // The page's own event, arriving in the same burst, is the news.
        assert!(event_is_external(
            &root,
            &Event::new(EventKind::Modify(ModifyKind::Any)).add_path(page)
        ));
        // A folder appearing or being renamed is news about the folder itself.
        assert!(event_is_external(
            &root,
            &Event::new(EventKind::Create(CreateKind::Any)).add_path(folder.clone())
        ));
        assert!(event_is_external(
            &root,
            &Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(folder)
        ));

        fs::remove_dir_all(&root).expect("remove test root");
    }

    #[test]
    fn external_writes_wake_the_watcher_and_folios_own_do_not() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-watcher-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        // The production watcher sees the canonical root, so the test must
        // too, or event paths would not strip against it.
        let root = canonical_library_root(&root).expect("canonicalize root");
        // Most pages live in folders, and a folder is where the platforms
        // disagree about what a save looks like — so the test keeps one, made
        // before the watcher arms so its own arrival is not what wakes it.
        let folder = root.join("notes");
        fs::create_dir(&folder).expect("create test folder");
        let page = folder.join("Idea.md");
        fs::write(&page, "first line\n").expect("seed page");
        // The external write below lands on a page of its own: a page Folio
        // saved moments ago is deliberately unrecognisable as external for a
        // few seconds, and that is not what is under test here.
        let other_page = folder.join("Other.md");
        fs::write(&other_page, "first line\n").expect("seed second page");

        let changes = std::sync::Arc::new(AtomicU64::new(0));
        let seen = changes.clone();
        let watcher = start_watcher(root.clone(), move || {
            seen.fetch_add(1, AtomicOrdering::Relaxed);
        })
        .expect("start watcher");
        // Give the platform watcher a beat to arm before the first write.
        std::thread::sleep(Duration::from_millis(400));

        fs::write(root.join("Arrived.md"), "from another device").expect("write page");
        let deadline = Instant::now() + Duration::from_secs(10);
        while changes.load(AtomicOrdering::Relaxed) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(
            changes.load(AtomicOrdering::Relaxed),
            1,
            "an external write should wake the watcher once"
        );

        // Folio's own save runs through atomic_write, which records itself;
        // the events it causes must not read as an external change.
        atomic_write(&root.join("Own.md"), b"saved by Folio", None, false).expect("own write");
        std::thread::sleep(Duration::from_secs(3));
        assert_eq!(
            changes.load(AtomicOrdering::Relaxed),
            1,
            "Folio's own write should not wake the watcher"
        );

        // Saving a page inside a folder is the same own write, and must read
        // the same way. Windows reports it three times over as a plain
        // modification of the folder holding the page, which is the shape a
        // save has when a reader is typing: every keystroke woke the watcher,
        // and the refresh that followed pulled the page back from disk.
        atomic_write(&page, b"first line\nsecond line\n", None, true).expect("own write in folder");
        std::thread::sleep(Duration::from_secs(3));
        assert_eq!(
            changes.load(AtomicOrdering::Relaxed),
            1,
            "Folio's own save inside a folder should not wake the watcher"
        );

        // A page inside a folder changing from outside is still news, so the
        // folder's silence above must not have cost the page its voice.
        fs::write(&other_page, "from another device\n").expect("external write in folder");
        let deadline = Instant::now() + Duration::from_secs(10);
        while changes.load(AtomicOrdering::Relaxed) < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(
            changes.load(AtomicOrdering::Relaxed),
            2,
            "an external write inside a folder should wake the watcher once"
        );

        // The watcher holds a handle on the folder; on Windows that handle
        // would make removing the watched folder racy, so it goes first.
        drop(watcher);
        fs::remove_dir_all(&root).expect("remove test directory");
    }

    #[test]
    fn folio_keeps_its_page_order_and_folder_icons_in_separate_files() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-library-files-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");

        // A library Folio has not written to has recorded nothing, which is
        // read as nothing rather than as a failure to open it.
        assert_eq!(read_order_file(&root), Ok(None));
        assert_eq!(
            read_library_file(&root, ICONS_FILE, "read the folder icons"),
            Ok(None)
        );

        // The dot folder is made on demand, by whichever file is written first.
        write_library_file(
            &root,
            ICONS_FILE,
            "{\"version\":1,\"folders\":{\"guides\":{\"icon\":\"compass\"}}}",
            "save the folder icons",
        )
        .expect("write icons");
        write_order_file(&root, "{\"version\":1,\"folders\":{}}").expect("write order");

        // Each file keeps its own contents: a reorder cannot disturb a mark,
        // and a mark cannot disturb the order.
        assert_eq!(
            read_library_file(&root, ICONS_FILE, "read the folder icons"),
            Ok(Some(
                "{\"version\":1,\"folders\":{\"guides\":{\"icon\":\"compass\"}}}".to_string()
            ))
        );
        assert_eq!(
            read_order_file(&root),
            Ok(Some("{\"version\":1,\"folders\":{}}".to_string()))
        );
        assert!(root.join(LIBRARY_DIRECTORY).join(ICONS_FILE).is_file());
        assert!(root.join(LIBRARY_DIRECTORY).join(ORDER_FILE).is_file());

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn only_pictures_a_webview_can_draw_are_offered_as_folder_icons() {
        assert_eq!(icon_image_mime("png"), Some("image/png"));
        assert_eq!(icon_image_mime("jpg"), Some("image/jpeg"));
        assert_eq!(icon_image_mime("jpeg"), Some("image/jpeg"));
        assert_eq!(icon_image_mime("webp"), Some("image/webp"));
        // An SVG is a document that can carry script, and a PDF is not a mark.
        assert_eq!(icon_image_mime("svg"), None);
        assert_eq!(icon_image_mime("pdf"), None);
        assert_eq!(icon_image_mime(""), None);
    }

    #[test]
    fn images_already_beside_a_page_are_linked_instead_of_copied() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-asset-reuse-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        let root = canonical_path(&root).expect("canonicalize root");
        fs::create_dir(root.join("Research")).expect("create page folder");
        fs::create_dir(root.join("Elsewhere")).expect("create other folder");
        fs::write(root.join("Research/Idea.md"), "body").expect("write page");
        fs::write(root.join("Research/My Plot.png"), b"plot").expect("write neighbour");
        fs::write(root.join("Elsewhere/Away.png"), b"away").expect("write outsider");

        let directory = root.join("Research");
        // Beside the page: linked under the name it already has, spaces and all.
        assert_eq!(
            asset_already_beside_note(&directory, &root.join("Research/My Plot.png")),
            Some("My Plot.png".to_string())
        );
        // Anywhere else, including the library root, is a copy.
        assert_eq!(
            asset_already_beside_note(&directory, &root.join("Elsewhere/Away.png")),
            None
        );
        // A route through `..` still resolves to the page's own folder.
        assert_eq!(
            asset_already_beside_note(&directory, &root.join("Elsewhere/../Research/My Plot.png")),
            Some("My Plot.png".to_string())
        );

        // Dropped or pasted pixels that already sit in the folder link to the
        // file that holds them, whatever it is called.
        assert_eq!(
            store_asset(&root, "Research/Idea.md", "My Plot.png", b"plot").unwrap(),
            "My Plot.png"
        );
        assert_eq!(
            store_asset(&root, "Research/Idea.md", "screenshot.png", b"plot").unwrap(),
            "My Plot.png"
        );
        assert!(!root.join("Research/My-Plot.png").exists());

        // A picture the folder does not hold is copied in, and a second,
        // different picture under the same name still gets its own file.
        assert_eq!(
            store_asset(&root, "Research/Idea.md", "My Plot.png", b"other pixels").unwrap(),
            "My-Plot.png"
        );
        assert_eq!(
            store_asset(&root, "Research/Idea.md", "My Plot.png", b"third picture").unwrap(),
            "My-Plot-2.png"
        );
        assert_eq!(
            fs::read(root.join("Research/My Plot.png")).expect("read neighbour"),
            b"plot"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn image_renames_keep_the_format_the_bytes_are() {
        // A name typed without an extension takes the file's own.
        assert_eq!(
            asset_rename_name("Variance drift", "png").unwrap(),
            "Variance drift.png"
        );
        // Typing the extension is fine, in any case.
        assert_eq!(asset_rename_name("drift.PNG", "png").unwrap(), "drift.PNG");
        assert_eq!(
            asset_rename_name("  drift.png  ", "png").unwrap(),
            "drift.png"
        );
        // A name that merely contains a dot keeps all of it.
        assert_eq!(
            asset_rename_name("figure 2.1", "jpg").unwrap(),
            "figure 2.1.jpg"
        );
        // Renaming cannot turn one image format into another.
        assert!(asset_rename_name("drift.jpg", "png").is_err());
        assert!(asset_rename_name(".png", "png").is_err());
    }

    #[test]
    fn renames_an_image_where_it_sits() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-asset-rename-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        let root = canonical_path(&root).expect("canonicalize root");
        fs::create_dir(root.join("Research")).expect("create page folder");
        fs::create_dir(root.join("figs")).expect("create image folder");
        fs::write(root.join("Research/Idea.md"), "body").expect("write page");
        fs::write(root.join("Research/plot.png"), b"plot").expect("write image");
        fs::write(root.join("figs/shared.png"), b"shared").expect("write shared image");
        fs::write(root.join("figs/taken.png"), b"taken").expect("write taken name");

        // Beside the page.
        rename_in_library(
            &root,
            "Research/plot.png",
            "Variance drift.png",
            PathKind::ImageFile,
        )
        .expect("rename image");
        assert!(!root.join("Research/plot.png").exists());
        assert_eq!(
            fs::read(root.join("Research/Variance drift.png")).expect("read renamed"),
            b"plot"
        );

        // Reached through `..`, resolved from the page that shows it.
        let relative = resolve_asset_src(Path::new("Research"), "../figs/shared.png").unwrap();
        assert_eq!(relative, PathBuf::from("figs/shared.png"));
        rename_in_library(
            &root,
            &relative_path_to_string(&relative).unwrap(),
            "diagram.png",
            PathKind::ImageFile,
        )
        .expect("rename shared image");
        assert_eq!(
            fs::read(root.join("figs/diagram.png")).expect("read renamed shared"),
            b"shared"
        );

        // A name already in use is refused, leaving both files as they were.
        assert!(
            rename_in_library(&root, "figs/diagram.png", "taken.png", PathKind::ImageFile).is_err()
        );
        assert_eq!(
            fs::read(root.join("figs/taken.png")).expect("read taken"),
            b"taken"
        );
        assert!(root.join("figs/diagram.png").exists());

        // Markdown and folders cannot be renamed through the image path, and an
        // image cannot be renamed out of its folder.
        assert!(
            rename_in_library(&root, "Research/Idea.md", "x.png", PathKind::ImageFile).is_err()
        );
        assert!(rename_in_library(
            &root,
            "figs/diagram.png",
            "../escape.png",
            PathKind::ImageFile
        )
        .is_err());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn renames_pages_and_folders_without_clobbering() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-rename-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        let root = canonical_path(&root).expect("canonicalize root");
        fs::create_dir(root.join("Research")).expect("create folder");
        fs::write(root.join("Research/Idea.md"), "body").expect("write note");
        fs::write(root.join("Research/Taken.md"), "other").expect("write other note");

        // A page rename keeps the contents and adds the extension for you.
        rename_in_library(
            &root,
            "Research/Idea.md",
            "Better idea",
            PathKind::MarkdownFile,
        )
        .expect("rename note");
        assert!(!root.join("Research/Idea.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("Research/Better idea.md")).expect("read renamed"),
            "body"
        );

        // Renaming onto an existing page is refused, and changes nothing.
        assert!(rename_in_library(
            &root,
            "Research/Better idea.md",
            "Taken",
            PathKind::MarkdownFile
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(root.join("Research/Taken.md")).expect("read taken"),
            "other"
        );
        assert!(root.join("Research/Better idea.md").exists());

        // A folder rename carries its contents along.
        rename_in_library(&root, "Research", "Field notes", PathKind::Folder)
            .expect("rename folder");
        assert!(!root.join("Research").exists());
        assert_eq!(
            fs::read_to_string(root.join("Field notes/Better idea.md")).expect("read moved"),
            "body"
        );

        // Escaping the library is refused.
        assert!(rename_in_library(&root, "../outside", "x", PathKind::Folder).is_err());
        assert!(rename_in_library(&root, "Field notes", "../escape", PathKind::Folder).is_err());

        fs::remove_dir_all(&root).expect("remove test root");
    }

    #[test]
    fn follows_links_out_of_the_library_to_the_folder_holding_both_pages() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "folio-linked-note-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&base).expect("create test base");
        let base = canonical_path(&base).expect("canonicalize base");
        let notes = base.join("notes");
        fs::create_dir_all(notes.join("rust")).expect("create rust folder");
        fs::create_dir_all(notes.join("math")).expect("create math folder");
        fs::create_dir_all(base.join("elsewhere")).expect("create elsewhere folder");
        fs::write(notes.join("rust/Ownership.md"), "body").expect("write linking page");
        fs::write(notes.join("math/Topology.md"), "body").expect("write linked page");
        fs::write(base.join("elsewhere/Far.md"), "body").expect("write far page");
        fs::write(notes.join("rust/notes.txt"), "body").expect("write text file");

        // The library is open at notes/rust, so a link into notes/math points
        // above its root.
        let root = notes.join("rust");
        let target = resolve_link_target(&root, &root, "../math/Topology.md")
            .expect("resolve the linked page");
        assert_eq!(target, notes.join("math/Topology.md"));
        assert_eq!(
            linked_library_root(&root, target.parent().expect("target folder")),
            notes,
            "both pages live under notes, so that is the folder to open"
        );

        // A page that shares nothing but the temporary base still opens, just
        // at its own folder — here the base is small enough to be shared, so
        // the shared-parent rule applies to it too.
        let far = resolve_link_target(&root, &root, "../../elsewhere/Far.md")
            .expect("resolve the far page");
        assert_eq!(
            linked_library_root(&root, far.parent().expect("far folder")),
            base
        );

        // Only real Markdown files are followed.
        assert!(resolve_link_target(&root, &root, "notes.txt").is_none());
        assert!(resolve_link_target(&root, &root, "../math/Missing.md").is_none());
        assert!(resolve_link_target(&root, &root, "").is_none());
        // A leading slash reads from the library root, not the filesystem's.
        assert_eq!(
            resolve_link_target(&notes, &notes.join("rust"), "/math/Topology.md"),
            Some(notes.join("math/Topology.md"))
        );

        // End to end: the library opens at notes with the linked page selected
        // under the path the scan gave it.
        let (new_root, linked) =
            follow_link_in_library(&root, "Ownership.md", "../math/Topology.md#axioms")
                .expect("follow the link")
                .expect("the linked page exists");
        assert_eq!(new_root, notes);
        assert_eq!(linked.path, "math/Topology.md");
        assert!(linked.rerooted);
        assert!(linked
            .snapshot
            .notes
            .iter()
            .any(|note| note.id == linked.path));
        assert_eq!(linked.snapshot.name, "notes");
        assert_eq!(linked.snapshot.notes.len(), 2, "both pages are in view");

        // A link that stays inside the open library keeps that library open,
        // even when the page appeared after the last scan.
        fs::write(notes.join("rust/Traits.md"), "body").expect("write new page");
        let (unchanged_root, linked) =
            follow_link_in_library(&notes, "rust/Ownership.md", "Traits.md")
                .expect("follow the link")
                .expect("the linked page exists");
        assert_eq!(unchanged_root, notes);
        assert_eq!(linked.path, "rust/Traits.md");
        assert!(!linked.rerooted);

        assert!(follow_link_in_library(&root, "Ownership.md", "Missing.md")
            .expect("follow the link")
            .is_none());

        fs::remove_dir_all(&base).expect("remove test base");
    }

    #[test]
    fn shared_parent_stops_at_the_filesystem_root() {
        assert_eq!(
            shared_parent(Path::new("/a/notes/rust"), Path::new("/a/notes/math")),
            Some(PathBuf::from("/a/notes"))
        );
        assert_eq!(
            shared_parent(Path::new("/a/notes/rust"), Path::new("/a")),
            Some(PathBuf::from("/a"))
        );
        assert_eq!(shared_parent(Path::new("/a"), Path::new("/b")), None);
    }

    #[test]
    fn entry_budget_rejects_folders_too_large_to_read_as_a_library() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-entry-budget-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        fs::create_dir(root.join("inner")).expect("create inner folder");
        for index in 0..4 {
            fs::write(root.join(format!("inner/page-{index}.md")), "body").expect("write page");
        }

        assert!(within_entry_budget(&root, 5));
        assert!(!within_entry_budget(&root, 4));
        assert!(!within_entry_budget(&root.join("missing"), 100));

        fs::remove_dir_all(&root).expect("remove test root");
    }

    #[test]
    fn settings_saved_before_folio_remembered_a_page_still_load() {
        let stored: Preferences = serde_json::from_str(r#"{"libraryRoot":"/tmp/pages"}"#)
            .expect("read settings written by an earlier version");
        assert_eq!(stored.library_root, Some(PathBuf::from("/tmp/pages")));
        assert_eq!(stored.open_note, None);

        let written = serde_json::to_string(&Preferences {
            library_root: Some(PathBuf::from("/tmp/pages")),
            open_note: Some("guides/setup.md".to_string()),
            sync_token: None,
        })
        .expect("encode settings");
        // An absent token stays absent on disk rather than appearing as null.
        assert!(!written.contains("syncToken"), "{written}");
        assert!(
            written.contains(r#""openNote":"guides/setup.md""#),
            "{written}"
        );
        let read_back: Preferences = serde_json::from_str(&written).expect("read settings");
        assert_eq!(read_back.open_note.as_deref(), Some("guides/setup.md"));
    }

    #[test]
    fn keeps_a_page_order_beside_the_library_and_out_of_its_listing() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-order-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        fs::write(root.join("intro.md"), "# Intro").expect("write page");
        fs::create_dir(root.join("guides")).expect("create folder");
        fs::write(root.join("guides/setup.md"), "# Setup").expect("write page");

        // A library that has never been reordered simply has no order.
        assert_eq!(read_order_file(&root), Ok(None));

        let recorded = "{\"version\":1,\"folders\":{\"\":[\"intro.md\"]}}\n";
        write_order_file(&root, recorded).expect("write the order");
        assert_eq!(read_order_file(&root), Ok(Some(recorded.to_string())));

        // Rewriting replaces the file rather than appending to it.
        let rewritten = "{\"version\":1,\"folders\":{}}\n";
        write_order_file(&root, rewritten).expect("rewrite the order");
        assert_eq!(read_order_file(&root), Ok(Some(rewritten.to_string())));

        // Folio's own folder is not a folder of pages, so it stays unlisted.
        let snapshot = scan_library_root(&root).expect("scan the library");
        assert_eq!(snapshot.folders, vec!["guides".to_string()]);
        assert_eq!(
            snapshot
                .notes
                .iter()
                .map(|note| note.path.clone())
                .collect::<Vec<_>>(),
            vec!["guides/setup.md".to_string(), "intro.md".to_string()]
        );

        fs::remove_dir_all(&root).expect("remove test root");
    }

    /// The rule is checked on every platform even though only the Windows
    /// build enforces it, so a Mac still catches a mistake in it.
    #[test]
    fn names_windows_cannot_store_are_named_as_such() {
        for name in [
            "notes: draft.md",
            "why?.md",
            "a<b>.md",
            "pipe|name.md",
            "star*.md",
            "quote\".md",
            "trailing dot.",
            "trailing space ",
            // Device names are reserved with or without an extension, and
            // regardless of case.
            "CON",
            "con.md",
            "Aux.md",
            "lpt1.md",
            "NUL",
        ] {
            assert!(
                unusable_windows_name_reason(name).is_some(),
                "{name} should be refused on Windows"
            );
        }

        for name in [
            "Ownership.md",
            "notes - draft.md",
            "a.b.c.md",
            // Not device names: the reserved list is exact, not a prefix.
            "CONTENTS.md",
            "console.md",
            "COM10.md",
            "conclusion",
        ] {
            assert_eq!(
                unusable_windows_name_reason(name),
                None,
                "{name} should be allowed on Windows"
            );
        }
    }

    /// Ignored by default because it leaves a file in the system trash. Run
    /// with `cargo test -- --ignored` to confirm trashing still works on a new
    /// macOS or Windows release.
    #[test]
    #[ignore = "moves a file to the system trash"]
    fn moves_entries_to_the_trash() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-trash-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        let victim = root.join("folio-trash-check.md");
        fs::write(&victim, "delete me").expect("write victim");

        trash::delete(&victim).expect("trash the file");
        assert!(!victim.exists(), "the file should be gone from the library");

        fs::remove_dir_all(&root).expect("remove test root");
    }
}
