import { invoke, isTauri } from "@tauri-apps/api/core";

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

export function moveNote(
  fromPath: RelativePath,
  toPath: RelativePath,
): Promise<LibrarySnapshot> {
  return invokeNative("move_note", { fromPath, toPath });
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
  write: writeNote,
  move: moveNote,
  rename: renameEntry,
  remove: deleteEntry,
  writeAsset,
  importAssets,
  readAsset,
  renameAsset,
});

export type NativeLibraryBridge = typeof nativeLibrary;
