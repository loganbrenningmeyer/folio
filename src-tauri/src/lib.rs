use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    fs::{self, File, OpenOptions, Permissions},
    io::{self, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering as AtomicOrdering},
        Mutex, MutexGuard,
    },
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const PREFERENCES_FILE: &str = "library.json";
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
) -> Result<Option<LibrarySnapshot>, String> {
    let _operation = state.lock_operation()?;
    let Some(stored_root) = load_preferences(&app)?.library_root else {
        state.set(None)?;
        return Ok(None);
    };

    let root = canonical_library_root(&stored_root)?;
    let snapshot = scan_library_root(&root)?;
    state.set(Some(root))?;
    Ok(Some(snapshot))
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
    let destination_is_source = if let Ok(destination_canonical) = fs::canonicalize(&destination) {
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
fn rename_in_library(
    root: &Path,
    path: &str,
    name: &str,
    kind: PathKind,
) -> Result<(), String> {
    let folder = matches!(kind, PathKind::Folder);
    let relative = validate_relative_path(path, kind)?;
    let new_name = validate_entry_name(name, kind)?;

    let source = if folder {
        resolve_existing_directory(root, &relative)?
    } else {
        resolve_existing_file(root, &relative)?
    };
    let parent = resolve_existing_directory(
        root,
        relative.parent().unwrap_or_else(|| Path::new("")),
    )?;
    let destination = parent.join(&new_name);

    if destination == source {
        return Ok(());
    }

    // A case-only rename on a case-insensitive volume resolves to the same
    // entry and is safe; any other existing destination is left untouched.
    let same_entry = fs::canonicalize(&destination)
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

/// Moves a note or folder to the Finder trash, so a mistake stays undoable.
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

    let name = match kind {
        PathKind::Folder => trimmed.to_string(),
        PathKind::MarkdownFile => {
            if has_markdown_extension(Path::new(trimmed)) {
                trimmed.to_string()
            } else {
                format!("{trimmed}.md")
            }
        }
    };

    // Round-trip through the strict validator so a rename can never widen what
    // a path is allowed to be.
    validate_relative_path(&name, kind)?;
    Ok(name)
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

/// Opens the native image picker and copies each selection into the note's
/// folder. Returns the stored file names; an empty list means "cancelled".
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
    let mut names = Vec::new();
    for picked in selection {
        let path = picked
            .into_path()
            .map_err(|_| "A selected image is not available as a local file.".to_string())?;
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

fn store_asset(root: &Path, note_path: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    let note_directory = note_directory(note_path)?;
    let directory = resolve_existing_directory(root, &note_directory)?;
    let (stem, extension) = sanitize_asset_name(name)?;

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

fn save_preferences(app: &AppHandle, root: Option<&Path>) -> Result<(), String> {
    let path = preferences_path(app)?;
    let preferences = Preferences {
        library_root: root.map(Path::to_path_buf),
    };
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

    fs::canonicalize(path).map_err(|error| io_error("open the selected library", path, error))
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

    Ok(relative)
}

fn has_markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
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

    let canonical = fs::canonicalize(&current)
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

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LibraryState::default())
        .invoke_handler(tauri::generate_handler![
            restore_library,
            choose_library,
            scan_library,
            create_folder,
            create_note,
            write_note,
            move_note,
            rename_entry,
            delete_entry,
            write_asset,
            import_assets,
            read_asset
        ])
        .run(tauri::generate_context!())
        .expect("error while running Folio");
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
    fn renames_pages_and_folders_without_clobbering() {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, AtomicOrdering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "folio-rename-test-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&root).expect("create test root");
        let root = fs::canonicalize(&root).expect("canonicalize root");
        fs::create_dir(root.join("Research")).expect("create folder");
        fs::write(root.join("Research/Idea.md"), "body").expect("write note");
        fs::write(root.join("Research/Taken.md"), "other").expect("write other note");

        // A page rename keeps the contents and adds the extension for you.
        rename_in_library(&root, "Research/Idea.md", "Better idea", PathKind::MarkdownFile)
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
        assert!(
            rename_in_library(&root, "Field notes", "../escape", PathKind::Folder).is_err()
        );

        fs::remove_dir_all(&root).expect("remove test root");
    }

    /// Ignored by default because it leaves a file in the Finder trash. Run
    /// with `cargo test -- --ignored` to confirm trashing still works on a
    /// new macOS release.
    #[test]
    #[ignore = "moves a file to the Finder trash"]
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
