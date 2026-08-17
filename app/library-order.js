/**
 * A library is a folder of Markdown files, so the pages have no order of their
 * own beyond the alphabet. Dragging a page into place records that choice in
 * `.folio/order.json` beside the pages, as one list of file names per folder:
 *
 *     { "version": 1, "folders": { "": ["intro.md"], "guides": ["setup.md"] } }
 *
 * Nothing is renamed, so links between pages keep working. The file is a
 * preference rather than a source of truth: names it does not mention sort
 * naturally after the ones it does, and names that have left the folder are
 * ignored, so a library edited outside Folio still reads correctly.
 */

export const ORDER_DIRECTORY = ".folio";
export const ORDER_FILE_NAME = "order.json";
export const ORDER_FILE_PATH = `${ORDER_DIRECTORY}/${ORDER_FILE_NAME}`;

const ORDER_VERSION = 1;

/**
 * A folder path (`""` for the library root) mapped to the file names inside it,
 * in the order they should be listed.
 *
 * @typedef {Record<string, string[]>} FolderOrder
 */

/** @param {string} path */
export function parentFolder(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** @param {string} path */
export function fileNameOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * @param {string} left
 * @param {string} right
 */
function naturalCompare(left, right) {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Folio runs on case-insensitive file systems, so a stored name still matches a
 * page whose capitalisation changed elsewhere.
 *
 * @param {string[]} names
 */
function positionsByName(names) {
  const positions = new Map();
  names.forEach((name, index) => {
    const key = name.toLowerCase();
    if (!positions.has(key)) positions.set(key, index);
  });
  return positions;
}

/**
 * Reads the order file. Anything unreadable — absent, truncated, hand-edited
 * into another shape — is treated as "no order recorded", never as an error:
 * the library still opens, just alphabetically.
 *
 * @param {string | null | undefined} text
 * @returns {FolderOrder}
 */
export function parseFolderOrder(text) {
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  const folders =
    parsed && typeof parsed === "object" ? parsed.folders : undefined;
  if (!folders || typeof folders !== "object") return {};

  /** @type {FolderOrder} */
  const order = {};
  for (const [folder, names] of Object.entries(folders)) {
    if (typeof folder !== "string" || !Array.isArray(names)) continue;
    const seen = new Set();
    const cleaned = names.filter((name) => {
      if (typeof name !== "string" || !name || name.includes("/")) return false;
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (cleaned.length) order[folder] = cleaned;
  }
  return order;
}

/**
 * @param {FolderOrder} order
 * @returns {string}
 */
export function serializeFolderOrder(order) {
  const folders = {};
  // Sorted keys keep the file stable in version control between reorders.
  for (const folder of Object.keys(order).sort(naturalCompare)) {
    if (order[folder]?.length) folders[folder] = order[folder];
  }
  return `${JSON.stringify({ version: ORDER_VERSION, folders }, undefined, 2)}\n`;
}

/**
 * Pages the order file names, in that order, followed by everything else in
 * natural order — where a page created outside Folio lands.
 *
 * @template {{ path: string }} T
 * @param {T[]} notes Pages sitting directly in one folder.
 * @param {string[] | undefined} names
 * @returns {T[]}
 */
export function sortFolderNotes(notes, names) {
  if (!names?.length) {
    return [...notes].sort((left, right) =>
      naturalCompare(left.path, right.path),
    );
  }
  const positions = positionsByName(names);
  return [...notes].sort((left, right) => {
    const leftPlace = positions.get(fileNameOf(left.path).toLowerCase());
    const rightPlace = positions.get(fileNameOf(right.path).toLowerCase());
    if (leftPlace !== undefined && rightPlace !== undefined) {
      return leftPlace - rightPlace;
    }
    if (leftPlace !== undefined) return -1;
    if (rightPlace !== undefined) return 1;
    return naturalCompare(left.path, right.path);
  });
}

/**
 * Sorts a whole library: folders keep their natural order relative to each
 * other, and the pages inside each folder follow the order file.
 *
 * @template {{ path: string }} T
 * @param {T[]} notes
 * @param {FolderOrder} order
 * @returns {T[]}
 */
export function sortNotesByOrder(notes, order) {
  /** @type {Map<string, T[]>} */
  const byFolder = new Map();
  for (const note of notes) {
    const folder = parentFolder(note.path);
    const group = byFolder.get(folder);
    if (group) group.push(note);
    else byFolder.set(folder, [note]);
  }
  return Array.from(byFolder.keys())
    .sort(naturalCompare)
    .flatMap((folder) =>
      sortFolderNotes(byFolder.get(folder) ?? [], order[folder]),
    );
}

/**
 * The file names of one folder, in the order they are listed.
 *
 * @template {{ path: string }} T
 * @param {T[]} notes Every page in the library.
 * @param {string} folder
 * @param {FolderOrder} order
 * @returns {string[]}
 */
export function folderNames(notes, folder, order) {
  return sortFolderNotes(
    notes.filter((note) => parentFolder(note.path) === folder),
    order[folder],
  ).map((note) => fileNameOf(note.path));
}

/**
 * Places `name` at `index` in a folder that is currently listed as `names`.
 * `index` counts positions in the list as drawn — including `name` itself when
 * it is already there — which is what a drop between two rows describes.
 *
 * @param {string[]} names
 * @param {string} name
 * @param {number} index
 * @returns {string[]}
 */
export function placedFolderNames(names, name, index) {
  const key = name.toLowerCase();
  const current = names.findIndex((entry) => entry.toLowerCase() === key);
  const rest = names.filter((entry) => entry.toLowerCase() !== key);
  // Removing the page shifts every later position up by one.
  const place = current !== -1 && current < index ? index - 1 : index;
  rest.splice(Math.max(0, Math.min(place, rest.length)), 0, name);
  return rest;
}

/**
 * @param {FolderOrder} order
 * @param {string} folder
 * @param {string[]} names
 * @returns {FolderOrder}
 */
export function withFolderOrder(order, folder, names) {
  const next = { ...order };
  if (names.length) next[folder] = names;
  else delete next[folder];
  return next;
}

/**
 * Follows a rename so the page keeps its place. Renaming a folder rewrites the
 * keys of everything inside it.
 *
 * @param {FolderOrder} order
 * @param {string} fromPath
 * @param {string} toPath
 * @param {boolean} isFolder
 * @returns {FolderOrder}
 */
export function renamedInOrder(order, fromPath, toPath, isFolder) {
  if (!isFolder) {
    const folder = parentFolder(fromPath);
    const names = order[folder];
    if (!names || parentFolder(toPath) !== folder) return order;
    const key = fileNameOf(fromPath).toLowerCase();
    if (!names.some((name) => name.toLowerCase() === key)) return order;
    return withFolderOrder(
      order,
      folder,
      names.map((name) =>
        name.toLowerCase() === key ? fileNameOf(toPath) : name,
      ),
    );
  }

  /** @type {FolderOrder} */
  const next = {};
  for (const [folder, names] of Object.entries(order)) {
    if (folder === fromPath) next[toPath] = names;
    else if (folder.startsWith(`${fromPath}/`)) {
      next[`${toPath}${folder.slice(fromPath.length)}`] = names;
    } else next[folder] = names;
  }
  return next;
}

/**
 * Drops names and folders the library no longer holds, so the file does not
 * collect the leavings of every page ever moved or deleted.
 *
 * @template {{ path: string }} T
 * @param {FolderOrder} order
 * @param {T[]} notes
 * @returns {FolderOrder}
 */
export function prunedOrder(order, notes) {
  /** @type {Map<string, Set<string>>} */
  const present = new Map();
  for (const note of notes) {
    const folder = parentFolder(note.path);
    const names = present.get(folder) ?? new Set();
    names.add(fileNameOf(note.path).toLowerCase());
    present.set(folder, names);
  }

  /** @type {FolderOrder} */
  const next = {};
  for (const [folder, names] of Object.entries(order)) {
    const here = present.get(folder);
    if (!here) continue;
    const kept = names.filter((name) => here.has(name.toLowerCase()));
    if (kept.length) next[folder] = kept;
  }
  return next;
}

/**
 * True for `.folio` and anything else hidden. Folio's own bookkeeping sits in a
 * dot folder, and dot entries are not pages a reader put there.
 *
 * @param {string} name
 */
export function isHiddenEntryName(name) {
  return name.startsWith(".");
}
