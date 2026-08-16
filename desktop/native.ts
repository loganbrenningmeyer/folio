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

export const nativeLibrary = Object.freeze({
  isAvailable: isNativeRuntime,
  restore: restoreLibrary,
  choose: chooseLibrary,
  scan: scanLibrary,
  createFolder,
  createNote,
  write: writeNote,
  move: moveNote,
});

export type NativeLibraryBridge = typeof nativeLibrary;
