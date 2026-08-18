/**
 * A folder is a place, and places are told apart by sight faster than by name.
 * Folio records how each folder should look — a built-in mark, a colour, or a
 * picture the reader chose — in `.folio/icons.json` beside the pages:
 *
 *     { "version": 1, "folders": { "guides": { "icon": "compass", "color": "ocean" } } }
 *
 * Like the page order beside it, the file is a preference rather than a source
 * of truth. A folder it does not mention wears the plain folder mark, and a
 * mark it describes in a shape Folio does not know is read as no mark at all,
 * so a library edited elsewhere still opens.
 */

import { ORDER_DIRECTORY } from "./library-order.js";

export const ICONS_FILE_NAME = "icons.json";
export const ICONS_FILE_PATH = `${ORDER_DIRECTORY}/${ICONS_FILE_NAME}`;

const ICONS_VERSION = 1;

/**
 * The marks a folder can wear, in the order the picker lays them out. Ids name
 * the idea rather than the drawing, so the set survives a change of icon set.
 */
export const FOLDER_ICON_IDS = [
  "folder",
  "book",
  "notebook",
  "library",
  "page",
  "news",
  "flask",
  "microscope",
  "atom",
  "telescope",
  "idea",
  "sparkle",
  "compass",
  "map",
  "mountain",
  "leaf",
  "sprout",
  "tree",
  "feather",
  "pen",
  "quote",
  "bookmark",
  "star",
  "heart",
  "briefcase",
  "terminal",
  "music",
  "camera",
  "coffee",
  "rocket",
];

/**
 * Ink for the mark. `default` is the panel's own, so a folder that has only
 * been given a shape still reads as part of the library rather than as
 * something singled out.
 */
export const FOLDER_COLOR_IDS = [
  "default",
  "sage",
  "ocean",
  "plum",
  "rose",
  "clay",
  "amber",
  "slate",
];

/**
 * A picture is stored inline, so one file carries everything a folder's look
 * needs and there are no loose files to go missing. Folio writes a downscaled
 * PNG, which lands far below this; the cap is what keeps a hand-edited or
 * hand-written file from loading a photograph into memory for a 24px mark.
 */
export const MAX_ICON_IMAGE_LENGTH = 400_000;

/**
 * How one folder should be drawn. Every field is optional: `image` wins when it
 * is there, `icon` names a built-in mark, and `color` tints it.
 *
 * @typedef {{ icon?: string, color?: string, image?: string }} FolderIcon
 */

/**
 * A folder path (`""` for the library root) mapped to how it should be drawn.
 *
 * @typedef {Record<string, FolderIcon>} FolderIcons
 */

/** @param {unknown} value */
export function isFolderIconId(value) {
  return typeof value === "string" && FOLDER_ICON_IDS.includes(value);
}

/** @param {unknown} value */
export function isFolderColorId(value) {
  return typeof value === "string" && FOLDER_COLOR_IDS.includes(value);
}

/**
 * True for a picture Folio is willing to draw: an inline image small enough to
 * belong in a preferences file. Anything loaded from elsewhere — a path, a URL,
 * a script — is not a picture the library carries, so it is refused.
 *
 * @param {unknown} value
 */
export function isFolderIconImage(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_ICON_IMAGE_LENGTH &&
    /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
  );
}

/**
 * Keeps only what Folio can draw. A mark left with nothing usable is dropped
 * rather than stored empty, so "no mark recorded" has one representation.
 *
 * @param {unknown} value
 * @returns {FolderIcon | undefined}
 */
export function cleanFolderIcon(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  /** @type {FolderIcon} */
  const mark = {};
  if (isFolderIconId(source.icon)) mark.icon = String(source.icon);
  if (isFolderColorId(source.color) && source.color !== "default") {
    mark.color = String(source.color);
  }
  if (isFolderIconImage(source.image)) mark.image = String(source.image);
  return mark.icon || mark.color || mark.image ? mark : undefined;
}

/**
 * Reads the icons file. Anything unreadable is treated as "no folder has been
 * given a look", never as an error.
 *
 * @param {string | null | undefined} text
 * @returns {FolderIcons}
 */
export function parseFolderIcons(text) {
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

  /** @type {FolderIcons} */
  const icons = {};
  for (const [folder, mark] of Object.entries(folders)) {
    if (typeof folder !== "string") continue;
    const cleaned = cleanFolderIcon(mark);
    if (cleaned) icons[folder] = cleaned;
  }
  return icons;
}

/**
 * @param {FolderIcons} icons
 * @returns {string}
 */
export function serializeFolderIcons(icons) {
  /** @type {FolderIcons} */
  const folders = {};
  // Sorted keys keep the file stable in version control between edits.
  for (const folder of Object.keys(icons).sort((left, right) =>
    left.localeCompare(right, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  )) {
    const cleaned = cleanFolderIcon(icons[folder]);
    if (cleaned) folders[folder] = cleaned;
  }
  return `${JSON.stringify({ version: ICONS_VERSION, folders }, undefined, 2)}\n`;
}

/**
 * Sets — or, given nothing to set, clears — one folder's mark.
 *
 * @param {FolderIcons} icons
 * @param {string} folder
 * @param {FolderIcon | undefined} mark
 * @returns {FolderIcons}
 */
export function withFolderIcon(icons, folder, mark) {
  const next = { ...icons };
  const cleaned = cleanFolderIcon(mark);
  if (cleaned) next[folder] = cleaned;
  else delete next[folder];
  return next;
}

/**
 * Follows a folder rename, so a folder keeps the look its reader gave it.
 * Renaming a folder carries the folders inside it too.
 *
 * @param {FolderIcons} icons
 * @param {string} fromPath
 * @param {string} toPath
 * @returns {FolderIcons}
 */
export function renamedFolderIcons(icons, fromPath, toPath) {
  /** @type {FolderIcons} */
  const next = {};
  for (const [folder, mark] of Object.entries(icons)) {
    if (folder === fromPath) next[toPath] = mark;
    else if (folder.startsWith(`${fromPath}/`)) {
      next[`${toPath}${folder.slice(fromPath.length)}`] = mark;
    } else next[folder] = mark;
  }
  return next;
}

/**
 * Drops folders the library no longer holds, so the file does not collect the
 * leavings of every folder ever renamed or deleted. The library root is always
 * a folder, whether or not it is listed.
 *
 * @param {FolderIcons} icons
 * @param {string[]} folders
 * @returns {FolderIcons}
 */
export function prunedFolderIcons(icons, folders) {
  const present = new Set(["", ...folders]);
  /** @type {FolderIcons} */
  const next = {};
  for (const [folder, mark] of Object.entries(icons)) {
    if (present.has(folder)) next[folder] = mark;
  }
  return next;
}
