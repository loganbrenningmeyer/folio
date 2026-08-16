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

export function restoreLibrary(): Promise<LibrarySnapshot | null> {
  return invokeNative("restore_library");
}

export function chooseLibrary(): Promise<LibrarySnapshot | null> {
  return invokeNative("choose_library");
}

export function scanLibrary(): Promise<LibrarySnapshot | null> {
  return invokeNative("scan_library");
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

export const nativeLibrary = Object.freeze({
  isAvailable: isNativeRuntime,
  restore: restoreLibrary,
  choose: chooseLibrary,
  scan: scanLibrary,
  createFolder,
  createNote,
  write: writeNote,
  move: moveNote,
  rename: renameEntry,
  remove: deleteEntry,
  writeAsset,
  importAssets,
  readAsset,
});

export type NativeLibraryBridge = typeof nativeLibrary;
