//! Git-backed sync. The library folder is the repository: history lives in a
//! `.git` beside the pages, a remote the reader owns carries changes between
//! their devices, and everything stays plain Markdown on disk.
//!
//! The rhythm is deliberate. Saving stays local and constant; committing is a
//! chosen moment — the shortcut, the quit prompt, or the launch sweep that
//! gathers up whatever a crash or force-quit left behind. One entry point,
//! [`synchronize`], does the whole beat: commit what changed, fetch, merge,
//! push. Merges resolve to a single file, never a conflicted copy: page text
//! merges line by line and same-line edits keep both sides in sequence, while
//! Folio's own bookkeeping files merge folder by folder.
//!
//! Everything here is plain filesystem and libgit2 — no Tauri types — so the
//! whole engine runs under `cargo test` against local bare remotes.

use crate::{ICONS_FILE, LIBRARY_DIRECTORY, ORDER_FILE};
use git2::{
    build::CheckoutBuilder, Cred, CredentialType, Direction, FetchOptions, FileFavor, Index,
    IndexAddOption, IndexEntry, IndexTime, MergeOptions, Oid, PushOptions, RemoteCallbacks,
    Repository, RepositoryInitOptions, Signature, Status, StatusOptions,
};
use serde::Serialize;
use std::{cell::RefCell, collections::BTreeMap, fs, path::Path};

/// The one remote Folio manages. Sync is a private repository the reader
/// owns, not a graph of them.
const REMOTE: &str = "origin";

/// The stage bits of an index entry's flags. Clearing them turns a conflict
/// side into an ordinary resolved entry.
const INDEX_STAGE_MASK: u16 = 0x3000;

/// What `.gitignore` starts as: files the operating system litters and the
/// temporary names Folio's own atomic saves pass through.
const DEFAULT_GITIGNORE: &str = ".DS_Store\nThumbs.db\ndesktop.ini\n.*.folio-save-*.tmp\n";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// True when the library has a repository with Folio's remote configured.
    pub configured: bool,
    pub remote: Option<String>,
    pub branch: Option<String>,
    /// Files changed since the last commit — what the quit prompt asks about.
    pub changed_files: usize,
    /// Commits waiting to be pushed, against the last-fetched remote state.
    pub ahead: usize,
    /// Commits fetched but not yet merged. Zero right after a sync.
    pub behind: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub committed: bool,
    pub pulled: bool,
    pub pushed: bool,
    /// One human sentence describing what the sync did.
    pub summary: String,
}

fn git_error(action: &str) -> impl Fn(git2::Error) -> String + '_ {
    move |error| format!("Folio could not {action}: {}", error.message())
}

const NOT_CONFIGURED: &str =
    "Sync is not set up for this library. Connect a repository in Preferences → Sync.";

/// The library's repository, when the library itself is one. `open` does not
/// search parent folders, so a library that merely sits inside some other
/// repository does not read as configured.
fn open_repository(root: &Path) -> Option<Repository> {
    Repository::open(root).ok()
}

/// Who the commits are from: the reader's own git identity when they have
/// one, otherwise a name that says plainly the app wrote it.
fn identity(repo: &Repository) -> Result<Signature<'static>, String> {
    if let Ok(signature) = repo.signature() {
        return Ok(signature);
    }
    Signature::now("Folio", "folio@localhost").map_err(git_error("sign a commit"))
}

/// The branch sync lives on: whatever HEAD names, born or not.
fn current_branch(repo: &Repository) -> Result<String, String> {
    let head = repo
        .find_reference("HEAD")
        .map_err(git_error("read the current branch"))?;
    let target = head
        .symbolic_target()
        .ok()
        .flatten()
        .unwrap_or("refs/heads/main");
    Ok(target
        .strip_prefix("refs/heads/")
        .unwrap_or("main")
        .to_string())
}

fn callbacks(token: Option<&str>) -> RemoteCallbacks<'_> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, username, allowed| {
        // An https remote authenticates with the stored token; an ssh remote
        // asks the agent, which holds whatever keys the reader already uses.
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(token) = token {
                return Cred::userpass_plaintext("x-access-token", token);
            }
        }
        if allowed.contains(CredentialType::SSH_KEY) {
            return Cred::ssh_key_from_agent(username.unwrap_or("git"));
        }
        Cred::default()
    });
    callbacks
}

/// How the library stands, without touching the network: what the footer
/// shows and what the quit prompt decides by.
pub fn status(root: &Path) -> Result<SyncStatus, String> {
    let unconfigured = SyncStatus {
        configured: false,
        remote: None,
        branch: None,
        changed_files: 0,
        ahead: 0,
        behind: 0,
    };
    let Some(repo) = open_repository(root) else {
        return Ok(unconfigured);
    };
    let Ok(remote) = repo.find_remote(REMOTE) else {
        return Ok(unconfigured);
    };
    let remote_url = remote.url().ok().map(str::to_string);
    let branch = current_branch(&repo)?;

    let changed_files = pending_changes(&repo)?.total();

    let local = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .ok()
        .and_then(|reference| reference.target());
    let tracked = repo
        .find_reference(&format!("refs/remotes/{REMOTE}/{branch}"))
        .ok()
        .and_then(|reference| reference.target());
    let (ahead, behind) = match (local, tracked) {
        (Some(local), Some(tracked)) => repo
            .graph_ahead_behind(local, tracked)
            .map_err(git_error("compare local and remote history"))?,
        // Local commits with no remote branch fetched yet are all unpushed.
        (Some(_), None) => (1, 0),
        _ => (0, 0),
    };

    Ok(SyncStatus {
        configured: true,
        remote: remote_url,
        branch: Some(branch),
        changed_files,
        ahead,
        behind,
    })
}

/// Connects the library to a remote: makes the folder a repository if it is
/// not one, points Folio's remote at `url`, and runs a first synchronize —
/// which pushes a fresh library up, or pulls an existing one down.
pub fn connect(root: &Path, url: &str, token: Option<&str>) -> Result<SyncOutcome, String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("A remote URL is required.".to_string());
    }
    let repo = match Repository::open(root) {
        Ok(repo) => repo,
        Err(_) => {
            let mut options = RepositoryInitOptions::new();
            options.initial_head("main");
            options.no_reinit(true);
            Repository::init_opts(root, &options)
                .map_err(git_error("turn the library into a repository"))?
        }
    };

    match repo.find_remote(REMOTE) {
        Ok(existing) if existing.url().ok() == Some(url) => {}
        Ok(_) => {
            repo.remote_set_url(REMOTE, url)
                .map_err(git_error("point sync at the new remote"))?;
        }
        Err(_) => {
            repo.remote(REMOTE, url)
                .map_err(git_error("add the sync remote"))?;
        }
    }

    // The ignore file keeps OS litter and half-written saves out of history.
    // Only its absence is corrected; a hand-edited one is the reader's.
    let ignore = root.join(".gitignore");
    if !ignore.exists() {
        fs::write(&ignore, DEFAULT_GITIGNORE)
            .map_err(|error| format!("Folio could not write .gitignore: {error}"))?;
    }
    drop(repo);

    synchronize(root, token)
}

/// Forgets the remote. History stays — `.git` remains in the library — but
/// Folio stops committing, pulling, and asking about it.
pub fn disconnect(root: &Path) -> Result<(), String> {
    let Some(repo) = open_repository(root) else {
        return Ok(());
    };
    if repo.find_remote(REMOTE).is_ok() {
        repo.remote_delete(REMOTE)
            .map_err(git_error("disconnect the sync remote"))?;
    }
    Ok(())
}

/// The whole beat: commit what changed, fetch, merge, push. When someone else
/// pushes between our fetch and our push, the loop takes their changes and
/// tries again rather than reporting a failure the reader cannot act on.
pub fn synchronize(root: &Path, token: Option<&str>) -> Result<SyncOutcome, String> {
    let Some(repo) = open_repository(root) else {
        return Err(NOT_CONFIGURED.to_string());
    };
    if repo.find_remote(REMOTE).is_err() {
        return Err(NOT_CONFIGURED.to_string());
    }

    let committed = commit_all(&repo)?;
    let branch = current_branch(&repo)?;
    let mut pulled = false;
    let mut pushed = false;

    for attempt in 0..3 {
        if let Some(tip) = fetch_branch(&repo, &branch, token)? {
            pulled |= integrate(&repo, &branch, tip)?;
        }
        if !is_ahead(&repo, &branch)? {
            break;
        }
        match push_branch(&repo, &branch, token) {
            Ok(()) => {
                pushed = true;
                break;
            }
            // A rejected push means the remote moved; fetch and merge again.
            Err(PushError::Rejected(_)) if attempt + 1 < 3 => continue,
            Err(PushError::Rejected(reason)) => {
                return Err(format!("Folio could not push to the sync remote: {reason}"));
            }
            Err(PushError::Failed(message)) => return Err(message),
        }
    }

    let summary = summarize(committed, pulled, pushed);
    Ok(SyncOutcome {
        committed: committed.is_some(),
        pulled,
        pushed,
        summary,
    })
}

fn summarize(committed: Option<usize>, pulled: bool, pushed: bool) -> String {
    let mut parts = Vec::new();
    if let Some(count) = committed {
        parts.push(format!(
            "committed {count} change{}",
            if count == 1 { "" } else { "s" }
        ));
    }
    if pulled {
        parts.push("pulled remote changes".to_string());
    }
    if pushed {
        parts.push("pushed".to_string());
    }
    if parts.is_empty() {
        return "Everything up to date.".to_string();
    }
    let mut sentence = parts.join(", ");
    sentence[..1].make_ascii_uppercase();
    sentence.push('.');
    sentence
}

/// What has changed since the last commit, counted for the commit message and
/// the quit prompt. Ignored files are already left out of `statuses`.
struct PendingChanges {
    added: usize,
    updated: usize,
    removed: usize,
}

impl PendingChanges {
    fn total(&self) -> usize {
        self.added + self.updated + self.removed
    }

    fn message(&self) -> String {
        let file = |count: usize| format!("{count} file{}", if count == 1 { "" } else { "s" });
        let mut parts = Vec::new();
        if self.added > 0 {
            parts.push(format!("add {}", file(self.added)));
        }
        if self.updated > 0 {
            parts.push(format!("update {}", file(self.updated)));
        }
        if self.removed > 0 {
            parts.push(format!("remove {}", file(self.removed)));
        }
        if parts.is_empty() {
            return "Update library".to_string();
        }
        let mut message = parts.join(", ");
        message[..1].make_ascii_uppercase();
        message
    }
}

fn pending_changes(repo: &Repository) -> Result<PendingChanges, String> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true);
    let statuses = repo
        .statuses(Some(&mut options))
        .map_err(git_error("read what has changed"))?;

    let mut changes = PendingChanges {
        added: 0,
        updated: 0,
        removed: 0,
    };
    for entry in statuses.iter() {
        let status = entry.status();
        if status.intersects(Status::WT_NEW | Status::INDEX_NEW) {
            changes.added += 1;
        } else if status.intersects(Status::WT_DELETED | Status::INDEX_DELETED) {
            changes.removed += 1;
        } else if !status.is_empty() {
            changes.updated += 1;
        }
    }
    Ok(changes)
}

/// Stages everything and commits it, when there is anything to commit.
/// Returns how many files the commit gathered.
fn commit_all(repo: &Repository) -> Result<Option<usize>, String> {
    let changes = pending_changes(repo)?;

    let mut index = repo.index().map_err(git_error("open the index"))?;
    index
        .add_all(["*"], IndexAddOption::DEFAULT, None)
        .map_err(git_error("stage the library"))?;
    index
        .update_all(["*"], None)
        .map_err(git_error("stage removals"))?;
    index.write().map_err(git_error("write the index"))?;
    let tree_id = index
        .write_tree()
        .map_err(git_error("record the library's state"))?;

    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    match &parent {
        Some(parent) if parent.tree_id() == tree_id => return Ok(None),
        Some(_) => {}
        None => {
            // An unborn branch over an empty library has nothing to say yet.
            let tree = repo
                .find_tree(tree_id)
                .map_err(git_error("read the tree"))?;
            if tree.is_empty() {
                return Ok(None);
            }
        }
    }

    let tree = repo
        .find_tree(tree_id)
        .map_err(git_error("read the tree"))?;
    let signature = identity(repo)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        &changes.message(),
        &tree,
        &parents,
    )
    .map_err(git_error("commit the library"))?;
    Ok(Some(changes.total().max(1)))
}

/// Fetches the sync branch, returning its tip — or nothing when the remote
/// does not have the branch yet, which is how a fresh repository starts.
fn fetch_branch(
    repo: &Repository,
    branch: &str,
    token: Option<&str>,
) -> Result<Option<Oid>, String> {
    let mut remote = repo
        .find_remote(REMOTE)
        .map_err(|_| NOT_CONFIGURED.to_string())?;

    let wanted = format!("refs/heads/{branch}");
    remote
        .connect_auth(Direction::Fetch, Some(callbacks(token)), None)
        .map_err(|error| format!("Folio could not reach the sync remote: {}", error.message()))?;
    let exists = remote
        .list()
        .map_err(git_error("list the sync remote"))?
        .iter()
        .any(|head| head.name() == wanted);
    let _ = remote.disconnect();
    if !exists {
        return Ok(None);
    }

    let mut options = FetchOptions::new();
    options.remote_callbacks(callbacks(token));
    remote
        .fetch(
            &[format!("+{wanted}:refs/remotes/{REMOTE}/{branch}")],
            Some(&mut options),
            None,
        )
        .map_err(|error| {
            format!(
                "Folio could not fetch from the sync remote: {}",
                error.message()
            )
        })?;

    let fetched = repo
        .find_reference(&format!("refs/remotes/{REMOTE}/{branch}"))
        .map_err(git_error("read what was fetched"))?
        .peel_to_commit()
        .map_err(git_error("read what was fetched"))?;
    Ok(Some(fetched.id()))
}

fn is_ahead(repo: &Repository, branch: &str) -> Result<bool, String> {
    let Some(local) = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .ok()
        .and_then(|reference| reference.target())
    else {
        // An unborn branch has nothing to push.
        return Ok(false);
    };
    let Some(tracked) = repo
        .find_reference(&format!("refs/remotes/{REMOTE}/{branch}"))
        .ok()
        .and_then(|reference| reference.target())
    else {
        return Ok(true);
    };
    let (ahead, _) = repo
        .graph_ahead_behind(local, tracked)
        .map_err(git_error("compare local and remote history"))?;
    Ok(ahead > 0)
}

/// Brings fetched history into the working tree: fast-forward when the local
/// branch has nothing of its own, a merge commit otherwise. Returns whether
/// anything changed.
fn integrate(repo: &Repository, branch: &str, tip: Oid) -> Result<bool, String> {
    let annotated = repo
        .find_annotated_commit(tip)
        .map_err(git_error("read the fetched history"))?;
    let (analysis, _) = repo
        .merge_analysis(&[&annotated])
        .map_err(git_error("compare histories"))?;
    if analysis.is_up_to_date() {
        return Ok(false);
    }

    let refname = format!("refs/heads/{branch}");
    if analysis.is_unborn() || analysis.is_fast_forward() {
        repo.reference(&refname, tip, true, "folio sync: fast-forward")
            .map_err(git_error("advance the local branch"))?;
        repo.set_head(&refname)
            .map_err(git_error("advance the local branch"))?;
        checkout_merged(repo)?;
        return Ok(true);
    }

    let local = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(git_error("read the local history"))?;
    let remote_commit = repo
        .find_commit(tip)
        .map_err(git_error("read the fetched history"))?;
    let tree_id = merged_tree(repo, &local, &remote_commit)?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(git_error("read the merged library"))?;
    let signature = identity(repo)?;
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "Merge changes from the sync remote",
        &tree,
        &[&local, &remote_commit],
    )
    .map_err(git_error("record the merge"))?;
    checkout_merged(repo)?;
    Ok(true)
}

/// Puts the merged history on disk. The tree being checked out was just
/// committed over a clean working tree, so force only applies the merge.
fn checkout_merged(repo: &Repository) -> Result<(), String> {
    repo.checkout_head(Some(CheckoutBuilder::new().force()))
        .map_err(git_error("write the merged pages to disk"))
}

/// The paths of Folio's own bookkeeping files, which merge folder-by-folder
/// rather than line-by-line.
fn library_json_path(name: &str) -> String {
    format!("{LIBRARY_DIRECTORY}/{name}")
}

/// Three-way merges two commits into a tree with every conflict resolved to
/// one file. Page text merges line by line, and where both sides changed the
/// same lines the merged page carries both versions in sequence — the reader
/// tidies prose; nothing is lost and nothing forks. The bookkeeping files
/// merge per folder. Whatever else refuses to merge keeps the side that still
/// has content, ours first: an edit outlives a deletion.
fn merged_tree(
    repo: &Repository,
    local: &git2::Commit,
    remote: &git2::Commit,
) -> Result<Oid, String> {
    let mut plain = repo
        .merge_commits(local, remote, None)
        .map_err(git_error("merge the histories"))?;
    if !plain.has_conflicts() {
        return plain
            .write_tree_to(repo)
            .map_err(git_error("write the merged library"));
    }

    // Which bookkeeping files conflicted, and the three sides of each.
    struct Sides {
        ancestor: Option<Oid>,
        ours: Option<Oid>,
        theirs: Option<Oid>,
    }
    let order_path = library_json_path(ORDER_FILE);
    let icons_path = library_json_path(ICONS_FILE);
    let mut bookkeeping: BTreeMap<String, Sides> = BTreeMap::new();
    for conflict in plain
        .conflicts()
        .map_err(git_error("read the merge conflicts"))?
    {
        let conflict = conflict.map_err(git_error("read the merge conflicts"))?;
        let Some(path) = entry_path(&conflict) else {
            continue;
        };
        if path == order_path || path == icons_path {
            bookkeeping.insert(
                path,
                Sides {
                    ancestor: conflict.ancestor.map(|entry| entry.id),
                    ours: conflict.our.map(|entry| entry.id),
                    theirs: conflict.their.map(|entry| entry.id),
                },
            );
        }
    }

    // The union pass resolves every text conflict to one file holding both
    // sides' lines, no markers. The bookkeeping files come out of it as
    // interleaved JSON, so their entries are replaced with a real merge.
    let mut options = MergeOptions::new();
    options.file_favor(FileFavor::Union);
    let mut index = repo
        .merge_commits(local, remote, Some(&options))
        .map_err(git_error("merge the histories"))?;

    for (path, sides) in bookkeeping {
        let merged = merge_library_json(
            &blob_text(repo, sides.ancestor),
            &blob_text(repo, sides.ours),
            &blob_text(repo, sides.theirs),
        );
        let blob = repo
            .blob(merged.as_bytes())
            .map_err(git_error("write the merged bookkeeping"))?;
        resolve_entry(&mut index, &path, blob)?;
    }

    // Whatever the union pass could not merge — binaries changed on both
    // sides, a page edited here and deleted there — keeps the side that still
    // has content, ours first.
    let leftovers: Vec<(String, Option<IndexEntry>)> = index
        .conflicts()
        .map_err(git_error("read the merge conflicts"))?
        .filter_map(|conflict| conflict.ok())
        .filter_map(|conflict| {
            let path = entry_path(&conflict)?;
            let keep = conflict.our.or(conflict.their);
            Some((path, keep))
        })
        .collect();
    for (path, keep) in leftovers {
        match keep {
            Some(mut entry) => {
                entry.flags &= !INDEX_STAGE_MASK;
                index
                    .conflict_remove(Path::new(&path))
                    .map_err(git_error("resolve a conflict"))?;
                index.add(&entry).map_err(git_error("resolve a conflict"))?;
            }
            None => {
                index
                    .conflict_remove(Path::new(&path))
                    .map_err(git_error("resolve a conflict"))?;
            }
        }
    }

    index
        .write_tree_to(repo)
        .map_err(git_error("write the merged library"))
}

fn entry_path(conflict: &git2::IndexConflict) -> Option<String> {
    let entry = conflict
        .our
        .as_ref()
        .or(conflict.ancestor.as_ref())
        .or(conflict.their.as_ref())?;
    Some(String::from_utf8_lossy(&entry.path).into_owned())
}

fn blob_text(repo: &Repository, id: Option<Oid>) -> String {
    id.and_then(|id| repo.find_blob(id).ok())
        .map(|blob| String::from_utf8_lossy(blob.content()).into_owned())
        .unwrap_or_default()
}

/// Replaces a conflicted path with one resolved blob.
fn resolve_entry(index: &mut Index, path: &str, blob: Oid) -> Result<(), String> {
    index
        .conflict_remove(Path::new(path))
        .map_err(git_error("resolve the bookkeeping"))?;
    index
        .add(&IndexEntry {
            ctime: IndexTime::new(0, 0),
            mtime: IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o100644,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: blob,
            flags: 0,
            flags_extended: 0,
            path: path.as_bytes().to_vec(),
        })
        .map_err(git_error("resolve the bookkeeping"))
}

/// Three-way merges `.folio/order.json` or `.folio/icons.json` folder by
/// folder. Both files are `{ "version": 1, "folders": { path: … } }`, so one
/// merge serves both: a folder only one side touched takes that side's value,
/// and a folder both sides changed keeps this machine's — the arrangement in
/// front of the reader stands. An entry one side edited outlives the other
/// side deleting it. Unreadable input reads as empty, like everywhere else
/// these files are handled.
pub(crate) fn merge_library_json(ancestor: &str, ours: &str, theirs: &str) -> String {
    fn folders(text: &str) -> BTreeMap<String, serde_json::Value> {
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|value| value.get("folders").cloned())
            .and_then(|folders| match folders {
                serde_json::Value::Object(map) => Some(map.into_iter().collect()),
                _ => None,
            })
            .unwrap_or_default()
    }

    let ancestor = folders(ancestor);
    let ours = folders(ours);
    let theirs = folders(theirs);

    let mut keys: Vec<&String> = ancestor
        .keys()
        .chain(ours.keys())
        .chain(theirs.keys())
        .collect();
    keys.sort();
    keys.dedup();

    let mut merged = serde_json::Map::new();
    for key in keys {
        let base = ancestor.get(key);
        let kept = match (ours.get(key), theirs.get(key)) {
            (Some(our), Some(their)) if our == their => Some(our),
            // One side left it alone; the other side's change stands.
            (Some(our), Some(their)) => {
                if Some(our) == base {
                    Some(their)
                } else if Some(their) == base {
                    Some(our)
                } else {
                    // Both changed the same folder: the machine doing the
                    // merge keeps its own arrangement. Deterministic, and the
                    // next sync carries it to the other device.
                    Some(our)
                }
            }
            // Present on one side only: kept when that side added or changed
            // it, dropped when the other side deleted it unchanged — an edit
            // outlives a deletion.
            (Some(our), None) => (Some(our) != base).then_some(our),
            (None, Some(their)) => (Some(their) != base).then_some(their),
            (None, None) => None,
        };
        if let Some(value) = kept {
            merged.insert(key.clone(), value.clone());
        }
    }

    let document = serde_json::json!({ "version": 1, "folders": merged });
    let mut text = serde_json::to_string_pretty(&document)
        .unwrap_or_else(|_| "{\n  \"version\": 1,\n  \"folders\": {}\n}".to_string());
    text.push('\n');
    text
}

enum PushError {
    /// The remote refused the ref — someone pushed first. Retryable.
    Rejected(String),
    /// The push itself failed: network, auth, missing remote.
    Failed(String),
}

fn push_branch(repo: &Repository, branch: &str, token: Option<&str>) -> Result<(), PushError> {
    let mut remote = repo
        .find_remote(REMOTE)
        .map_err(|_| PushError::Failed(NOT_CONFIGURED.to_string()))?;

    let rejection: RefCell<Option<String>> = RefCell::new(None);
    let mut push_callbacks = callbacks(token);
    push_callbacks.push_update_reference(|_reference, status| {
        if let Some(reason) = status {
            *rejection.borrow_mut() = Some(reason.to_string());
        }
        Ok(())
    });
    let mut options = PushOptions::new();
    options.remote_callbacks(push_callbacks);

    remote
        .push(
            &[format!("refs/heads/{branch}:refs/heads/{branch}")],
            Some(&mut options),
        )
        .map_err(|error| {
            PushError::Failed(format!(
                "Folio could not push to the sync remote: {}",
                error.message()
            ))
        })?;

    if let Some(reason) = rejection.take() {
        return Err(PushError::Rejected(reason));
    }

    // Record where the remote branch now stands, so ahead/behind stays honest
    // until the next fetch.
    if let Some(local) = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .ok()
        .and_then(|reference| reference.target())
    {
        let _ = repo.reference(
            &format!("refs/remotes/{REMOTE}/{branch}"),
            local,
            true,
            "folio sync: push",
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_dir(name: &str) -> PathBuf {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory =
            std::env::temp_dir().join(format!("folio-{name}-{}-{sequence}", std::process::id()));
        fs::create_dir_all(&directory).expect("create test directory");
        directory
    }

    fn write(root: &Path, relative: &str, contents: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("parent")).expect("create parents");
        fs::write(path, contents).expect("write file");
    }

    fn read(root: &Path, relative: &str) -> String {
        fs::read_to_string(root.join(relative)).expect("read file")
    }

    /// The regression guard for a silent build-configuration failure: git2
    /// 0.21 defaults to no features, which yields a libgit2 that cannot speak
    /// https or ssh — every remote fails with "there is no TLS stream
    /// available", and nothing in a local-remote test suite notices. Needs no
    /// network, so it runs everywhere the crate is built.
    #[test]
    fn libgit2_is_built_able_to_reach_real_remotes() {
        let version = git2::Version::get();
        assert!(
            version.https(),
            "libgit2 was built without https; sync cannot reach any https remote"
        );
        assert!(
            version.ssh(),
            "libgit2 was built without ssh; sync cannot use an ssh remote or agent"
        );
    }

    /// The other half of shipping a binary that can sync: everything it
    /// links must exist on every Mac. A dependency picked up dynamically from
    /// Homebrew — as libssh2's OpenSSL once was — exists only on machines
    /// that installed it, and the hardened runtime rejects it even there, so
    /// the app dies at launch with "Library not loaded". This test binary
    /// links the same crates the app does, so its own dynamic-library list is
    /// the evidence: system paths only.
    #[cfg(target_os = "macos")]
    #[test]
    fn everything_dynamically_linked_ships_with_the_operating_system() {
        let binary = std::env::current_exe().expect("locate this test binary");
        let listing = std::process::Command::new("otool")
            .arg("-L")
            .arg(&binary)
            .output()
            .expect("run otool");
        let listing = String::from_utf8_lossy(&listing.stdout);
        let foreign: Vec<&str> = listing
            .lines()
            .skip(1) // the binary's own name
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .filter(|line| !line.starts_with("/usr/lib/") && !line.starts_with("/System/"))
            .collect();
        assert!(
            foreign.is_empty(),
            "the binary links libraries that are not part of macOS — \
             the packaged app will fail to launch on other machines \
             (and under the hardened runtime, on this one):\n{}",
            foreign.join("\n")
        );
    }

    /// Proves the TLS path end to end against a real host, which local bare
    /// remotes never exercise. Ignored by default: it needs the network, and
    /// CI should not fail because GitHub is unreachable. Run on demand with
    /// `cargo test --lib -- --ignored reaches_a_real_https_remote`.
    #[test]
    #[ignore = "requires network access to github.com"]
    fn reaches_a_real_https_remote() {
        let base = test_dir("https-reach");
        let repo = Repository::init(&base).expect("init repo");
        // A public repository, read-only and unauthenticated: this is checking
        // that the handshake happens at all, not that credentials work.
        let mut remote = repo
            .remote("probe", "https://github.com/rust-lang/log.git")
            .expect("add remote");
        remote
            .connect_auth(Direction::Fetch, Some(callbacks(None)), None)
            .expect("connect over https");
        let heads = remote.list().expect("list refs");
        assert!(!heads.is_empty(), "a real remote should advertise refs");
        let _ = remote.disconnect();

        drop(remote);
        drop(repo);
        fs::remove_dir_all(base).expect("remove test directory");
    }

    #[test]
    fn bookkeeping_merges_folder_by_folder() {
        let ancestor =
            r#"{ "version": 1, "folders": { "Notes": ["a.md", "b.md"], "Old": ["x.md"] } }"#;
        // This machine reordered Notes and dropped Old.
        let ours = r#"{ "version": 1, "folders": { "Notes": ["b.md", "a.md"] } }"#;
        // The other machine added Research and changed Old.
        let theirs = r#"{ "version": 1, "folders": { "Notes": ["a.md", "b.md"], "Old": ["x.md", "y.md"], "Research": ["r.md"] } }"#;

        let merged = merge_library_json(ancestor, ours, theirs);
        let value: serde_json::Value = serde_json::from_str(&merged).expect("valid JSON");
        let folders = value.get("folders").expect("folders");

        // Ours reordered Notes while theirs left it alone: ours stands.
        assert_eq!(
            folders.get("Notes").expect("Notes"),
            &serde_json::json!(["b.md", "a.md"])
        );
        // Theirs changed Old while ours deleted it: the edit outlives the
        // deletion.
        assert_eq!(
            folders.get("Old").expect("Old"),
            &serde_json::json!(["x.md", "y.md"])
        );
        // A folder only one side knows arrives whole.
        assert_eq!(
            folders.get("Research").expect("Research"),
            &serde_json::json!(["r.md"])
        );
    }

    #[test]
    fn bookkeeping_merge_prefers_this_machine_when_both_changed_a_folder() {
        let ancestor = r#"{ "version": 1, "folders": { "Notes": { "icon": "folder" } } }"#;
        let ours = r#"{ "version": 1, "folders": { "Notes": { "icon": "flask" } } }"#;
        let theirs = r#"{ "version": 1, "folders": { "Notes": { "icon": "star" } } }"#;
        let merged = merge_library_json(ancestor, ours, theirs);
        assert!(merged.contains("flask"), "ours should stand: {merged}");
        assert!(!merged.contains("star"));

        // A deletion beats nothing: both sides dropping a folder drops it.
        let both_dropped = merge_library_json(
            ancestor,
            r#"{"version":1,"folders":{}}"#,
            r#"{"version":1,"folders":{}}"#,
        );
        assert!(!both_dropped.contains("Notes"));

        // Unreadable input reads as empty rather than failing the merge.
        let garbled = merge_library_json("not json", ours, "{");
        assert!(garbled.contains("flask"));
    }

    #[test]
    fn libraries_sync_through_a_shared_remote() {
        let base = test_dir("sync-roundtrip");
        let bare = base.join("remote.git");
        Repository::init_bare(&bare).expect("init bare remote");
        let url = bare.to_str().expect("remote path").to_string();

        // The first machine starts with a page and pushes the library up.
        let a = base.join("a");
        write(&a, "Notes/One.md", "alpha\nshared\nomega\n");
        let outcome = connect(&a, &url, None).expect("connect a");
        assert!(outcome.committed && outcome.pushed, "{}", outcome.summary);

        // The second machine connects an empty folder and pulls it all down.
        let b = base.join("b");
        fs::create_dir_all(&b).expect("create b");
        let outcome = connect(&b, &url, None).expect("connect b");
        assert!(outcome.pulled, "{}", outcome.summary);
        assert_eq!(read(&b, "Notes/One.md"), "alpha\nshared\nomega\n");

        // Both edit the same page on different lines: a line-level merge, no
        // conflict, both edits in the one file everywhere.
        write(&a, "Notes/One.md", "ALPHA\nshared\nomega\n");
        write(&b, "Notes/One.md", "alpha\nshared\nOMEGA\n");
        synchronize(&a, None).expect("sync a");
        synchronize(&b, None).expect("sync b");
        synchronize(&a, None).expect("sync a again");
        assert_eq!(read(&a, "Notes/One.md"), "ALPHA\nshared\nOMEGA\n");
        assert_eq!(read(&b, "Notes/One.md"), read(&a, "Notes/One.md"));

        // Both edit the same line: the union merge keeps both versions in one
        // file — no conflict markers, no second copy of the page.
        write(&a, "Notes/One.md", "line from a\nshared\nOMEGA\n");
        write(&b, "Notes/One.md", "line from b\nshared\nOMEGA\n");
        synchronize(&a, None).expect("sync a");
        synchronize(&b, None).expect("sync b");
        synchronize(&a, None).expect("sync a again");
        let merged = read(&a, "Notes/One.md");
        assert!(merged.contains("line from a"), "{merged}");
        assert!(merged.contains("line from b"), "{merged}");
        assert!(!merged.contains("<<<<<<<"), "{merged}");
        assert_eq!(read(&b, "Notes/One.md"), merged);

        // Both write the bookkeeping: it merges per folder instead of by line.
        write(
            &a,
            ".folio/order.json",
            r#"{ "version": 1, "folders": { "Notes": ["One.md"] } }"#,
        );
        write(
            &b,
            ".folio/order.json",
            r#"{ "version": 1, "folders": { "": ["readme.md"] } }"#,
        );
        synchronize(&a, None).expect("sync a");
        synchronize(&b, None).expect("sync b");
        synchronize(&a, None).expect("sync a again");
        let order: serde_json::Value =
            serde_json::from_str(&read(&a, ".folio/order.json")).expect("valid order");
        assert!(order["folders"].get("Notes").is_some(), "{order}");
        assert!(order["folders"].get("").is_some(), "{order}");
        assert_eq!(read(&b, ".folio/order.json"), read(&a, ".folio/order.json"));

        // Settled: nothing left to commit or push on either machine.
        for root in [&a, &b] {
            let state = status(root).expect("status");
            assert!(state.configured);
            assert_eq!(state.changed_files, 0, "clean tree in {root:?}");
            assert_eq!(state.ahead, 0, "nothing unpushed in {root:?}");
        }

        fs::remove_dir_all(base).expect("remove test directory");
    }
}
