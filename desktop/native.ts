import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type RelativePath = string;

export type NoteRecord = {
  id: string;
  path: RelativePath;
  title: string;
  content: string;
};

export type LibrarySnapshot = {
  name: string;
  notes: NoteRecord[];
  folders: RelativePath[];
};

export type RestoredLibrary = {
  snapshot: LibrarySnapshot;
  /** The page open when Folio last closed, when it is still in the library. */
  openNote: RelativePath | null;
};

export type LinkedNote = {
  snapshot: LibrarySnapshot;
  /** The linked page's path inside `snapshot`. */
  path: RelativePath;
  /** True when the library was reopened at a different folder to reach it. */
  rerooted: boolean;
};

/** How the open library stands against its sync remote. */
export type SyncStatus = {
  configured: boolean;
  remote: string | null;
  branch: string | null;
  /** Files changed since the last commit. */
  changedFiles: number;
  /** Commits waiting to be pushed. */
  ahead: number;
  /** Commits fetched but not yet merged. */
  behind: number;
};

/** What one beat of sync actually did, with a sentence saying so. */
export type SyncOutcome = {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  summary: string;
};

export class NativeRuntimeUnavailableError extends Error {
  constructor() {
    super("Folio's native library bridge is unavailable in this runtime.");
    this.name = "NativeRuntimeUnavailableError";
  }
}

export function isNativeRuntime(): boolean {
  return typeof window !== "undefined" && isTauri();
}

let invocationQueue: Promise<void> = Promise.resolve();

async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isNativeRuntime()) {
    throw new NativeRuntimeUnavailableError();
  }

  const invocation = invocationQueue.then(() => invoke<T>(command, args));
  invocationQueue = invocation.then(
    () => undefined,
    () => undefined,
  );
  return invocation;
}

export function restoreLibrary(): Promise<RestoredLibrary | null> {
  return invokeNative("restore_library");
}

/**
 * Puts Folio's window on screen. It starts hidden so the first thing a reader
 * sees is their own theme and library, rather than the starting state repainting
 * into it. Call once that frame is actually on the page.
 */
export function showWindow(): Promise<void> {
  return invokeNative("show_window");
}

/**
 * Records the page to reopen the library at, so Folio comes back where it was
 * left rather than at the library's first page. Null forgets one.
 */
export function rememberOpenNote(path: RelativePath | null): Promise<void> {
  return invokeNative("remember_open_note", { path });
}

export function chooseLibrary(): Promise<LibrarySnapshot | null> {
  return invokeNative("choose_library");
}

export function scanLibrary(): Promise<LibrarySnapshot | null> {
  return invokeNative("scan_library");
}

/**
 * Follows a Markdown link from `notePath` to another Markdown file on disk.
 * `href` is resolved against the linking page's folder, so it may point above
 * the library root; when it does, the library reopens at a folder holding both
 * pages. Resolves to null when the link does not name an existing page.
 */
export function openLinkedNote(
  notePath: RelativePath,
  href: string,
): Promise<LinkedNote | null> {
  return invokeNative("open_linked_note", { notePath, href });
}

export function createFolder(path: RelativePath): Promise<LibrarySnapshot> {
  return invokeNative("create_folder", { path });
}

export function createNote(
  path: RelativePath,
  content: string,
): Promise<LibrarySnapshot> {
  return invokeNative("create_note", { path, content });
}

export function writeNote(
  path: RelativePath,
  content: string,
): Promise<NoteRecord> {
  return invokeNative("write_note", { path, content });
}

/**
 * The library's recorded page order, as stored in `.folio/order.json`, or null
 * when the library has never been reordered. Reading and writing move the file
 * whole; its shape lives in `app/library-order.js`, which the browser build
 * shares.
 */
export function readLibraryOrder(): Promise<string | null> {
  return invokeNative("read_library_order");
}

export function writeLibraryOrder(contents: string): Promise<void> {
  return invokeNative("write_library_order", { contents });
}

/**
 * How the library's folders should be drawn, as stored in `.folio/icons.json`,
 * or null when no folder has been given a look. Read and written whole beside
 * the page order; its shape lives in `app/folder-icons.js`.
 */
export function readLibraryIcons(): Promise<string | null> {
  return invokeNative("read_library_icons");
}

export function writeLibraryIcons(contents: string): Promise<void> {
  return invokeNative("write_library_icons", { contents });
}

/**
 * How the library stands against its sync remote — no network is touched, so
 * the footer and the quit prompt can ask freely.
 */
export function syncStatus(): Promise<SyncStatus> {
  return invokeNative("sync_status");
}

/**
 * Connects the open library to a git remote and runs the first sync. The
 * token, when one is given, stays in Folio's settings on this device.
 */
export function syncConnect(
  remoteUrl: string,
  token: string,
): Promise<SyncOutcome> {
  return invokeNative("sync_connect", { remoteUrl, token: token || null });
}

/**
 * Replaces the stored token for a library that is already connected — one
 * that has expired, or was never recorded because an early sync failed.
 */
export function syncSetToken(token: string): Promise<void> {
  return invokeNative("sync_set_token", { token });
}

/** One beat of sync: commit whatever changed, pull, merge, push. */
export function syncNow(): Promise<SyncOutcome> {
  return invokeNative("sync_now");
}

/** Forgets the sync remote and stored token; history stays in the library. */
export function syncDisconnect(): Promise<void> {
  return invokeNative("sync_disconnect");
}

/**
 * Tells the backend the closing ritual is done — the quit prompt was
 * answered, or there was nothing to ask — and the app may exit.
 */
export function approveClose(): Promise<void> {
  return invokeNative("approve_close");
}

/**
 * Runs `handler` when the reader asks to close Folio — the window button or
 * the application quit, both funnel here. The close is already held; the
 * handler must end with `approveClose` or leave the app open on purpose.
 */
export async function onCloseRequested(
  handler: () => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => undefined;
  return listen("close-requested", () => handler());
}

/**
 * Runs `handler` whenever something outside Folio changes the open library on
 * disk — a sync landing, another editor saving, a file added in the Finder.
 * The backend watches the library folder, filters out Folio's own writes, and
 * reports once per settled burst of changes. Resolves to an unsubscribe
 * function; outside the native runtime nothing ever fires.
 */
export async function onLibraryChanged(
  handler: () => void,
): Promise<() => void> {
  if (!isNativeRuntime()) return () => undefined;
  return listen("library-changed", () => handler());
}

/**
 * Native image picker for a folder's icon, returning the chosen picture as a
 * data URI. Nothing is copied into the library: the renderer scales the
 * picture down to icon size and the small result is what gets stored. Resolves
 * to null when the picker is dismissed.
 */
export function pickIconImage(): Promise<string | null> {
  return invokeNative("pick_icon_image");
}

export function moveNote(
  fromPath: RelativePath,
  toPath: RelativePath,
): Promise<LibrarySnapshot> {
  return invokeNative("move_note", { fromPath, toPath });
}

/** Moves a folder, with everything inside it, under a different parent. */
export function moveFolder(
  fromPath: RelativePath,
  toPath: RelativePath,
): Promise<LibrarySnapshot> {
  return invokeNative("move_folder", { fromPath, toPath });
}

/** Renames a note or folder in place. `name` is a single path segment. */
export function renameEntry(
  path: RelativePath,
  name: string,
  folder: boolean,
): Promise<LibrarySnapshot> {
  return invokeNative("rename_entry", { path, name, folder });
}

/** Moves a note or folder to the Finder trash. */
export function deleteEntry(
  path: RelativePath,
  folder: boolean,
): Promise<LibrarySnapshot> {
  return invokeNative("delete_entry", { path, folder });
}

/** Saves image bytes beside the note; returns the deduplicated file name. */
export function writeAsset(
  notePath: RelativePath,
  fileName: string,
  contentsBase64: string,
): Promise<string> {
  return invokeNative("write_asset", { notePath, fileName, contentsBase64 });
}

/** Native image picker; copies selections beside the note, returns names. */
export function importAssets(notePath: RelativePath): Promise<string[]> {
  return invokeNative("import_assets", { notePath });
}

/** Reads an image referenced by the note, as base64. */
export function readAsset(
  notePath: RelativePath,
  src: string,
): Promise<string> {
  return invokeNative("read_asset", { notePath, src });
}

/**
 * Renames an image where it sits, returning the new file name. The Markdown
 * pointing at it is the caller's to rewrite — pages are edited in the app, so
 * a write from the backend could discard an unsaved edit.
 */
export function renameAsset(
  notePath: RelativePath,
  src: string,
  name: string,
): Promise<string> {
  return invokeNative("rename_asset", { notePath, src, name });
}

export const nativeLibrary = Object.freeze({
  isAvailable: isNativeRuntime,
  restore: restoreLibrary,
  rememberOpenNote,
  showWindow,
  choose: chooseLibrary,
  scan: scanLibrary,
  openLinked: openLinkedNote,
  createFolder,
  createNote,
  readOrder: readLibraryOrder,
  writeOrder: writeLibraryOrder,
  readIcons: readLibraryIcons,
  writeIcons: writeLibraryIcons,
  onChange: onLibraryChanged,
  syncStatus,
  syncConnect,
  syncSetToken,
  syncNow,
  syncDisconnect,
  approveClose,
  onCloseRequested,
  pickIconImage,
  write: writeNote,
  move: moveNote,
  moveFolder,
  rename: renameEntry,
  remove: deleteEntry,
  writeAsset,
  importAssets,
  readAsset,
  renameAsset,
});

export type NativeLibraryBridge = typeof nativeLibrary;
