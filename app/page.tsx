"use client";

import React, {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { snippet as applyCodeMirrorSnippet } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Prec,
  RangeSetBuilder,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  type KeyBinding,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  alignScrollAnchors,
  extractSearchExcerpts,
  formatShortcut,
  isCommandShortcut,
  isRecordedShortcut,
  mapScrollOffset,
  imageLineText,
  markdownBlockCompletion,
  markdownImageSrc,
  decodeImageSrc,
  noteImageAttachments,
  type NoteLink,
  parseImageTitle,
  renamedImageSrc,
  renameImageInContent,
  resolveNoteLink,
  setPythonFenceRunnable,
  shortcutFromEvent,
  shortcutMatches,
  toCodeMirrorSnippet,
} from "@/app/editor-utils.js";
import {
  type FolderOrder,
  folderNames,
  isHiddenEntryName,
  ORDER_FILE_NAME,
  ORDER_DIRECTORY,
  parseFolderOrder,
  placedFolderNames,
  prunedOrder,
  renamedInOrder,
  serializeFolderOrder,
  sortNotesByOrder,
  withFolderOrder,
} from "@/app/library-order.js";
import {
  FOLDER_COLOR_IDS,
  FOLDER_ICON_IDS,
  type FolderIcon,
  type FolderIcons,
  ICONS_FILE_NAME,
  parseFolderIcons,
  prunedFolderIcons,
  renamedFolderIcons,
  serializeFolderIcons,
  withFolderIcon,
} from "@/app/folder-icons.js";
import {
  editorFolding,
  rememberedFolds,
  rememberFolds,
  restoreFolds,
} from "@/app/editor-folding";
import { editorImages } from "@/app/editor-images";
import {
  imageAltFromName,
  imageFilesFromDataTransfer,
  isDirectImageSrc,
  resolveNoteImage,
  saveNoteImage,
} from "@/app/image-assets";
import {
  isNativeRuntime,
  nativeLibrary,
  type LibrarySnapshot,
  type SyncStatus,
} from "@/desktop/native";
import {
  PythonCodeBlock,
  StaticPythonBlock,
  pythonFenceFromPre,
} from "@/app/python-block";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  ArrowLeft,
  ArrowRight,
  Atom,
  BookOpen,
  Bookmark,
  Briefcase,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Coffee,
  Columns2,
  Command,
  Compass,
  Download,
  Feather,
  FileCode2,
  FilePlus2,
  FileText,
  FlaskConical,
  Folder,
  FolderPlus,
  FolderOpen,
  GitBranch,
  GripVertical,
  Heart,
  ImageIcon,
  ImagePlus,
  Keyboard,
  Leaf,
  Library,
  Lightbulb,
  Link2,
  ListTree,
  Lock,
  LockOpen,
  type LucideIcon,
  // Lucide's Map would shadow the Map constructor this file builds groups with.
  Map as MapMark,
  Menu,
  Microscope,
  Moon,
  Mountain,
  Music,
  Newspaper,
  Notebook,
  PenLine,
  PenTool,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Quote,
  RefreshCw,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Sprout,
  Star,
  Sun,
  Table2,
  Telescope,
  Terminal,
  Trash2,
  TreePine,
  X,
} from "lucide-react";

type WritableLike = {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
};

type FileHandleLike = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
  createWritable?: () => Promise<WritableLike>;
  queryPermission?: (options: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
  requestPermission?: (options: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
};

type DirectoryHandleLike = {
  kind: "directory";
  name: string;
  values: () => AsyncIterableIterator<FileHandleLike | DirectoryHandleLike>;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<DirectoryHandleLike>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileHandleLike>;
  removeEntry: (
    name: string,
    options?: { recursive?: boolean },
  ) => Promise<void>;
  queryPermission?: (options: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
  requestPermission?: (options: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: "read" | "readwrite";
      id?: string;
    }) => Promise<DirectoryHandleLike>;
  }
}

type Note = {
  id: string;
  path: string;
  title: string;
  content: string;
  handle?: FileHandleLike;
};

/** The link kinds that name a page, rather than a place the browser handles. */
type LibraryLink = Exclude<NoteLink, { kind: "external" | "fragment" }>;

type ViewMode = "preview" | "editor" | "split";
type Theme = "light" | "dark";
type CreateKind = "file" | "folder";
type PreferenceTab = "appearance" | "shortcuts" | "snippets" | "sync";
type TextSnippet = {
  id: string;
  name: string;
  shortcut: string;
  template: string;
  enabled: boolean;
};
type StoredSnippetSettings = {
  version: 1;
  snippets: TextSnippet[];
};
type SearchExcerpt = { line: number; text: string };
type SearchResult = {
  note: Note;
  score: number;
  excerpts: SearchExcerpt[];
};
type MarkdownAstNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownAstNode[];
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
};
type NormalizedMarkdown = {
  content: string;
  sourceLines: number[];
};
type ScrollSide = "editor" | "preview";
type SplitScrollMap = {
  editorOffsets: number[];
  previewOffsets: number[];
  // CodeMirror only measures rendered lines and estimates the rest, so the
  // editor's scroll height keeps growing as more of the document is visited.
  // Recording the geometry lets a stale map rebuild itself on the next sync.
  geometry: string;
};
type LibraryScan = { notes: Note[]; folders: string[] };

/**
 * Where a dragged page would land: the folder it would sit in, and the row it
 * would take among the pages already there — counting the rows as drawn, so
 * `index` is the position the insertion line is drawn at.
 */
type DropPlace = { folder: string; index: number };

/** How far the pointer travels before a press on a page row becomes a drag. */
const DRAG_THRESHOLD = 4;
/** How near the panel's edge a drag scrolls the list, and how fast. */
const DRAG_SCROLL_MARGIN = 36;
const DRAG_SCROLL_STEP = 12;
/** How far outside the panel a drag still counts as aimed at the library. */
const DRAG_PANEL_REACH = 40;

const DEFAULT_TEXT_SNIPPETS: TextSnippet[] = [
  {
    id: "equation",
    name: "Equation",
    shortcut: "Ctrl-Shift-e",
    template: String.raw`$$
\begin{equation}
$0
\end{equation}
$$`,
    enabled: true,
  },
  {
    id: "code-block",
    name: "Code block",
    shortcut: "Ctrl-Shift-\\",
    template: ["```$1", "$0", "```"].join("\n"),
    enabled: true,
  },
  {
    id: "python-block",
    name: "Python block",
    shortcut: "Ctrl-Shift-p",
    template: ["```python run", "$0", "```"].join("\n"),
    enabled: true,
  },
];

const APP_SHORTCUT_COMMANDS = [
  {
    id: "find",
    label: "Find a page",
    group: "General",
    defaultShortcut: "Meta-k",
  },
  {
    id: "save",
    label: "Save now",
    group: "General",
    defaultShortcut: "Meta-s",
  },
  {
    id: "sync-commit",
    label: "Commit & sync",
    group: "General",
    defaultShortcut: "Meta-Shift-s",
  },
  {
    id: "previous-page",
    label: "Previous page",
    group: "Navigation",
    defaultShortcut: "Meta-ArrowLeft",
  },
  {
    id: "next-page",
    label: "Next page",
    group: "Navigation",
    defaultShortcut: "Meta-ArrowRight",
  },
  {
    id: "new-file",
    label: "New file",
    group: "Files",
    defaultShortcut: "Meta-n",
  },
  {
    id: "new-folder",
    label: "New folder",
    group: "Files",
    defaultShortcut: "Meta-Shift-n",
  },
  {
    id: "open-folder",
    label: "Open folder",
    group: "Files",
    defaultShortcut: "Meta-o",
  },
  {
    id: "toggle-read-write",
    label: "Toggle Read / Write",
    group: "View",
    defaultShortcut: "Meta-e",
  },
  {
    id: "toggle-split",
    label: "Toggle Split view",
    group: "View",
    defaultShortcut: "Meta-Shift-e",
  },
  {
    id: "toggle-library",
    label: "Toggle library panel",
    group: "View",
    defaultShortcut: "",
  },
  {
    id: "toggle-outline",
    label: "Toggle outline panel",
    group: "View",
    defaultShortcut: "",
  },
] as const;

type AppCommandId = (typeof APP_SHORTCUT_COMMANDS)[number]["id"];
type AppShortcuts = Record<AppCommandId, string>;
type StoredAppShortcutSettings = { version: 1; shortcuts: AppShortcuts };

const EDITOR_BASIC_SETUP = {
  lineNumbers: true,
  drawSelection: true,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
} as const;

const FONT_CHOICES = [
  {
    id: "iowan",
    label: "Iowan Old Style",
    category: "Serif",
    stack: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  },
  {
    id: "new-york",
    label: "New York",
    category: "Serif",
    stack: '"New York", "Iowan Old Style", Georgia, serif',
  },
  {
    id: "charter",
    label: "Charter",
    category: "Serif",
    stack: 'Charter, "Bitstream Charter", Georgia, serif',
  },
  {
    id: "georgia",
    label: "Georgia",
    category: "Serif",
    stack: 'Georgia, "Times New Roman", serif',
  },
  {
    id: "palatino",
    label: "Palatino",
    category: "Serif",
    stack: 'Palatino, "Palatino Linotype", Georgia, serif',
  },
  {
    id: "geist-sans",
    label: "Geist Sans",
    category: "Sans serif",
    stack:
      'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  },
  {
    id: "system",
    label: "System UI",
    category: "Sans serif",
    stack:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
  },
  {
    id: "avenir",
    label: "Avenir Next",
    category: "Sans serif",
    stack: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif',
  },
  {
    id: "helvetica",
    label: "Helvetica Neue",
    category: "Sans serif",
    stack: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    id: "futura",
    label: "Futura",
    category: "Sans serif",
    stack: 'Futura, "Avenir Next", Avenir, sans-serif',
  },
  {
    id: "trebuchet",
    label: "Trebuchet",
    category: "Sans serif",
    stack: '"Trebuchet MS", "Helvetica Neue", sans-serif',
  },
  {
    id: "geist-mono",
    label: "Geist Mono",
    category: "Monospace",
    stack: 'var(--font-geist-mono), "SFMono-Regular", Menlo, monospace',
  },
  {
    id: "sf-mono",
    label: "SF Mono",
    category: "Monospace",
    stack: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace',
  },
  {
    id: "menlo",
    label: "Menlo",
    category: "Monospace",
    stack: 'Menlo, Monaco, "Courier New", monospace',
  },
  {
    id: "monaco",
    label: "Monaco",
    category: "Monospace",
    stack: 'Monaco, Menlo, "Courier New", monospace',
  },
  {
    id: "courier",
    label: "Courier Prime",
    category: "Monospace",
    stack: '"Courier Prime", "Courier New", Courier, monospace',
  },
] as const;

type FontId = (typeof FONT_CHOICES)[number]["id"];
type FontCategory = (typeof FONT_CHOICES)[number]["category"];

const FONT_CATEGORIES: FontCategory[] = ["Serif", "Sans serif", "Monospace"];

function isFontId(value: string | null): value is FontId {
  return FONT_CHOICES.some((font) => font.id === value);
}

function fontStack(id: FontId) {
  return (
    FONT_CHOICES.find((font) => font.id === id)?.stack ?? FONT_CHOICES[0].stack
  );
}

// Notches for the reading-width slider: the widest the page column is allowed
// to get. A pane narrower than the chosen width simply uses what it has, so
// split view degrades to wrapping instead of overflowing.
const READER_WIDTHS = [
  { label: "Narrow", width: 620 },
  { label: "Snug", width: 700 },
  { label: "Default", width: 780 },
  { label: "Roomy", width: 880 },
  { label: "Wide", width: 1000 },
  { label: "Full", width: 1180 },
] as const;

const DEFAULT_READER_WIDTH_INDEX = 2;

function readerWidthIndex(value: string | null) {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 && index < READER_WIDTHS.length
    ? index
    : undefined;
}

/* Ordered around the hue wheel — greens, blues, violets, warms, then the two
   neutrals — so the swatch grid reads as a spectrum rather than a list.
   Swatches are [paper-deep, accent, ink] per mode, matching globals.css. */
const COLOR_PALETTES = [
  {
    id: "sage",
    label: "Sage",
    description: "Greenish gray",
    light: ["#f3f1ea", "#45664e", "#252621"],
    dark: ["#121310", "#8aac90", "#e8e7df"],
  },
  {
    id: "moss",
    label: "Moss",
    description: "Deep forest green",
    light: ["#eef3ea", "#3d6b45", "#1f2620"],
    dark: ["#0f1410", "#7fb488", "#e4ebe2"],
  },
  {
    id: "tide",
    label: "Tide",
    description: "Cool teal",
    light: ["#e8f3f4", "#2c6f75", "#1c2729"],
    dark: ["#0c1416", "#63b7bd", "#dfebec"],
  },
  {
    id: "slate",
    label: "Slate",
    description: "Bluish gray",
    light: ["#edf2f5", "#476d8a", "#20262b"],
    dark: ["#101418", "#7da6c7", "#e6ebee"],
  },
  {
    id: "indigo",
    label: "Indigo",
    description: "Deep blue-violet",
    light: ["#eeeef8", "#4c53a8", "#212431"],
    dark: ["#0f1018", "#8f96e0", "#e5e6f2"],
  },
  {
    id: "plum",
    label: "Plum",
    description: "Muted violet",
    light: ["#f1edf3", "#765d82", "#29232c"],
    dark: ["#121013", "#b293be", "#ebe5ed"],
  },
  {
    id: "rose",
    label: "Rose",
    description: "Soft rosewood",
    light: ["#f7ecee", "#97455c", "#2c2225"],
    dark: ["#140f11", "#d98ba0", "#f0e2e5"],
  },
  {
    id: "clay",
    label: "Clay",
    description: "Warm terracotta",
    light: ["#f5eae1", "#a2542f", "#2d231c"],
    dark: ["#14100d", "#dd8b58", "#f0e3d8"],
  },
  {
    id: "sepia",
    label: "Sepia",
    description: "Warm paper",
    light: ["#f3ecdf", "#876342", "#2b251e"],
    dark: ["#13110e", "#c69a69", "#ece3d4"],
  },
  {
    id: "amber",
    label: "Amber",
    description: "Golden honey",
    light: ["#f5efdd", "#8a6a1f", "#2b2718"],
    dark: ["#13120c", "#d7b45e", "#efe8d2"],
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Neutral gray",
    light: ["#f1f1f1", "#61666b", "#222222"],
    dark: ["#111111", "#a9adb2", "#e8e8e8"],
  },
  {
    id: "contrast",
    label: "Contrast",
    description: "Maximum legibility",
    light: ["#f2f2f2", "#0b4fbe", "#000000"],
    dark: ["#000000", "#79b0ff", "#ffffff"],
  },
] as const;

type PaletteId = (typeof COLOR_PALETTES)[number]["id"];

function isPaletteId(value: string | null): value is PaletteId {
  return COLOR_PALETTES.some((palette) => palette.id === value);
}

function storedPreference(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Unavailable storage simply means nothing was remembered.
    return null;
  }
}

/**
 * Dresses the document in the reader's stored appearance. The desktop renderer
 * calls this before React mounts, so Folio's first frame is already in their
 * theme rather than painting the starting light one and repainting into it.
 * The effects in Home read the same keys and settle on the same values.
 */
export function applyStoredAppearance() {
  const root = document.documentElement;
  const theme = storedPreference("folio-theme");
  root.dataset.theme =
    theme === "light" || theme === "dark"
      ? theme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";

  const palette = storedPreference("folio-color-palette");
  if (isPaletteId(palette)) root.dataset.palette = palette;

  const readerFont = storedPreference("folio-reader-font");
  if (isFontId(readerFont)) {
    root.style.setProperty("--font-reading", fontStack(readerFont));
  }
  const editorFont = storedPreference("folio-editor-font");
  if (isFontId(editorFont)) {
    root.style.setProperty("--font-code", fontStack(editorFont));
  }

  const width = readerWidthIndex(storedPreference("folio-reader-width"));
  if (width !== undefined) {
    root.style.setProperty("--reader-width", `${READER_WIDTHS[width].width}px`);
  }
}

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-./, "math-inline", "math-display"],
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Images pasted in non-native runtimes are embedded as data URIs.
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
    // Wiki links carry their target in a scheme the reading view resolves
    // itself; without this the sanitizer drops the href and the link is dead.
    href: [...(defaultSchema.protocols?.href ?? []), "wiki"],
  },
};

const SAMPLE_NOTES: Note[] = [
  {
    id: "sample-welcome",
    path: "01 Foundations/Welcome.md",
    title: "Welcome to Folio",
    content: `# Welcome to Folio

Folio turns a folder of Markdown files into a calm, connected reading space. Your folders become **sections** and every file becomes a page.

> Your notes stay yours. When you open a folder, Folio reads and saves the Markdown files directly on your device.

## Start here

- Open a folder using the button in the sidebar.
- Move between pages with the page controls or your configured keyboard shortcuts.
- Switch between **Read**, **Write**, and **Split** views.
- Open **Preferences → Keyboard shortcuts** to personalize navigation, file, folder, and view commands.

## Make connections

Link to a page with standard Markdown, like [The shape of good notes](../02 Research/The shape of good notes.md), or use a quick Wiki-style link: [[A small linking practice]].

## A tiny example

\`\`\`markdown
## A useful heading

An idea connected to [[Another page]].
\`\`\`

## Mathematical notes

Inline notation such as $E = mc^2$ stays within the sentence, while display notation gets room to breathe:

$$
\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}
$$

Continue to [[Reading your library]] when you are ready.`,
  },
  {
    id: "sample-reading",
    path: "01 Foundations/Reading your library.md",
    title: "Reading your library",
    content: `# Reading your library

The left sidebar is your library. Folio groups pages by their parent folder and preserves their natural order.

## Page by page

Think of each section as a chapter and each Markdown file as a leaf within it. The previous and next controls create a continuous reading path across folders.

## A useful rhythm

1. Read without interruption.
2. Follow a connection when curiosity calls.
3. Edit the source without leaving the page.
4. Return to the reading path.

The outline on the right follows the headings in your current page. It also surfaces **backlinks**—other pages that point here.

Next: [[The shape of good notes]].`,
  },
  {
    id: "sample-shape",
    path: "02 Research/The shape of good notes.md",
    title: "The shape of good notes",
    content: `# The shape of good notes

Good notes are not simply stored; they are revisited, revised, and connected.

## Keep one idea in focus

A page can be short. A clear title and one developed thought are often more useful than a long document with several unrelated ideas.

## Write for your future self

Include enough context to make the note legible in six months:

| Add | Why it helps |
| --- | --- |
| A precise title | Makes search effortless |
| Source context | Preserves provenance |
| One or two links | Builds a path forward |
| A short conclusion | Captures what changed |

## Let structure emerge

Folders provide a gentle map, while links reveal the routes you actually travel. Use both. See [[A small linking practice]] for a lightweight routine.

- [x] Give the page a useful title
- [x] Connect it to an existing thought
- [ ] Revisit it when the idea changes`,
  },
  {
    id: "sample-linking",
    path: "02 Research/A small linking practice.md",
    title: "A small linking practice",
    content: `# A small linking practice

Links are most useful when they carry a little intent. Instead of linking every shared word, connect pages that genuinely change how one another can be read.

## Three kinds of links

### Extends

The linked page continues the thought with more detail.

### Challenges

The linked page holds a competing interpretation or useful tension.

### Applies

The linked page puts the idea to work in a concrete setting.

## The five-minute habit

At the end of a writing session, ask:

1. What existing page does this extend?
2. What page might challenge it?
3. Where could I apply it?

Return to [[Welcome to Folio]] or continue to [[From notes to insight]].`,
  },
  {
    id: "sample-synthesis",
    path: "03 Synthesis/From notes to insight.md",
    title: "From notes to insight",
    content: `# From notes to insight

Synthesis happens when separate observations begin to form a position you can explain, test, and revise.

## Gather

Bring a handful of related pages into view. Search by language, follow backlinks, and notice which notes repeatedly appear together.

## Compare

Look for agreement, contradiction, and missing context. The goal is not to flatten differences—it is to understand their shape.

## Compose

Write a new page that makes the relationship explicit. Link back to the notes that support it, including [[The shape of good notes]] and [[A small linking practice]].

> A library becomes useful when it helps you produce a thought that was not obvious from any single page.

## Continue the practice

Use [[Questions worth carrying]] as a lightweight closing ritual.`,
  },
  {
    id: "sample-questions",
    path: "03 Synthesis/Questions worth carrying.md",
    title: "Questions worth carrying",
    content: `# Questions worth carrying

A good knowledge practice keeps a few questions open.

## At the end of a page

- What did I understand differently after writing this?
- Which claim still feels too easy?
- What would make this useful to someone else?

## At the end of a section

- Which ideas recur?
- Where do the pages disagree?
- What deserves a page of its own?

## At the end of a project

- What can I now explain clearly?
- What should remain unresolved?
- Where will I begin next time?

That is the whole loop: read, connect, write, and return.`,
  },
  {
    id: "sample-python",
    path: "04 Playground/Interactive Python.md",
    title: "Interactive Python",
    content: `# Interactive Python

Folio can run Python inside a page. Open a fence with \`\` \`\`\`python run \`\` and the block gains a **Run** button in Read view, powered by [Pyodide](https://pyodide.org) — Python compiled to WebAssembly. Everything executes on your device, and the output stays inside the block.

A plain \`\` \`\`\`python \`\` fence stays an ordinary code block. Hover over one in Read view and use **Enable running** to opt it in — Folio adds the \`run\` flag to the fence for you, and the lightning-off button in a runnable block's corner removes it again. Try it on this one:

\`\`\`python
print("This block is just text until you enable it.")
\`\`\`

## Terminal output

The first run downloads the Python runtime, so give it a moment. Printed text appears beneath the code, and the value of the last expression is shown like a notebook.

\`\`\`python run
message = "Hello from Folio"
print(message)
sum(range(10))
\`\`\`

## Plots that live in the page

Scientific packages such as NumPy and Matplotlib are fetched automatically the first time a block imports them. Figures render inside the block and scroll with the document.

\`\`\`python run
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 400)
plt.figure(figsize=(7, 3.2))
plt.plot(x, np.sin(x), label="sin x")
plt.plot(x, np.cos(x), label="cos x", linestyle="--")
plt.legend(loc="upper right")
plt.title("Two waves")
plt.tight_layout()
plt.show()
\`\`\`

## Adjustable knobs

Import \`folio\` to add controls. Move a knob and the block re-runs with the new values.

\`\`\`python run
import numpy as np
import matplotlib.pyplot as plt
from folio import slider, toggle

frequency = slider("frequency", 1, 12, value=3)
amplitude = slider("amplitude", 0.1, 2.0, value=1.0)
grid = toggle("grid", value=True, label="show grid")

x = np.linspace(0, 2 * np.pi, 600)
plt.figure(figsize=(7, 3.2))
plt.plot(x, amplitude * np.sin(frequency * x))
plt.ylim(-2.2, 2.2)
plt.grid(grid, alpha=0.3)
plt.title(f"amplitude {amplitude:g} · frequency {frequency:g}")
plt.tight_layout()
plt.show()
\`\`\`

## Matplotlib widgets

Matplotlib's own \`matplotlib.widgets.Slider\` works too. Its sliders appear as live controls beneath the figure and drive their Python callbacks directly — the block does not re-run, the open figure just updates.

\`\`\`python run
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider

t = np.linspace(0, 20 * np.pi, 2000)
fig, ax = plt.subplots(figsize=(7, 5))
plt.subplots_adjust(bottom=.2)
points = ax.scatter(np.cos(t) * t, np.sin(t) * t, c=t, s=3, cmap="plasma")
ax.axis("equal")
ax.axis("off")

twist = Slider(plt.axes([.2, .07, .6, .04]), "Twist", .1, 3, valinit=1)

def update(value):
    points.set_offsets(np.c_[np.cos(t * value) * t, np.sin(t * value) * t])
    fig.canvas.draw_idle()

twist.on_changed(update)
plt.show()
\`\`\`

Buttons, check boxes, radio buttons, range sliders, and text boxes bridge the same way — their callbacks run on the live figure.

\`\`\`python run
import matplotlib.pyplot as plt
from matplotlib.widgets import Button, CheckButtons, RadioButtons, TextBox

fig, ax = plt.subplots(figsize=(6, 2.4))
ax.axis("off")
message = ax.text(.5, .5, "ready", ha="center", va="center", fontsize=22)

button = Button(plt.axes([.04, .04, .2, .16]), "Bump")
checks = CheckButtons(plt.axes([.3, .02, .2, .2]), ["grid", "trace"], [True, False])
radios = RadioButtons(plt.axes([.55, .02, .18, .2]), ["low", "high"])
box = TextBox(plt.axes([.82, .04, .14, .16]), "say ", initial="hi")

button.on_clicked(lambda event: message.set_text("bumped!"))
checks.on_clicked(lambda label: message.set_text(f"toggled {label}"))
radios.on_clicked(lambda label: message.set_text(f"chose {label}"))
box.on_submit(lambda value: message.set_text(value))
plt.show()
\`\`\`

## Animations

\`matplotlib.animation.FuncAnimation\` runs live: the page pulls frames from the interpreter at the animation's own interval, and the pause control sits right under the figure.

\`\`\`python run
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation

x = np.linspace(0, 4 * np.pi, 500)
fig, ax = plt.subplots(figsize=(7, 3.4))
line, = ax.plot(x, np.sin(x), lw=3)
ax.set_ylim(-1.5, 1.5)

def animate(i):
    line.set_ydata(np.sin(x + i / 10) * np.cos(x / 3 - i / 20))
    line.set_color(plt.cm.plasma((i % 100) / 100))
    return line,

ani = FuncAnimation(fig, animate, interval=30)
plt.show()
\`\`\`

## One session per page

Blocks on the same page share a Python session, so earlier definitions stay available below — run the first block, then this one. The restart button in a block's header clears the session, and the stop button halts a running block if a loop gets away from you.

\`\`\`python run
print(f"The message above was: {message!r}")
\`\`\``,
  },
];

const SAMPLE_FOLDERS = [
  "01 Foundations",
  "02 Research",
  "03 Synthesis",
  "04 Playground",
];

const EMPTY_NOTE: Note = {
  id: "__folio-empty__",
  path: "",
  title: "Your library is ready",
  content: `# Your library is ready

Create a Markdown file from the library panel to start writing. You can also create folders, then drag pages between them to organize your work.`,
};

function cleanTitle(path: string) {
  return (
    path
      .split("/")
      .pop()
      ?.replace(/\.md$/i, "")
      .replace(/^\d+[._ -]*/, "") ?? path
  );
}

function cleanGroup(group: string) {
  return group.replace(/^\d+[._ -]*/, "");
}

function displayGroup(group: string) {
  if (!group) return "Notes";
  return group
    .split("/")
    .map((segment) => cleanGroup(segment))
    .join(" / ");
}

function normalizePath(path: string) {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function parentPath(path: string) {
  const normalized = normalizePath(path);
  return normalized.includes("/")
    ? normalized.slice(0, normalized.lastIndexOf("/"))
    : "";
}

function fileNameFromPath(path: string) {
  return normalizePath(path).split("/").pop() ?? path;
}

function joinPath(parent: string, name: string) {
  return normalizePath(parent ? `${parent}/${name}` : name);
}

/**
 * The folders of a library just opened, all closed but for the one holding the
 * page it opens on. A library of any size reads as a short list of folders,
 * with the reader's own place in it already open.
 */
function foldersClosedAround(
  notes: { path: string }[],
  folders: string[],
  openPath: string | undefined,
) {
  const closed = new Set<string>(["", ...folders]);
  for (const note of notes) closed.add(parentPath(note.path));
  closed.delete(parentPath(openPath ?? ""));
  return closed;
}

function freshDefaultTextSnippets() {
  return DEFAULT_TEXT_SNIPPETS.map((snippet) => ({ ...snippet }));
}

function freshDefaultAppShortcuts() {
  return Object.fromEntries(
    APP_SHORTCUT_COMMANDS.map(({ id, defaultShortcut }) => [
      id,
      defaultShortcut,
    ]),
  ) as AppShortcuts;
}

function parseStoredAppShortcuts(value: string | null) {
  if (!value) return;
  try {
    const stored = JSON.parse(value) as Partial<StoredAppShortcutSettings>;
    if (
      stored.version !== 1 ||
      !stored.shortcuts ||
      typeof stored.shortcuts !== "object"
    ) {
      return;
    }
    const shortcuts = freshDefaultAppShortcuts();
    for (const { id } of APP_SHORTCUT_COMMANDS) {
      const shortcut = stored.shortcuts[id];
      if (
        typeof shortcut === "string" &&
        (!shortcut || isCommandShortcut(shortcut))
      ) {
        shortcuts[id] = shortcut;
      }
    }
    return shortcuts;
  } catch {
    // Invalid local preferences should never prevent the app from opening.
  }
}

function snippetShortcutIssue(
  textSnippet: TextSnippet,
  snippets: TextSnippet[],
  appShortcuts: AppShortcuts,
) {
  if (!textSnippet.shortcut) return "Record a shortcut to enable this snippet.";
  if (
    snippets.some(
      (candidate) =>
        candidate.id !== textSnippet.id &&
        candidate.shortcut.toLowerCase() === textSnippet.shortcut.toLowerCase(),
    )
  ) {
    return "That shortcut is already assigned.";
  }
  const appConflict = APP_SHORTCUT_COMMANDS.find(
    ({ id }) =>
      appShortcuts[id] &&
      appShortcuts[id].toLowerCase() === textSnippet.shortcut.toLowerCase(),
  );
  if (appConflict) return `Already assigned to ${appConflict.label}.`;
}

function appShortcutIssue(
  commandId: AppCommandId,
  appShortcuts: AppShortcuts,
  snippets: TextSnippet[],
) {
  const shortcut = appShortcuts[commandId];
  if (!shortcut) return;
  const commandConflict = APP_SHORTCUT_COMMANDS.find(
    ({ id }) =>
      id !== commandId &&
      appShortcuts[id] &&
      appShortcuts[id].toLowerCase() === shortcut.toLowerCase(),
  );
  if (commandConflict) return `Already assigned to ${commandConflict.label}.`;
  const snippetConflict = snippets.find(
    (textSnippet) =>
      textSnippet.shortcut.toLowerCase() === shortcut.toLowerCase(),
  );
  if (snippetConflict)
    return `Already assigned to ${snippetConflict.name || "a text snippet"}.`;
}

function isTextSnippet(value: unknown): value is TextSnippet {
  if (!value || typeof value !== "object") return false;
  const snippet = value as Partial<TextSnippet>;
  return (
    typeof snippet.id === "string" &&
    typeof snippet.name === "string" &&
    typeof snippet.shortcut === "string" &&
    (!snippet.shortcut || isRecordedShortcut(snippet.shortcut)) &&
    typeof snippet.template === "string" &&
    typeof snippet.enabled === "boolean"
  );
}

function parseStoredTextSnippets(value: string | null) {
  if (!value) return;
  try {
    const stored = JSON.parse(value) as Partial<StoredSnippetSettings>;
    if (
      stored.version === 1 &&
      Array.isArray(stored.snippets) &&
      stored.snippets.every(isTextSnippet)
    ) {
      return stored.snippets;
    }
  } catch {
    // Invalid local preferences should never prevent the editor from opening.
  }
}

function createSnippetExtension(
  snippets: TextSnippet[],
  appShortcuts: AppShortcuts,
): Extension {
  const seen = new Set<string>();
  const appBindings = new Set(
    Object.values(appShortcuts)
      .filter(Boolean)
      .map((shortcut) => shortcut.toLowerCase()),
  );
  const bindings: KeyBinding[] = [];

  for (const textSnippet of snippets) {
    const normalized = textSnippet.shortcut.toLowerCase();
    if (
      !textSnippet.enabled ||
      !textSnippet.template ||
      !isRecordedShortcut(textSnippet.shortcut) ||
      appBindings.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    const insert = applyCodeMirrorSnippet(
      toCodeMirrorSnippet(textSnippet.template),
    );
    bindings.push({
      key: textSnippet.shortcut,
      preventDefault: true,
      stopPropagation: true,
      run(view) {
        const { from, to } = view.state.selection.main;
        insert(view, null, from, to);
        return true;
      },
    });
  }

  return Prec.high(keymap.of(bindings));
}

function highlightSearchText(value: string, query: string): ReactNode {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return value;
  const normalizedValue = value.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = normalizedValue.indexOf(normalizedQuery);

  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(value.slice(cursor, matchIndex));
    const end = matchIndex + normalizedQuery.length;
    parts.push(
      <mark key={`${matchIndex}-${end}`}>{value.slice(matchIndex, end)}</mark>,
    );
    cursor = end;
    matchIndex = normalizedValue.indexOf(normalizedQuery, cursor);
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return parts.length ? parts : value;
}

async function getDirectoryAtPath(
  root: DirectoryHandleLike,
  path: string,
  create = false,
) {
  let directory = root;
  for (const segment of normalizePath(path).split("/").filter(Boolean)) {
    directory = await directory.getDirectoryHandle(segment, { create });
  }
  return directory;
}

async function hasWritePermission(
  handle: Pick<DirectoryHandleLike, "queryPermission" | "requestPermission">,
) {
  const options = { mode: "readwrite" as const };
  if (
    handle.queryPermission &&
    (await handle.queryPermission(options)) === "granted"
  ) {
    return true;
  }
  if (!handle.requestPermission) return true;
  return (await handle.requestPermission(options)) === "granted";
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function withWikiLinks(content: string) {
  return content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_, target, label) => {
      const href = `wiki:${encodeURIComponent(target.trim())}`;
      return `[${(label || target).trim()}](${href})`;
    },
  );
}

function normalizeMathDelimiters(content: string): NormalizedMarkdown {
  let output = "";
  let originalLine = 1;
  const sourceLines = [1];

  const appendUnchanged = (value: string) => {
    output += value;
    for (const character of value) {
      if (character !== "\n") continue;
      originalLine += 1;
      sourceLines.push(originalLine);
    }
  };

  const appendReplacement = (original: string, replacement: string) => {
    const startLine = originalLine;
    const endLine = startLine + (original.match(/\n/g)?.length ?? 0);
    let replacementLine = 0;
    output += replacement;
    for (const character of replacement) {
      if (character !== "\n") continue;
      replacementLine += 1;
      sourceLines.push(Math.min(startLine + replacementLine, endLine));
    }
    originalLine = endLine;
  };

  const appendMath = (value: string) => {
    const pattern = /\\\[([\s\S]*?)\\\]|\\\((.*?)\\\)/g;
    let cursor = 0;
    for (const match of value.matchAll(pattern)) {
      const index = match.index ?? cursor;
      appendUnchanged(value.slice(cursor, index));
      const original = match[0];
      const replacement =
        match[1] !== undefined
          ? `$$\n${match[1].trim()}\n$$`
          : `$${match[2] ?? ""}$`;
      appendReplacement(original, replacement);
      cursor = index + original.length;
    }
    appendUnchanged(value.slice(cursor));
  };

  const fencedCode = /(?:\x60{3}|~{3})[\s\S]*?(?:\x60{3}|~{3})/g;
  let cursor = 0;
  for (const match of content.matchAll(fencedCode)) {
    const index = match.index ?? cursor;
    appendMath(content.slice(cursor, index));
    appendUnchanged(match[0]);
    cursor = index + match[0].length;
  }
  appendMath(content.slice(cursor));

  return { content: output, sourceLines };
}

const SOURCE_LINE_TAGS = new Set([
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "tr",
  "ul",
]);

function nodeClassNames(node: MarkdownAstNode) {
  const className = node.properties?.className;
  if (Array.isArray(className)) return className.map(String);
  if (typeof className === "string") return className.split(/\s+/);
  return [];
}

// Display math reaches this point as <pre><code class="language-math">, since
// sanitizing keeps the language class but drops math-display. Inline math is a
// bare <code> inside a paragraph, which is already anchored, so only the <pre>
// form needs its own anchor.
function isDisplayMath(node: MarkdownAstNode) {
  if (nodeClassNames(node).includes("math-display")) return true;
  return (
    node.tagName === "pre" &&
    (node.children ?? []).some((child) =>
      nodeClassNames(child).some(
        (name) => name === "math-display" || name === "language-math",
      ),
    )
  );
}

function rehypeSourceLines(options?: { sourceLines?: number[] }) {
  const sourceLines = options?.sourceLines ?? [];
  const resolveLine = (parsedLine: number) =>
    sourceLines[parsedLine - 1] ?? parsedLine;

  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.children) {
        node.children = node.children.map((child) => {
          visit(child);
          const parsedLine = child.position?.start?.line;
          // KaTeX swaps the whole math element out for its rendered output, so
          // an anchor set on it would be discarded. Wrap it in a plain block
          // that survives, keeping display math on the scroll-sync map.
          if (child.tagName && parsedLine && isDisplayMath(child)) {
            return {
              type: "element",
              tagName: "div",
              properties: { "data-source-line": resolveLine(parsedLine) },
              children: [child],
            };
          }
          return child;
        });
      }

      const parsedLine = node.position?.start?.line;
      if (node.tagName && parsedLine && SOURCE_LINE_TAGS.has(node.tagName)) {
        node.properties = {
          ...node.properties,
          "data-source-line": resolveLine(parsedLine),
        };
      }
    };
    visit(tree);
  };
}

const INLINE_MATH_PATTERN =
  /(\\\((?:\\.|[^\\\n])*?\\\)|(?<!\\)\$[^$\n]+?(?<!\\)\$)/g;

const codeLineDecoration = Decoration.line({
  attributes: { class: "cm-folio-code-line" },
});
const mathLineDecoration = Decoration.line({
  attributes: { class: "cm-folio-math-line" },
});
const quoteLineDecoration = Decoration.line({
  attributes: { class: "cm-folio-quote-line" },
});
const frontmatterLineDecoration = Decoration.line({
  attributes: { class: "cm-folio-frontmatter-line" },
});
const inlineMathDecoration = Decoration.mark({
  class: "cm-folio-math-inline",
});

function editorDecorations(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  let fenceCharacter: string | undefined;
  let mathCloser: "$$" | "\\]" | undefined;
  let inFrontmatter = false;

  for (
    let lineNumber = 1;
    lineNumber <= view.state.doc.lines;
    lineNumber += 1
  ) {
    const line = view.state.doc.line(lineNumber);
    const trimmed = line.text.trim();

    if (lineNumber === 1 && trimmed === "---") {
      inFrontmatter = true;
      builder.add(line.from, line.from, frontmatterLineDecoration);
      continue;
    }

    if (inFrontmatter) {
      builder.add(line.from, line.from, frontmatterLineDecoration);
      if (trimmed === "---" || trimmed === "...") inFrontmatter = false;
      continue;
    }

    if (fenceCharacter) {
      builder.add(line.from, line.from, codeLineDecoration);
      const closesFence =
        fenceCharacter === "\x60"
          ? /^\s*\x60{3,}\s*$/.test(line.text)
          : /^\s*~{3,}\s*$/.test(line.text);
      if (closesFence) fenceCharacter = undefined;
      continue;
    }

    const fence = line.text.match(/^\s*((?:\x60{3,})|(?:~{3,}))/);
    if (fence) {
      fenceCharacter = fence[1][0];
      builder.add(line.from, line.from, codeLineDecoration);
      continue;
    }

    if (mathCloser) {
      builder.add(line.from, line.from, mathLineDecoration);
      if (line.text.includes(mathCloser)) mathCloser = undefined;
      continue;
    }

    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const opener = trimmed.startsWith("$$") ? "$$" : "\\[";
      const closer = opener === "$$" ? "$$" : "\\]";
      builder.add(line.from, line.from, mathLineDecoration);
      if (!trimmed.slice(opener.length).includes(closer)) mathCloser = closer;
      continue;
    }

    if (/^\s*>/.test(line.text)) {
      builder.add(line.from, line.from, quoteLineDecoration);
      continue;
    }

    INLINE_MATH_PATTERN.lastIndex = 0;
    for (const match of line.text.matchAll(INLINE_MATH_PATTERN)) {
      const start = line.from + (match.index ?? 0);
      builder.add(start, start + match[0].length, inlineMathDecoration);
    }
  }

  return builder.finish();
}

const editorDecorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = editorDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged) this.decorations = editorDecorations(update.view);
    }
  },
  {
    decorations: (value) => value.decorations,
  },
);

const markdownBlockAutoCloseExtension = Prec.high(
  EditorView.inputHandler.of((view, from, to, text, insert) => {
    const selection = view.state.selection;
    if (
      view.compositionStarted ||
      selection.ranges.length !== 1 ||
      !selection.main.empty ||
      selection.main.from !== from ||
      selection.main.to !== to ||
      from !== to
    ) {
      return false;
    }

    const defaultTransaction = insert();
    if (!defaultTransaction.isUserEvent("input.type")) return false;
    const completion = markdownBlockCompletion(
      view.state.doc.toString(),
      from,
      to,
      text,
    );
    if (!completion) return false;

    view.dispatch({
      changes: {
        from: completion.from,
        to: completion.to,
        insert: completion.insert,
      },
      selection: { anchor: completion.anchor },
      scrollIntoView: true,
      annotations: Transaction.userEvent.of("input.type"),
    });
    return true;
  }),
);

function createEditorExtensions(theme: Theme) {
  const dark = theme === "dark";
  const highlightStyle = HighlightStyle.define([
    {
      tag: [
        tags.heading1,
        tags.heading2,
        tags.heading3,
        tags.heading4,
        tags.heading5,
        tags.heading6,
      ],
      color: "var(--syntax-heading)",
    },
    {
      tag: [tags.processingInstruction, tags.meta, tags.punctuation],
      color: "var(--syntax-punctuation)",
    },
    { tag: tags.quote, color: "var(--syntax-quote)" },
    {
      tag: [tags.link, tags.url],
      color: "var(--syntax-link)",
      textDecoration: "underline",
    },
    { tag: tags.monospace, color: "var(--syntax-inline-code)" },
    {
      tag: [tags.emphasis, tags.strong, tags.strikethrough],
      color: "var(--syntax-emphasis)",
    },
    { tag: tags.comment, color: "var(--syntax-comment)" },
    { tag: tags.string, color: "var(--syntax-string)" },
    { tag: tags.number, color: "var(--syntax-number)" },
    {
      tag: [tags.keyword, tags.bool, tags.null, tags.atom],
      color: "var(--syntax-keyword)",
    },
    {
      tag: [tags.typeName, tags.className, tags.namespace, tags.attributeName],
      color: "var(--syntax-type)",
    },
    {
      tag: [
        tags.function(tags.variableName),
        tags.definition(tags.variableName),
      ],
      color: "var(--syntax-function)",
    },
  ]);

  return [
    markdown({ codeLanguages: languages }),
    syntaxHighlighting(highlightStyle),
    editorDecorationPlugin,
    markdownBlockAutoCloseExtension,
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      translate: "no",
      "data-gramm": "false",
      "data-gramm_editor": "false",
      "data-enable-grammarly": "false",
    }),
    EditorView.theme(
      {
        "&": {
          height: "100%",
          backgroundColor: "transparent",
          color: "var(--ink-2)",
          fontSize: "13px",
        },
        "&.cm-focused": { outline: "none" },
        ".cm-scroller": {
          overflow: "auto",
          overflowX: "hidden",
          overscrollBehavior: "contain",
          fontFamily: "var(--font-code)",
          lineHeight: "22px",
          cursor: "text",
        },
        ".cm-content": {
          width: "100%",
          maxWidth: "100%",
          minHeight: "100%",
          padding: "24px 28px 50px",
          caretColor: "var(--accent)",
          cursor: "text",
        },
        ".cm-line": {
          padding: "0",
          cursor: "text",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        },
        ".cm-selectionLayer": {
          zIndex: "3 !important",
          pointerEvents: "none",
        },
        ".cm-cursorLayer": {
          zIndex: "4",
          pointerEvents: "none",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: "var(--accent)",
          borderLeftWidth: "1.5px",
        },
        ".cm-gutters": {
          borderRight: "1px solid var(--line)",
          backgroundColor: "color-mix(in srgb, var(--panel) 60%, transparent)",
          color: "var(--faint)",
          cursor: "default",
        },
        ".cm-lineNumbers .cm-gutterElement": {
          minWidth: "52px",
          padding: "0 12px 0 8px",
          fontSize: "12px",
          lineHeight: "22px",
        },
        ".cm-activeLine, .cm-activeLineGutter": {
          backgroundColor: "transparent",
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: "var(--editor-selection) !important",
          boxShadow: "none",
        },
        ".cm-folio-code-line": {
          backgroundColor: "var(--syntax-code-bg)",
        },
        ".cm-folio-math-line": {
          backgroundColor: "var(--syntax-math-bg)",
          color: "var(--syntax-math)",
        },
        ".cm-folio-math-inline": {
          color: "var(--syntax-math)",
        },
        ".cm-folio-quote-line": {
          backgroundColor: "var(--syntax-quote-bg)",
        },
        ".cm-folio-frontmatter-line": {
          backgroundColor: "var(--syntax-frontmatter-bg)",
        },
      },
      { dark },
    ),
  ];
}
function headingsFrom(content: string) {
  return content
    .split("\n")
    .map((line) => line.match(/^(#{2,3})\s+(.+?)\s*#*$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      depth: match[1].length,
      text: match[2].replace(/[*_`~]/g, ""),
      slug: slugify(match[2].replace(/[*_`~]/g, "")),
    }));
}

// Forward the renderer props (notably data-source-line, which split-view
// scroll sync reads) while replacing the hast node with a heading anchor id.
function markdownHeading<Tag extends "h1" | "h2" | "h3" | "h4">(
  HeadingTag: Tag,
) {
  return function MarkdownHeading({
    node,
    children,
    ...props
  }: React.ComponentPropsWithoutRef<Tag> & { node?: unknown }) {
    void node;
    return (
      <HeadingTag {...props} id={slugify(nodeText(children))}>
        {children}
      </HeadingTag>
    );
  };
}

const MARKDOWN_HEADING_COMPONENTS = {
  h1: markdownHeading("h1"),
  h2: markdownHeading("h2"),
  h3: markdownHeading("h3"),
  h4: markdownHeading("h4"),
};

function nodeText(children: ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      if (React.isValidElement<{ children?: ReactNode }>(child)) {
        return nodeText(child.props.children);
      }
      return "";
    })
    .join("");
}

async function readDirectory(
  directory: DirectoryHandleLike,
  prefix = "",
): Promise<LibraryScan> {
  const notes: Note[] = [];
  const folders: string[] = [];
  for await (const entry of directory.values()) {
    // Hidden entries are not pages a reader put here, and Folio's own `.folio`
    // folder is one of them.
    if (isHiddenEntryName(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      folders.push(path);
      const nested = await readDirectory(entry, path);
      notes.push(...nested.notes);
      folders.push(...nested.folders);
    } else if (/\.md$/i.test(entry.name)) {
      const file = await entry.getFile();
      notes.push({
        id: path,
        path,
        title: cleanTitle(path),
        content: await file.text(),
        handle: entry,
      });
    }
  }
  notes.sort((a, b) =>
    a.path.localeCompare(b.path, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
  folders.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  return { notes, folders };
}

/**
 * One of the files Folio keeps for a library opened in the browser. A library
 * it has never written to has no file, which reads as nothing recorded.
 */
async function readDirectoryFile(
  root: DirectoryHandleLike,
  name: string,
): Promise<string | undefined> {
  try {
    const directory = await root.getDirectoryHandle(ORDER_DIRECTORY);
    const handle = await directory.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch {
    return undefined;
  }
}

async function writeDirectoryFile(
  root: DirectoryHandleLike,
  name: string,
  contents: string,
) {
  const directory = await root.getDirectoryHandle(ORDER_DIRECTORY, {
    create: true,
  });
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable?.();
  if (!writable) throw new Error("This library folder is not writable.");
  await writable.write(contents);
  await writable.close();
}

async function readDirectoryOrder(
  root: DirectoryHandleLike,
): Promise<FolderOrder> {
  return parseFolderOrder(await readDirectoryFile(root, ORDER_FILE_NAME));
}

async function writeDirectoryOrder(
  root: DirectoryHandleLike,
  order: FolderOrder,
) {
  await writeDirectoryFile(
    root,
    ORDER_FILE_NAME,
    serializeFolderOrder(order),
  );
}

async function readDirectoryIcons(
  root: DirectoryHandleLike,
): Promise<FolderIcons> {
  return parseFolderIcons(await readDirectoryFile(root, ICONS_FILE_NAME));
}

async function writeDirectoryIcons(
  root: DirectoryHandleLike,
  icons: FolderIcons,
) {
  await writeDirectoryFile(
    root,
    ICONS_FILE_NAME,
    serializeFolderIcons(icons),
  );
}

// Read view's image renderer. Sizing and alignment arrive as Folio's title
// tokens (see parseImageTitle); library-relative sources resolve through the
// native bridge into blob URLs.
function MarkdownImage({
  notePath,
  src,
  alt,
  title,
}: {
  notePath: string;
  src?: string;
  alt?: string;
  title?: string;
}) {
  const directives = useMemo(() => parseImageTitle(title), [title]);
  const source = src ?? "";
  // Direct sources (data:, blob:, remote, or non-native runtimes) need no
  // asynchronous work; everything else loads through the native bridge.
  const direct = isDirectImageSrc(source) || !isNativeRuntime();
  const key = `${notePath} ${source}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    url?: string;
    missing: boolean;
  }>();

  useEffect(() => {
    if (direct || !source) return undefined;
    let cancelled = false;
    Promise.resolve(resolveNoteImage(notePath, source))
      .then((url) => {
        if (!cancelled) setLoaded({ key, url, missing: false });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ key, missing: true });
      });
    return () => {
      cancelled = true;
    };
  }, [direct, key, notePath, source]);

  // A result for another key is a leftover from the previous image.
  const current = loaded?.key === key ? loaded : undefined;
  const resolved = direct ? source : current?.url;

  if (!source || current?.missing) {
    return (
      <span className="markdown-image-missing">Missing image: {source}</span>
    );
  }
  if (!resolved) {
    return <span className="markdown-image-loading" aria-hidden="true" />;
  }

  // Spans, not <figure>, because react-markdown renders a lone image inside a
  // paragraph and a block element there would be invalid nesting.
  return (
    <span className={`markdown-figure align-${directives.align ?? "left"}`}>
      <img
        src={resolved}
        alt={alt ?? ""}
        className="markdown-image"
        style={
          directives.width ? { width: `${directives.width}px` } : undefined
        }
      />
      {directives.caption && (
        <span className="markdown-caption">{directives.caption}</span>
      )}
    </span>
  );
}

// What the editor's image extension needs to know about the open note. The
// extension is rebuilt when these change (and the editor itself remounts per
// note), so plain captured values stay correct.
type EditorImageContext = {
  notePath: string;
  nativeStore: boolean;
  notice: (message: string) => void;
};

function createEditorImageExtensions(bridge: EditorImageContext): Extension[] {
  return [
    editorImages({
      resolveSrc: (src) => resolveNoteImage(bridge.notePath, src),
    }),
    // Images pasted or dropped into the editor are stored for the note and
    // inserted as Markdown image lines.
    EditorView.domEventHandlers({
      paste: (event, editor) => {
        const files = imageFilesFromDataTransfer(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        void saveImagesIntoView(
          editor,
          editor.state.selection.main.head,
          files,
          bridge.notePath,
          bridge.nativeStore,
          bridge.notice,
        );
        return true;
      },
      drop: (event, editor) => {
        const files = imageFilesFromDataTransfer(event.dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        const pos =
          editor.posAtCoords({ x: event.clientX, y: event.clientY }) ??
          editor.state.selection.main.head;
        void saveImagesIntoView(
          editor,
          pos,
          files,
          bridge.notePath,
          bridge.nativeStore,
          bridge.notice,
        );
        return true;
      },
    }),
  ];
}

// Inserts image lines below the line holding `pos` (or into it when blank).
function insertImageMarkdown(
  view: EditorView,
  pos: number,
  images: { src: string; alt: string }[],
) {
  if (!images.length) return;
  const text = images
    .map((image) => imageLineText({ src: image.src, alt: image.alt }))
    .join("\n");
  const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length));
  const blank = !line.text.trim();
  const change = blank
    ? { from: line.from, to: line.to, insert: text }
    : { from: line.to, to: line.to, insert: `\n${text}` };
  view.dispatch({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
  });
  view.focus();
}

/** A page or folder in the library panel, addressed by its relative path. */
type LibraryEntry = { kind: "note" | "folder"; path: string };

/**
 * An image in the library panel. It takes both halves to name one: the src is
 * written relative to the page that shows it, so the same file reads as
 * `plot.png` under one page and `../figs/plot.png` under another.
 */
type AttachmentEntry = { noteId: string; notePath: string; src: string };

function sameAttachment(
  a: AttachmentEntry | undefined,
  b: AttachmentEntry | undefined,
) {
  return Boolean(a && b && a.noteId === b.noteId && a.src === b.src);
}

/**
 * Where an image src lands inside the library, so references written from
 * different folders can be compared. Undefined for a src that leaves the
 * library, which is not Folio's to rename.
 */
function attachmentPath(notePath: string, src: string) {
  const resolved = resolveNoteLink(notePath, src);
  return resolved.kind === "page" && !resolved.escapes
    ? resolved.path
    : undefined;
}


function sameEntry(a: LibraryEntry | undefined, b: LibraryEntry | undefined) {
  return Boolean(a && b && a.kind === b.kind && a.path === b.path);
}

/** The name shown when renaming: pages drop the extension, folders keep all. */
function entryEditName(entry: LibraryEntry, path: string) {
  const name = fileNameFromPath(path);
  if (entry.kind === "folder") return name;
  return name.replace(/\.md$/i, "");
}

/**
 * Inline rename field, in the shape of the row it replaces. Enter or losing
 * focus commits, Escape abandons — the Finder behaviour.
 */
/**
 * The drawings behind the mark ids in `app/folder-icons.js`. The ids name the
 * idea, so this map is the only place that knows which drawing stands for it.
 */
const FOLDER_MARKS: Record<string, LucideIcon> = {
  folder: Folder,
  book: BookOpen,
  notebook: Notebook,
  library: Library,
  page: FileText,
  news: Newspaper,
  flask: FlaskConical,
  microscope: Microscope,
  atom: Atom,
  telescope: Telescope,
  idea: Lightbulb,
  sparkle: Sparkles,
  compass: Compass,
  map: MapMark,
  mountain: Mountain,
  leaf: Leaf,
  sprout: Sprout,
  tree: TreePine,
  feather: Feather,
  pen: PenTool,
  quote: Quote,
  bookmark: Bookmark,
  star: Star,
  heart: Heart,
  briefcase: Briefcase,
  terminal: Terminal,
  music: Music,
  camera: Camera,
  coffee: Coffee,
  rocket: Rocket,
};

/** Readable names for the marks, so the picker is usable without seeing it. */
const FOLDER_MARK_NAMES: Record<string, string> = {
  folder: "Folder",
  book: "Open book",
  notebook: "Notebook",
  library: "Library",
  page: "Page",
  news: "Newspaper",
  flask: "Flask",
  microscope: "Microscope",
  atom: "Atom",
  telescope: "Telescope",
  idea: "Lightbulb",
  sparkle: "Sparkles",
  compass: "Compass",
  map: "Map",
  mountain: "Mountain",
  leaf: "Leaf",
  sprout: "Sprout",
  tree: "Tree",
  feather: "Feather",
  pen: "Pen",
  quote: "Quotation mark",
  bookmark: "Bookmark",
  star: "Star",
  heart: "Heart",
  briefcase: "Briefcase",
  terminal: "Terminal",
  music: "Music note",
  camera: "Camera",
  coffee: "Coffee",
  rocket: "Rocket",
};

const FOLDER_COLOR_NAMES: Record<string, string> = {
  default: "Default",
  sage: "Sage",
  ocean: "Ocean",
  plum: "Plum",
  rose: "Rose",
  clay: "Clay",
  amber: "Amber",
  slate: "Slate",
};

/**
 * How a folder is drawn: the picture its reader chose, the mark they picked,
 * or — for a folder nobody has dressed — the plain folder it starts as.
 */
function FolderMark({ mark, size = 13 }: { mark?: FolderIcon; size?: number }) {
  if (mark?.image) {
    return <img className="folder-mark-image" src={mark.image} alt="" />;
  }
  const Mark = (mark?.icon && FOLDER_MARKS[mark.icon]) || Folder;
  return <Mark size={size} aria-hidden="true" />;
}

/** The side of the square a chosen picture is cut down to, in pixels. */
const FOLDER_ICON_IMAGE_SIZE = 128;

/**
 * Turns a picture into a mark: the middle square of it, at icon size, so what
 * the library carries is a 24px drawing rather than a photograph. Anything the
 * browser cannot decode is refused here rather than stored and drawn as a gap.
 */
async function folderMarkFromImage(source: string): Promise<string> {
  const picture = new Image();
  picture.src = source;
  try {
    await picture.decode();
  } catch {
    throw new Error("Folio could not read that picture.");
  }
  const side = Math.min(picture.naturalWidth, picture.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = FOLDER_ICON_IMAGE_SIZE;
  canvas.height = FOLDER_ICON_IMAGE_SIZE;
  const context = side ? canvas.getContext("2d") : null;
  if (!context) throw new Error("Folio could not read that picture.");
  context.drawImage(
    picture,
    (picture.naturalWidth - side) / 2,
    (picture.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    FOLDER_ICON_IMAGE_SIZE,
    FOLDER_ICON_IMAGE_SIZE,
  );
  return canvas.toDataURL("image/png");
}

/** Roughly what the picker measures, for keeping it on screen when it opens. */
const FOLDER_ICON_MENU_WIDTH = 246;
const FOLDER_ICON_MENU_HEIGHT = 300;

/**
 * What sits behind a folder's mark: the drawings Folio can make, the inks it
 * makes them in, and a way in for a picture of the reader's own.
 *
 * A picture and a drawing are alternatives — choosing either puts the other
 * away — and ink describes a drawing, so while a folder wears a picture there
 * is no ink to choose and the row says so rather than doing nothing.
 */
function FolderIconPicker({
  name,
  mark,
  at,
  onChoose,
  onChoosePicture,
}: {
  name: string;
  mark: FolderIcon | undefined;
  at: { x: number; y: number };
  onChoose: (mark: FolderIcon | undefined) => void;
  onChoosePicture: () => void;
}) {
  const picture = Boolean(mark?.image);
  return (
    <div
      className="folder-icon-menu"
      role="dialog"
      tabIndex={-1}
      aria-label={`Icon for ${name}`}
      style={{ left: at.x, top: at.y }}
    >
      <div className="folder-icon-head">
        <span data-color={mark?.color}>
          <FolderMark mark={mark} size={12} />
          <strong>{name}</strong>
        </span>
        <button
          type="button"
          className="folder-icon-reset"
          onClick={() => onChoose(undefined)}
          disabled={!mark}
          title="Go back to the plain folder"
        >
          <RotateCcw size={11} aria-hidden="true" />
          <span>Reset</span>
        </button>
      </div>

      <div className="folder-icon-grid" role="group" aria-label="Icons">
        {FOLDER_ICON_IDS.map((id) => {
          const Mark = FOLDER_MARKS[id];
          const chosen = !picture && mark?.icon === id;
          return (
            <button
              key={id}
              type="button"
              className={chosen ? "chosen" : ""}
              data-color={mark?.color}
              aria-label={FOLDER_MARK_NAMES[id] ?? id}
              aria-pressed={chosen}
              title={FOLDER_MARK_NAMES[id] ?? id}
              onClick={() => onChoose({ color: mark?.color, icon: id })}
            >
              <Mark size={14} aria-hidden="true" />
            </button>
          );
        })}
      </div>

      <div
        className="folder-icon-colors"
        role="group"
        aria-label={picture ? "Colours — a picture is not tinted" : "Colours"}
      >
        {FOLDER_COLOR_IDS.map((id) => {
          const chosen = !picture && (mark?.color ?? "default") === id;
          return (
            <button
              key={id}
              type="button"
              className={chosen ? "chosen" : ""}
              data-color={id}
              disabled={picture}
              aria-label={FOLDER_COLOR_NAMES[id] ?? id}
              aria-pressed={chosen}
              title={
                picture
                  ? "A picture is not tinted — choose an icon to use a colour"
                  : (FOLDER_COLOR_NAMES[id] ?? id)
              }
              onClick={() =>
                onChoose({
                  icon: mark?.icon,
                  color: id === "default" ? undefined : id,
                })
              }
            />
          );
        })}
      </div>

      <button
        type="button"
        className="folder-icon-browse"
        onClick={onChoosePicture}
      >
        <ImagePlus size={13} aria-hidden="true" />
        <span>
          {picture ? "Choose another picture…" : "Choose a picture…"}
        </span>
      </button>
    </div>
  );
}

function EntryRenameField({
  className,
  initial,
  onCommit,
  onCancel,
}: {
  className: string;
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const settled = useRef(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.select();
  }, []);
  return (
    <div className={className}>
      <input
        ref={field}
        defaultValue={initial}
        aria-label="New name"
        spellCheck={false}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            settled.current = true;
            onCommit(event.currentTarget.value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            settled.current = true;
            onCancel();
          }
        }}
        onBlur={(event) => {
          if (settled.current) return;
          settled.current = true;
          onCommit(event.currentTarget.value);
        }}
      />
    </div>
  );
}

const TABLE_MAX_COLUMNS = 8;
const TABLE_MAX_ROWS = 8;
const TABLE_FIRST_HEADING = "Column 1";

/** `rows` counts the header, matching what the size picker shows. */
function tableMarkdown(columns: number, rows: number) {
  const headings = Array.from(
    { length: columns },
    (_, index) => `Column ${index + 1}`,
  );
  const blanks = Array.from({ length: columns }, () => "");
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(headings),
    line(Array.from({ length: columns }, () => "---")),
    ...Array.from({ length: Math.max(0, rows - 1) }, () => line(blanks)),
  ].join("\n");
}

/**
 * Inserts a table as its own block. GFM only recognises a table when it starts
 * a block, so a blank line is added on either side when the neighbouring lines
 * have content. The first heading is selected, ready to be typed over.
 */
function insertTableMarkdown(view: EditorView, columns: number, rows: number) {
  const { doc } = view.state;
  const line = doc.lineAt(Math.min(view.state.selection.main.head, doc.length));
  const table = tableMarkdown(columns, rows);
  const blank = !line.text.trim();
  const from = blank ? line.from : line.to;
  const to = line.to;

  // Whatever ends up directly above the table decides how much separation it
  // needs. Landing on a blank line still requires a leading newline when the
  // line above it has content, or the table would be swallowed by that
  // paragraph instead of starting a block of its own.
  const above = blank
    ? line.number > 1
      ? doc.line(line.number - 1)
      : undefined
    : line;
  const leading = above?.text.trim() ? (blank ? "\n" : "\n\n") : "";
  const below = line.number < doc.lines ? doc.line(line.number + 1) : undefined;
  const trailing = below?.text.trim() ? "\n" : "";
  const insert = `${leading}${table}${trailing}`;

  const headingAt = from + insert.indexOf(TABLE_FIRST_HEADING);
  view.dispatch({
    changes: { from, to, insert },
    selection: {
      anchor: headingAt,
      head: headingAt + TABLE_FIRST_HEADING.length,
    },
    scrollIntoView: true,
  });
  view.focus();
}

// Stores each file for the note and inserts the resulting Markdown. Files a
// save rejects are reported and skipped, never blocking the rest.
async function saveImagesIntoView(
  view: EditorView,
  pos: number,
  files: File[],
  notePath: string,
  nativeLibraryOpen: boolean,
  onError: (message: string) => void,
) {
  const images: { src: string; alt: string }[] = [];
  for (const file of files) {
    try {
      const src = await saveNoteImage(notePath, file, nativeLibraryOpen);
      images.push({
        src: markdownImageSrc(src),
        alt: imageAltFromName(file.name || ""),
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  insertImageMarkdown(view, pos, images);
}

export default function Home() {
  // The desktop app opens a real library a moment later, so it starts empty
  // rather than showing someone else's sample pages on the way there. In a
  // browser the sample library is the whole of what there is to read.
  const [storedNotes, setNotes] = useState<Note[]>(() =>
    isNativeRuntime() ? [] : SAMPLE_NOTES,
  );
  const [folders, setFolders] = useState<string[]>(SAMPLE_FOLDERS);
  // A library's own page order, read from `.folio/order.json`. Pages it does
  // not name keep their natural place, so this only ever rearranges what the
  // reader has actually dragged.
  const [noteOrder, setNoteOrder] = useState<FolderOrder>({});
  const notes = useMemo(
    () => sortNotesByOrder(storedNotes, noteOrder),
    [noteOrder, storedNotes],
  );
  const [rootDirectory, setRootDirectory] = useState<DirectoryHandleLike>();
  const [activeId, setActiveId] = useState(() =>
    isNativeRuntime() ? "" : SAMPLE_NOTES[0].id,
  );
  const [libraryName, setLibraryName] = useState(() =>
    isNativeRuntime() ? "" : "The Folio Field Guide",
  );
  const [view, setView] = useState<ViewMode>("preview");
  const [theme, setTheme] = useState<Theme>("light");
  const [palette, setPalette] = useState<PaletteId>("sage");
  const [readerFont, setReaderFont] = useState<FontId>("iowan");
  const [editorFont, setEditorFont] = useState<FontId>("sf-mono");
  const [readerWidth, setReaderWidth] = useState(DEFAULT_READER_WIDTH_INDEX);
  const [appearancePreferencesLoaded, setAppearancePreferencesLoaded] =
    useState(false);
  const [preferenceTab, setPreferenceTab] =
    useState<PreferenceTab>("appearance");
  const [textSnippets, setTextSnippets] = useState<TextSnippet[]>(
    freshDefaultTextSnippets,
  );
  const [snippetPreferencesLoaded, setSnippetPreferencesLoaded] =
    useState(false);
  const [appShortcuts, setAppShortcuts] = useState<AppShortcuts>(
    freshDefaultAppShortcuts,
  );
  const [appShortcutsLoaded, setAppShortcutsLoaded] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [splitScrollLocked, setSplitScrollLocked] = useState(true);
  const [layoutPreferencesLoaded, setLayoutPreferencesLoaded] = useState(false);
  // Whether the first read of the stored library has finished, however it went.
  // Folio's window waits for it, so it opens on the reader's own pages.
  const [librarySettled, setLibrarySettled] = useState(false);
  const [desktopMode] = useState(() => isNativeRuntime());
  const [nativeLibraryOpen, setNativeLibraryOpen] = useState(false);
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  // In a browser the sample library is what is on screen from the first paint,
  // so it opens the way any library does: folded up around the page in front
  // of the reader. The desktop app starts empty and folds its own library up
  // when that arrives.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    isNativeRuntime()
      ? new Set()
      : foldersClosedAround(SAMPLE_NOTES, SAMPLE_FOLDERS, SAMPLE_NOTES[0].path),
  );
  // The panel only lists folders that hold Markdown, so a folder created here
  // would vanish before anything is in it. Those stay listed for the session.
  const [revealedFolders, setRevealedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [expandedAttachments, setExpandedAttachments] = useState<Set<string>>(
    new Set(),
  );
  const [createKind, setCreateKind] = useState<CreateKind>();
  const [newEntryName, setNewEntryName] = useState("");
  const [newEntryParent, setNewEntryParent] = useState("");
  const [draggedNoteId, setDraggedNoteId] = useState<string>();
  // Where the dragged page would land: the folder, and the row it would take.
  const [dropTarget, setDropTarget] = useState<DropPlace>();
  // Explorer selection is separate from the open page: a folder can be
  // selected for rename or delete without being a page you can open.
  const [selectedEntry, setSelectedEntry] = useState<LibraryEntry>();
  const [renamingEntry, setRenamingEntry] = useState<LibraryEntry>();
  const [renamingAttachment, setRenamingAttachment] =
    useState<AttachmentEntry>();
  const [refreshing, setRefreshing] = useState(false);
  const deleteEntryRef = useRef<(entry: LibraryEntry) => void>(() => undefined);
  const [entryMenu, setEntryMenu] = useState<
    (LibraryEntry & { x: number; y: number }) | undefined
  >();
  // How each folder is drawn, and the folder whose picker is open. Both are
  // keyed by folder path, with the library root under the empty string.
  const [folderIcons, setFolderIcons] = useState<FolderIcons>({});
  const [folderIconMenu, setFolderIconMenu] = useState<
    { folder: string; x: number; y: number } | undefined
  >();
  // Sync: how the library stands against its remote, whether a sync is in
  // flight, and the quit prompt (holding how many changes it is asking about).
  const [syncInfo, setSyncInfo] = useState<SyncStatus>();
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [closePrompt, setClosePrompt] = useState<number>();
  const [syncRemoteDraft, setSyncRemoteDraft] = useState("");
  const [syncTokenDraft, setSyncTokenDraft] = useState("");
  const [notice, setNotice] = useState<string>();
  const folderInput = useRef<HTMLInputElement>(null);
  const createNameInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const preferencesTrigger = useRef<HTMLButtonElement>(null);
  const preferencesDialog = useRef<HTMLElement>(null);
  const previewScrollRef = useRef<HTMLElement>(null);
  const markdownBodyRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView>(null);
  const splitScrollMapRef = useRef<SplitScrollMap>();
  const splitScrollFrameRef = useRef<number>();
  const splitScrollGuardFrameRef = useRef<number>();
  const pendingScrollSideRef = useRef<ScrollSide>("editor");
  const lastUserScrollerRef = useRef<ScrollSide>("preview");
  const splitScrollGuardRef = useRef<{ side: ScrollSide; target: number }>();
  const splitScrollEventRef = useRef<(side: ScrollSide) => void>();
  const splitScrollRefreshRef = useRef<(side?: ScrollSide) => void>();
  const splitScrollLockedRef = useRef(splitScrollLocked);
  const viewRef = useRef(view);
  // Drag bookkeeping the panel reads between renders: the scrolling list, the
  // place under the pointer, the ghost that follows it, and the flag that stops
  // the click ending a drag from opening whatever was underneath.
  const pageListRef = useRef<HTMLElement>(null);
  const dragGhostRef = useRef<HTMLDivElement>(null);
  const dropPlace = useRef<DropPlace | undefined>(undefined);
  const dragPointer = useRef({ x: 0, y: 0 });
  const dragScroll = useRef(0);
  const dragScrollFrame = useRef(0);
  const dragScrollArmed = useRef(false);
  const dragEnded = useRef(false);
  const noteOrderRequest = useRef(0);
  const folderIconsRequest = useRef(0);
  const folderIconInput = useRef<HTMLInputElement>(null);
  /** The folder a picture is being chosen for, while the picker is open. */
  const folderIconTarget = useRef<string | undefined>(undefined);
  const nativeSaveTimers = useRef<Map<string, number>>(new Map());
  const nativePendingSaves = useRef<
    Map<string, { path: string; content: string }>
  >(new Map());
  const nativeSavesInFlight = useRef<Map<string, Promise<void>>>(new Map());
  const nativeSavedTimer = useRef<number | undefined>(undefined);
  const nativeWindowClosing = useRef(false);
  const windowShown = useRef(false);
  // The page to reopen this library at, held back from the settings file until
  // reading settles — see flushOpenNote.
  const openNotePending = useRef<string | undefined>(undefined);
  const openNoteWritten = useRef<string | undefined>(undefined);
  const openNoteTimer = useRef<number | undefined>(undefined);
  const activeIdRef = useRef(activeId);
  const lastSingleViewRef = useRef<Exclude<ViewMode, "split">>("preview");
  const imageFileInput = useRef<HTMLInputElement>(null);
  const tableMenu = useRef<HTMLDivElement>(null);
  const tableGrid = useRef<HTMLDivElement>(null);
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  const [tableSize, setTableSize] = useState({ columns: 3, rows: 3 });

  const activeIndex = Math.max(
    0,
    notes.findIndex((note) => note.id === activeId),
  );
  const active = notes[activeIndex] ?? EMPTY_NOTE;
  useEffect(() => {
    splitScrollLockedRef.current = splitScrollLocked;
    viewRef.current = view;
  }, [splitScrollLocked, view]);
  const handleEditorCreate = useCallback((editor: EditorView) => {
    editorViewRef.current = editor;
    editor.scrollDOM.addEventListener("scroll", () => {
      if (editorViewRef.current === editor)
        splitScrollEventRef.current?.("editor");
    });
    splitScrollMapRef.current = undefined;
    splitScrollRefreshRef.current?.("editor");
    restoreFolds(editor, rememberedFolds(activeIdRef.current));
  }, []);
  const handlePreviewScroll = useCallback(() => {
    splitScrollEventRef.current?.("preview");
  }, []);
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? undefined : current));
    }, 3600);
  }, []);
  const imageNotePath = active.id === EMPTY_NOTE.id ? "" : active.path;
  const imageNativeStore = desktopMode && nativeLibraryOpen;
  const editorExtensions = useMemo(
    () => [
      ...createEditorExtensions(theme),
      createSnippetExtension(textSnippets, appShortcuts),
      editorFolding(rememberFolds(activeId)),
      ...createEditorImageExtensions({
        notePath: imageNotePath,
        nativeStore: imageNativeStore,
        notice: showNotice,
      }),
    ],
    [
      activeId,
      appShortcuts,
      imageNativeStore,
      imageNotePath,
      showNotice,
      textSnippets,
      theme,
    ],
  );

  // Images belong to the page whose Markdown points at them, so deleting the
  // reference drops the attachment from the panel with it.
  const attachments = useMemo(() => {
    const byNote = new Map<string, ReturnType<typeof noteImageAttachments>>();
    notes.forEach((note) => {
      const items = noteImageAttachments(note.content);
      if (items.length) byNote.set(note.id, items);
    });
    return byNote;
  }, [notes]);

  // Every folder in the library, including the root, paired with the pages
  // sitting directly inside it. Drop targets need the full list.
  const allGroups = useMemo(() => {
    const groups = new Map<string, Note[]>([
      ["", []],
      ...folders.map((folder): [string, Note[]] => [folder, []]),
    ]);
    notes.forEach((note) => {
      const segments = note.path.split("/");
      const group = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
      groups.set(group, [...(groups.get(group) ?? []), note]);
    });
    return Array.from(groups.entries()).sort(([a], [b]) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
  }, [folders, notes]);

  // Folders without Markdown of their own are noise in a reading sidebar, so
  // they are left out — the library root included, when nothing sits there.
  const grouped = useMemo(
    () =>
      allGroups.filter(
        ([group, groupNotes]) =>
          groupNotes.length > 0 || revealedFolders.has(group),
      ),
    [allGroups, revealedFolders],
  );

  // While a page is being dragged every folder is listed, so an empty folder —
  // or the root, once the last page has moved out of it — stays reachable. The
  // extra sections are appended below the listed ones rather than slotted in
  // alphabetically: appearing in sorted order would push the rows down at the
  // very moment the reader takes hold of one, and pull them back up on the
  // drop. Nothing already visible may move when a drag begins.
  const listedGroups = useMemo(() => {
    if (!draggedNoteId) return grouped;
    const shown = new Set(grouped.map(([group]) => group));
    return [...grouped, ...allGroups.filter(([group]) => !shown.has(group))];
  }, [allGroups, draggedNoteId, grouped]);

  const activeGroupPath = useMemo(() => {
    const segments = active.path.split("/");
    return segments.length > 1 ? segments.slice(0, -1).join("/") : "";
  }, [active.path]);
  const activeSectionIndex = Math.max(
    0,
    grouped.findIndex(([group]) => group === activeGroupPath),
  );
  const activeSectionNotes = grouped[activeSectionIndex]?.[1] ?? [];
  const activeFileIndex = Math.max(
    0,
    activeSectionNotes.findIndex((note) => note.id === active.id),
  );
  // The bar under the toolbar is the page counter drawn wide, so it fills
  // across the folder in hand rather than the whole library.
  const pageProgress = activeSectionNotes.length
    ? ((activeFileIndex + 1) / activeSectionNotes.length) * 100
    : 0;

  const pageHeadings = useMemo(
    () => headingsFrom(active?.content ?? ""),
    [active?.content],
  );

  const backlinks = useMemo(() => {
    if (!active) return [];
    const base =
      active.path.split("/").pop()?.replace(/\.md$/i, "") ?? active.title;
    const needles = [
      `[[${active.title.toLowerCase()}`,
      `[[${base.toLowerCase()}`,
      active.path.toLowerCase(),
    ];
    return notes.filter(
      (note) =>
        note.id !== active.id &&
        needles.some((needle) => note.content.toLowerCase().includes(needle)),
    );
  }, [active, notes]);

  const searchResults = useMemo(() => {
    const query = searchQuery.trim();
    const normalizedQuery = query.toLowerCase();
    if (!normalizedQuery) {
      return notes.map<SearchResult>((note) => ({
        note,
        score: 0,
        excerpts: [],
      }));
    }
    return notes
      .map<SearchResult>((note) => {
        const titleMatch = note.title.toLowerCase().includes(normalizedQuery);
        const pathMatch = note.path.toLowerCase().includes(normalizedQuery);
        const contentMatch = note.content
          .toLowerCase()
          .includes(normalizedQuery);
        const excerpts = contentMatch
          ? extractSearchExcerpts(note.content, query)
          : [];
        return {
          note,
          excerpts,
          score:
            (titleMatch ? 300 : 0) +
            (pathMatch ? 200 : 0) +
            (contentMatch ? 100 : 0) +
            excerpts.length,
        };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [notes, searchQuery]);

  /**
   * Takes a page order as the one in effect. Every change is numbered so a read
   * of the order file that is still in flight when a drag lands cannot arrive
   * afterwards and undo it.
   */
  const applyNoteOrder = useCallback((order: FolderOrder) => {
    noteOrderRequest.current += 1;
    setNoteOrder(order);
  }, []);

  /** Re-reads the order a library records for itself, whenever one opens. */
  const loadNoteOrder = useCallback(
    async (root?: DirectoryHandleLike) => {
      const request = (noteOrderRequest.current += 1);
      let order: FolderOrder = {};
      try {
        if (desktopMode) {
          order = parseFolderOrder(await nativeLibrary.readOrder());
        } else if (root) {
          order = await readDirectoryOrder(root);
        }
      } catch {
        // An unreadable order file is not worth interrupting a reader over:
        // the library simply opens in its natural order.
        order = {};
      }
      if (noteOrderRequest.current === request) setNoteOrder(order);
    },
    [desktopMode],
  );

  /** Re-reads how a library says its folders look, whenever one opens. */
  const loadFolderIcons = useCallback(
    async (root?: DirectoryHandleLike) => {
      const request = (folderIconsRequest.current += 1);
      let icons: FolderIcons = {};
      try {
        if (desktopMode) {
          icons = parseFolderIcons(await nativeLibrary.readIcons());
        } else if (root) icons = await readDirectoryIcons(root);
      } catch {
        // An unreadable icons file is not worth interrupting a reader over:
        // the folders simply wear the plain folder mark.
        icons = {};
      }
      if (folderIconsRequest.current === request) setFolderIcons(icons);
    },
    [desktopMode],
  );

  const applyNativeLibrary = useCallback(
    (
      snapshot: LibrarySnapshot,
      preferredPath?: string,
      // A library being opened, rather than the one in front of the reader
      // changing under them. Only an opening folds the panel up.
      freshLibrary = false,
    ) => {
      setNotes(snapshot.notes);
      setFolders(snapshot.folders);
      setRootDirectory(undefined);
      const preferred = preferredPath
        ? snapshot.notes.find((note) => note.path === preferredPath)
        : undefined;
      const opened = preferred ?? snapshot.notes[0];
      setActiveId(opened?.id ?? "");
      setLibraryName(snapshot.name);
      setNativeLibraryOpen(true);
      setDirty(new Set());
      setCollapsedGroups((current) => {
        // Anything short of an opening is this library changing — a page
        // created, moved, renamed, removed — so what the reader closed stays
        // closed, minus folders that have gone. Either way the folder holding
        // the page now in front of them is open.
        const closed = freshLibrary
          ? foldersClosedAround(snapshot.notes, snapshot.folders, opened?.path)
          : new Set(
              [...current].filter(
                (folder) => !folder || snapshot.folders.includes(folder),
              ),
            );
        closed.delete(parentPath(opened?.path ?? ""));
        return closed;
      });
      setRevealedFolders((current) =>
        current.size
          ? new Set(snapshot.folders.filter((folder) => current.has(folder)))
          : current,
      );
      // The library may have been reopened somewhere else entirely — following
      // a link can reroot it — so its order comes from the folder now open, and
      // the page to reopen at belongs to whichever library is in front of us.
      void loadNoteOrder();
      void loadFolderIcons();
      openNoteWritten.current = undefined;
    },
    [loadFolderIcons, loadNoteOrder],
  );

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    if (view !== "split") lastSingleViewRef.current = view;
  }, [view]);

  useEffect(() => {
    const scrollGeometry = (scroller: HTMLElement, preview: HTMLElement) =>
      [
        scroller.scrollHeight,
        scroller.clientHeight,
        preview.scrollHeight,
        preview.clientHeight,
      ].join(":");

    const buildSplitScrollMap = (): SplitScrollMap | undefined => {
      const editor = editorViewRef.current;
      const preview = previewScrollRef.current;
      const body = markdownBodyRef.current;
      if (!editor || !preview || !body) return undefined;

      const editorOffsets = [0];
      const previewOffsets = [0];
      const previewOrigin =
        preview.getBoundingClientRect().top - preview.scrollTop;
      const lastLine = editor.state.doc.lines;
      const scroller = editor.scrollDOM;

      for (const anchor of body.querySelectorAll<HTMLElement>(
        "[data-source-line]",
      )) {
        const sourceLine = Number(anchor.dataset.sourceLine);
        if (
          !Number.isInteger(sourceLine) ||
          sourceLine < 1 ||
          sourceLine > lastLine
        ) {
          continue;
        }
        const editorOffset =
          editor.documentPadding.top +
          editor.lineBlockAt(editor.state.doc.line(sourceLine).from).top;
        const previewOffset =
          anchor.getBoundingClientRect().top - previewOrigin;
        // Interpolation needs both anchor sequences to increase together, so
        // nested blocks that revisit an earlier source line are skipped.
        if (
          editorOffset <= editorOffsets[editorOffsets.length - 1] ||
          previewOffset <= previewOffsets[previewOffsets.length - 1]
        ) {
          continue;
        }
        editorOffsets.push(editorOffset);
        previewOffsets.push(previewOffset);
      }

      // The scrollable content ends correspond exactly; this pair sits beyond
      // both scroll limits but keeps the interpolation slope truthful through
      // the tail of the document.
      if (
        scroller.scrollHeight > editorOffsets[editorOffsets.length - 1] &&
        preview.scrollHeight > previewOffsets[previewOffsets.length - 1]
      ) {
        editorOffsets.push(scroller.scrollHeight);
        previewOffsets.push(preview.scrollHeight);
      }

      return {
        ...alignScrollAnchors({
          editorOffsets,
          previewOffsets,
          editorLimit: scroller.scrollHeight - scroller.clientHeight,
          previewLimit: preview.scrollHeight - preview.clientHeight,
          rampSpan: scroller.clientHeight,
        }),
        geometry: scrollGeometry(scroller, preview),
      };
    };

    const syncSplitScroll = () => {
      splitScrollFrameRef.current = undefined;
      if (viewRef.current !== "split" || !splitScrollLockedRef.current) return;
      const editor = editorViewRef.current;
      const preview = previewScrollRef.current;
      if (!editor || !preview) return;
      const cached = splitScrollMapRef.current;
      const map =
        cached && cached.geometry === scrollGeometry(editor.scrollDOM, preview)
          ? cached
          : (splitScrollMapRef.current = buildSplitScrollMap());
      if (!map) return;

      const side = pendingScrollSideRef.current;
      const source = side === "editor" ? editor.scrollDOM : preview;
      const target = side === "editor" ? preview : editor.scrollDOM;
      const mapped =
        side === "editor"
          ? mapScrollOffset(
              source.scrollTop,
              map.editorOffsets,
              map.previewOffsets,
            )
          : mapScrollOffset(
              source.scrollTop,
              map.previewOffsets,
              map.editorOffsets,
            );
      const limit = Math.max(0, target.scrollHeight - target.clientHeight);
      const next = Math.min(Math.round(mapped), limit);
      if (Math.abs(target.scrollTop - next) < 1) return;

      // Remember the write so the scroll event it raises on the other pane is
      // not mistaken for user input, which would sync back and stutter.
      splitScrollGuardRef.current = {
        side: side === "editor" ? "preview" : "editor",
        target: next,
      };
      if (splitScrollGuardFrameRef.current !== undefined) {
        window.cancelAnimationFrame(splitScrollGuardFrameRef.current);
      }
      splitScrollGuardFrameRef.current = window.requestAnimationFrame(() => {
        splitScrollGuardFrameRef.current = window.requestAnimationFrame(() => {
          splitScrollGuardFrameRef.current = undefined;
          splitScrollGuardRef.current = undefined;
        });
      });
      target.scrollTo({ top: next, behavior: "instant" });
    };

    const scheduleSplitScrollSync = (side: ScrollSide) => {
      pendingScrollSideRef.current = side;
      if (splitScrollFrameRef.current !== undefined) return;
      splitScrollFrameRef.current =
        window.requestAnimationFrame(syncSplitScroll);
    };

    splitScrollEventRef.current = (side) => {
      if (viewRef.current !== "split") return;
      const guard = splitScrollGuardRef.current;
      if (guard && guard.side === side) {
        splitScrollGuardRef.current = undefined;
        const element =
          side === "editor"
            ? editorViewRef.current?.scrollDOM
            : previewScrollRef.current;
        if (element && Math.abs(element.scrollTop - guard.target) <= 2) return;
      }
      lastUserScrollerRef.current = side;
      if (!splitScrollLockedRef.current) return;
      scheduleSplitScrollSync(side);
    };

    splitScrollRefreshRef.current = (side) => {
      splitScrollMapRef.current = undefined;
      if (viewRef.current !== "split" || !splitScrollLockedRef.current) return;
      if (side) lastUserScrollerRef.current = side;
      scheduleSplitScrollSync(side ?? lastUserScrollerRef.current);
    };

    return () => {
      splitScrollEventRef.current = undefined;
      splitScrollRefreshRef.current = undefined;
      if (splitScrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(splitScrollFrameRef.current);
        splitScrollFrameRef.current = undefined;
      }
      if (splitScrollGuardFrameRef.current !== undefined) {
        window.cancelAnimationFrame(splitScrollGuardFrameRef.current);
        splitScrollGuardFrameRef.current = undefined;
      }
    };
  }, []);

  useEffect(() => {
    if (view !== "split") return;
    splitScrollRefreshRef.current?.("editor");
  }, [active.content, active.id, view]);

  useEffect(() => {
    if (!splitScrollLocked) return;
    splitScrollRefreshRef.current?.();
  }, [splitScrollLocked]);

  useEffect(() => {
    if (view !== "split" || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() =>
      splitScrollRefreshRef.current?.(),
    );
    const preview = previewScrollRef.current;
    const body = markdownBodyRef.current;
    const editor = editorViewRef.current;
    if (preview) observer.observe(preview);
    if (body) observer.observe(body);
    if (editor) {
      observer.observe(editor.scrollDOM);
      observer.observe(editor.contentDOM);
    }
    return () => observer.disconnect();
  }, [active.id, view]);

  useEffect(() => {
    if (!createKind) return;
    const frame = window.requestAnimationFrame(() =>
      createNameInput.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [createKind]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() =>
      searchInput.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (!fontPanelOpen) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : preferencesTrigger.current;
    const frame = window.requestAnimationFrame(() => {
      preferencesDialog.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      previouslyFocused?.focus();
    };
  }, [fontPanelOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedTheme = localStorage.getItem("folio-theme") as Theme | null;
      const preferred = window.matchMedia("(prefers-color-scheme: dark)")
        .matches
        ? "dark"
        : "light";
      const storedPalette = localStorage.getItem("folio-color-palette");
      const storedReaderFont = localStorage.getItem("folio-reader-font");
      const storedEditorFont = localStorage.getItem("folio-editor-font");
      const storedWidth = readerWidthIndex(
        localStorage.getItem("folio-reader-width"),
      );
      setTheme(storedTheme ?? preferred);
      if (isPaletteId(storedPalette)) setPalette(storedPalette);
      if (isFontId(storedReaderFont)) setReaderFont(storedReaderFont);
      if (isFontId(storedEditorFont)) setEditorFont(storedEditorFont);
      if (storedWidth !== undefined) setReaderWidth(storedWidth);
      setAppearancePreferencesLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!appearancePreferencesLoaded) return;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("folio-theme", theme);
  }, [appearancePreferencesLoaded, theme]);

  useEffect(() => {
    if (!appearancePreferencesLoaded) return;
    document.documentElement.dataset.palette = palette;
    localStorage.setItem("folio-color-palette", palette);
  }, [appearancePreferencesLoaded, palette]);

  useEffect(() => {
    if (!appearancePreferencesLoaded) return;
    document.documentElement.style.setProperty(
      "--font-reading",
      fontStack(readerFont),
    );
    document.documentElement.style.setProperty(
      "--font-code",
      fontStack(editorFont),
    );
    localStorage.setItem("folio-reader-font", readerFont);
    localStorage.setItem("folio-editor-font", editorFont);
  }, [appearancePreferencesLoaded, editorFont, readerFont]);

  useEffect(() => {
    if (!appearancePreferencesLoaded) return;
    document.documentElement.style.setProperty(
      "--reader-width",
      `${READER_WIDTHS[readerWidth].width}px`,
    );
    localStorage.setItem("folio-reader-width", String(readerWidth));
  }, [appearancePreferencesLoaded, readerWidth]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = parseStoredTextSnippets(
        localStorage.getItem("folio-snippet-shortcuts"),
      );
      if (stored) setTextSnippets(stored);
      setSnippetPreferencesLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!snippetPreferencesLoaded) return;
    const stored: StoredSnippetSettings = {
      version: 1,
      snippets: textSnippets,
    };
    try {
      localStorage.setItem("folio-snippet-shortcuts", JSON.stringify(stored));
    } catch {
      // The shortcuts remain active for this session when storage is unavailable.
    }
  }, [snippetPreferencesLoaded, textSnippets]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = parseStoredAppShortcuts(
        localStorage.getItem("folio-app-shortcuts"),
      );
      if (stored) setAppShortcuts(stored);
      setAppShortcutsLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!appShortcutsLoaded) return;
    const stored: StoredAppShortcutSettings = {
      version: 1,
      shortcuts: appShortcuts,
    };
    try {
      localStorage.setItem("folio-app-shortcuts", JSON.stringify(stored));
    } catch {
      // The shortcuts remain active for this session when storage is unavailable.
    }
  }, [appShortcuts, appShortcutsLoaded]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLibraryCollapsed(
        localStorage.getItem("folio-library-collapsed") === "true",
      );
      setOutlineCollapsed(
        localStorage.getItem("folio-outline-collapsed") === "true",
      );
      setSplitScrollLocked(
        localStorage.getItem("folio-split-scroll-locked") !== "false",
      );
      setLayoutPreferencesLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!layoutPreferencesLoaded) return;
    localStorage.setItem("folio-library-collapsed", String(libraryCollapsed));
    localStorage.setItem("folio-outline-collapsed", String(outlineCollapsed));
    localStorage.setItem(
      "folio-split-scroll-locked",
      String(splitScrollLocked),
    );
  }, [
    layoutPreferencesLoaded,
    libraryCollapsed,
    outlineCollapsed,
    splitScrollLocked,
  ]);

  /** Folio's built-in guide, which stands in for a library there isn't one. */
  const showSampleLibrary = useCallback(() => {
    setNotes(SAMPLE_NOTES);
    setFolders(SAMPLE_FOLDERS);
    setActiveId(SAMPLE_NOTES[0].id);
    setCollapsedGroups(
      foldersClosedAround(SAMPLE_NOTES, SAMPLE_FOLDERS, SAMPLE_NOTES[0].path),
    );
    setLibraryName("The Folio Field Guide");
  }, []);

  useEffect(() => {
    if (!desktopMode) return;
    let cancelled = false;

    void (async () => {
      try {
        const restored = await nativeLibrary.restore();
        if (!cancelled && restored) {
          // Reopen at the page this library was left on, when it is still
          // there; applyNativeLibrary falls back to the first page otherwise.
          applyNativeLibrary(
            restored.snapshot,
            restored.openNote ?? undefined,
            true,
          );
        } else if (!cancelled) {
          // Nothing to reopen: this is a first launch, and Folio's own guide is
          // what there is to read until a folder is chosen. It is put in place
          // here rather than held as the starting state, so a reader who does
          // have a library never sees it on the way to their own pages.
          showSampleLibrary();
          const message =
            "Choose a Markdown folder when you're ready to open your library.";
          setNotice(message);
          window.setTimeout(
            () =>
              setNotice((current) =>
                current === message ? undefined : current,
              ),
            4800,
          );
        }
      } catch {
        if (cancelled) {
          return;
        }
        showSampleLibrary();
        const message =
          "Folio could not reopen that folder. Choose it again to reconnect.";
        setNotice(message);
        window.setTimeout(
          () =>
            setNotice((current) => (current === message ? undefined : current)),
          4800,
        );
      } finally {
        // Whatever came of it — a library, no library, or a folder Folio could
        // not read — this is as settled as the first screen gets.
        if (!cancelled) setLibrarySettled(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyNativeLibrary, desktopMode, showSampleLibrary]);

  /**
   * Folio's window opens hidden, so the first thing on screen is the reader's
   * own theme and their own library — not the starting state repainting into
   * them. It is shown once the stored appearance and layout have been applied
   * and the library has been read, and only after the browser has painted that
   * frame: one frame to schedule the paint, the next to run after it.
   */
  useEffect(() => {
    if (!desktopMode || windowShown.current) return undefined;
    if (!appearancePreferencesLoaded || !layoutPreferencesLoaded) {
      return undefined;
    }
    if (!librarySettled) return undefined;

    windowShown.current = true;
    // Not on an animation frame: a hidden window paints nothing, so those
    // callbacks never run and the window would only ever appear by way of the
    // backstop in the Rust side. This effect already runs after React has put
    // the library and the theme into the document.
    void nativeLibrary.showWindow().catch(() => undefined);
    return undefined;
  }, [
    appearancePreferencesLoaded,
    desktopMode,
    layoutPreferencesLoaded,
    librarySettled,
  ]);

  // The Insert-image button: native runtimes copy files through the system
  // picker; elsewhere a hidden file input embeds the selection as data URIs.
  const insertImagesFromPicker = useCallback(async () => {
    const editor = editorViewRef.current;
    if (!editor) return;
    if (desktopMode && nativeLibraryOpen && active.id !== EMPTY_NOTE.id) {
      try {
        const names = await nativeLibrary.importAssets(active.path);
        insertImageMarkdown(
          editor,
          editor.state.selection.main.head,
          names.map((name) => ({
            src: markdownImageSrc(name),
            alt: imageAltFromName(name),
          })),
        );
      } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error));
      }
    } else {
      imageFileInput.current?.click();
    }
  }, [active.id, active.path, desktopMode, nativeLibraryOpen, showNotice]);

  /**
   * Records how the folders look. The look belongs to the library, so it is
   * written beside the pages — a sample library has no folder on disk to
   * write to, and there a mark is simply how this session's panel looks.
   */
  const saveFolderIcons = useCallback(
    async (icons: FolderIcons) => {
      folderIconsRequest.current += 1;
      setFolderIcons(icons);
      try {
        if (desktopMode) {
          if (!nativeLibraryOpen) return;
          await nativeLibrary.writeIcons(serializeFolderIcons(icons));
        } else if (rootDirectory) {
          await writeDirectoryIcons(rootDirectory, icons);
        }
      } catch {
        showNotice("Folio could not save this icon to the library folder.");
      }
    },
    [desktopMode, nativeLibraryOpen, rootDirectory, showNotice],
  );

  /** Gives a folder a mark, or — given nothing to give — takes one off. */
  const setFolderIcon = useCallback(
    (folder: string, mark: FolderIcon | undefined) => {
      void saveFolderIcons(withFolderIcon(folderIcons, folder, mark));
    },
    [folderIcons, saveFolderIcons],
  );

  /**
   * The Choose-a-picture button: native runtimes read the file through the
   * system picker; elsewhere a hidden file input reads the selection. Either
   * way only the scaled-down mark is kept, never the file itself.
   */
  const chooseFolderPicture = useCallback(
    async (folder: string) => {
      if (desktopMode) {
        try {
          const picked = await nativeLibrary.pickIconImage();
          if (!picked) return;
          setFolderIcon(folder, { image: await folderMarkFromImage(picked) });
        } catch (error) {
          showNotice(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      folderIconTarget.current = folder;
      folderIconInput.current?.click();
    },
    [desktopMode, setFolderIcon, showNotice],
  );

  const handleFolderPicturePick = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    const folder = folderIconTarget.current;
    event.target.value = "";
    folderIconTarget.current = undefined;
    if (!file || folder === undefined) return;
    const source = URL.createObjectURL(file);
    try {
      setFolderIcon(folder, { image: await folderMarkFromImage(source) });
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      URL.revokeObjectURL(source);
    }
  };

  /**
   * Opens the picker under the mark it belongs to, folded up onto it when
   * there is no room below — a folder near the bottom of a long library still
   * gets a picker a reader can see all of.
   */
  const openFolderIconMenu = (event: React.MouseEvent, folder: string) => {
    event.preventDefault();
    event.stopPropagation();
    setEntryMenu(undefined);
    const mark = event.currentTarget.getBoundingClientRect();
    const below = mark.bottom + 6;
    setFolderIconMenu({
      folder,
      x: Math.max(
        8,
        Math.min(mark.left, window.innerWidth - FOLDER_ICON_MENU_WIDTH - 8),
      ),
      y:
        below + FOLDER_ICON_MENU_HEIGHT > window.innerHeight
          ? Math.max(8, mark.top - 6 - FOLDER_ICON_MENU_HEIGHT)
          : below,
    });
  };

  // The icon picker dismisses like the entry menu, and for the same reason:
  // it describes one folder, and a panel that has scrolled or a click
  // elsewhere means the reader has moved on to something else.
  useEffect(() => {
    if (!folderIconMenu) return undefined;
    const close = () => setFolderIconMenu(undefined);
    // Anything happening inside the picker is the reader using it.
    const closeFromOutside = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".folder-icon-menu")) return;
      close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", closeFromOutside);
    document.addEventListener("scroll", closeFromOutside, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", closeFromOutside);
      document.removeEventListener("scroll", closeFromOutside, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [folderIconMenu]);

  // Finder's keys for the selected library entry. Bound at the document
  // rather than the panel because opening a page moves focus out of the
  // library, which would leave a panel-level handler unreachable. Typing
  // targets are excluded so these never fire while writing.
  useEffect(() => {
    if (!selectedEntry || renamingEntry) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (fontPanelOpen || searchOpen || createKind || entryMenu) return;
      if (folderIconMenu) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest?.(
          "input, textarea, select, [contenteditable='true'], .cm-editor",
        )
      ) {
        return;
      }
      if (
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        setRenamingEntry(selectedEntry);
      } else if (
        (event.key === "Backspace" || event.key === "Delete") &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        deleteEntryRef.current(selectedEntry);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    createKind,
    entryMenu,
    folderIconMenu,
    fontPanelOpen,
    renamingEntry,
    searchOpen,
    selectedEntry,
  ]);

  // The entry menu dismisses like any context menu.
  useEffect(() => {
    if (!entryMenu) return undefined;
    const close = () => setEntryMenu(undefined);
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [entryMenu]);

  // The size picker closes on Escape or a click elsewhere, like a menu.
  useEffect(() => {
    if (!tableMenuOpen) return undefined;
    const onPointerDown = (event: globalThis.MouseEvent) => {
      if (!tableMenu.current?.contains(event.target as Node)) {
        setTableMenuOpen(false);
      }
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setTableMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [tableMenuOpen]);

  const insertTable = (columns: number, rows: number) => {
    setTableMenuOpen(false);
    const editor = editorViewRef.current;
    if (editor) insertTableMarkdown(editor, columns, rows);
  };

  // Arrow keys move through the grid; the focused cell is the chosen size.
  const handleTableGridKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    const columns = Math.min(
      TABLE_MAX_COLUMNS,
      Math.max(1, tableSize.columns + delta[0]),
    );
    const rows = Math.min(
      TABLE_MAX_ROWS,
      Math.max(1, tableSize.rows + delta[1]),
    );
    setTableSize({ columns, rows });
    tableGrid.current
      ?.querySelector<HTMLButtonElement>(`[data-cell="${columns}x${rows}"]`)
      ?.focus();
  };

  const handleImageFilePick = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const editor = editorViewRef.current;
      const files = Array.from(event.target.files ?? []).filter((file) =>
        file.type.startsWith("image/"),
      );
      event.target.value = "";
      if (!editor || !files.length) return;
      void saveImagesIntoView(
        editor,
        editor.state.selection.main.head,
        files,
        imageNotePath,
        imageNativeStore,
        showNotice,
      );
    },
    [imageNativeStore, imageNotePath, showNotice],
  );

  const updateTextSnippet = useCallback(
    (id: string, patch: Partial<Omit<TextSnippet, "id">>) => {
      setTextSnippets((current) =>
        current.map((textSnippet) =>
          textSnippet.id === id ? { ...textSnippet, ...patch } : textSnippet,
        ),
      );
    },
    [],
  );

  const recordSnippetShortcut = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, id: string) => {
      if (event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        event.currentTarget.blur();
        return;
      }
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        updateTextSnippet(id, { shortcut: "" });
        return;
      }

      const shortcut = shortcutFromEvent(event);
      if (!shortcut) {
        if (!/^(?:Alt|Control|Meta|Shift)$/.test(event.key)) {
          showNotice("Include Ctrl, Command, or Alt in a snippet shortcut.");
        }
        return;
      }
      const appConflict = APP_SHORTCUT_COMMANDS.find(
        ({ id: commandId }) =>
          appShortcuts[commandId] &&
          appShortcuts[commandId].toLowerCase() === shortcut.toLowerCase(),
      );
      if (appConflict) {
        showNotice(
          `That shortcut is already assigned to ${appConflict.label}.`,
        );
        return;
      }
      if (
        textSnippets.some(
          (candidate) =>
            candidate.id !== id &&
            candidate.shortcut.toLowerCase() === shortcut.toLowerCase(),
        )
      ) {
        showNotice(
          "That shortcut is already assigned to another text snippet.",
        );
        return;
      }
      updateTextSnippet(id, { shortcut });
    },
    [appShortcuts, showNotice, textSnippets, updateTextSnippet],
  );

  const recordAppShortcut = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, commandId: AppCommandId) => {
      if (event.key === "Tab") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        event.currentTarget.blur();
        return;
      }
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        setAppShortcuts((current) => ({ ...current, [commandId]: "" }));
        return;
      }

      const shortcut = shortcutFromEvent(event, { allowUnmodified: true });
      if (!shortcut) {
        if (!/^(?:Alt|Control|Meta|Shift)$/.test(event.key)) {
          showNotice("Printable shortcut keys need Ctrl, Command, or Alt.");
        }
        return;
      }

      const commandConflict = APP_SHORTCUT_COMMANDS.find(
        ({ id }) =>
          id !== commandId &&
          appShortcuts[id] &&
          appShortcuts[id].toLowerCase() === shortcut.toLowerCase(),
      );
      if (commandConflict) {
        showNotice(
          `That shortcut is already assigned to ${commandConflict.label}.`,
        );
        return;
      }

      const snippetConflict = textSnippets.find(
        (textSnippet) =>
          textSnippet.shortcut.toLowerCase() === shortcut.toLowerCase(),
      );
      if (snippetConflict) {
        showNotice(
          `That shortcut is already assigned to ${snippetConflict.name || "a text snippet"}.`,
        );
        return;
      }

      setAppShortcuts((current) => ({ ...current, [commandId]: shortcut }));
    },
    [appShortcuts, showNotice, textSnippets],
  );

  const addTextSnippet = useCallback(() => {
    const id = globalThis.crypto?.randomUUID?.() ?? `snippet-${Date.now()}`;
    setTextSnippets((current) => [
      ...current,
      { id, name: "New snippet", shortcut: "", template: "$0", enabled: true },
    ]);
  }, []);

  const restoreDefaultAppShortcuts = useCallback(() => {
    const defaults = freshDefaultAppShortcuts();
    const conflict = APP_SHORTCUT_COMMANDS.find(({ id }) =>
      textSnippets.some(
        (textSnippet) =>
          textSnippet.shortcut &&
          textSnippet.shortcut.toLowerCase() === defaults[id].toLowerCase(),
      ),
    );
    if (conflict) {
      showNotice(
        `Reassign the text snippet using ${formatShortcut(defaults[conflict.id])} before restoring app shortcuts.`,
      );
      return;
    }
    setAppShortcuts(defaults);
  }, [showNotice, textSnippets]);

  const restoreDefaultTextSnippets = useCallback(() => {
    const defaults = freshDefaultTextSnippets();
    const conflict = defaults.find((textSnippet) =>
      APP_SHORTCUT_COMMANDS.some(
        ({ id }) =>
          appShortcuts[id] &&
          appShortcuts[id].toLowerCase() === textSnippet.shortcut.toLowerCase(),
      ),
    );
    if (conflict) {
      showNotice(
        `Reassign the app command using ${formatShortcut(conflict.shortcut)} before restoring snippets.`,
      );
      return;
    }
    setTextSnippets(defaults);
  }, [appShortcuts, showNotice]);

  const trapPreferencesFocus = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [],
  );

  const flushNativeSave = useCallback(
    async (noteId: string) => {
      const timer = nativeSaveTimers.current.get(noteId);
      if (timer !== undefined) window.clearTimeout(timer);
      nativeSaveTimers.current.delete(noteId);

      const existingSave = nativeSavesInFlight.current.get(noteId);
      if (existingSave) {
        await existingSave;
        return;
      }

      if (!nativePendingSaves.current.has(noteId)) return;

      const save = (async () => {
        while (true) {
          const pending = nativePendingSaves.current.get(noteId);
          if (!pending) break;
          nativePendingSaves.current.delete(noteId);

          try {
            await nativeLibrary.write(pending.path, pending.content);
          } catch (error) {
            // An edit made during this write is newer than `pending` and must
            // win. Requeue the failed write only when nothing newer is waiting.
            if (!nativePendingSaves.current.has(noteId)) {
              nativePendingSaves.current.set(noteId, pending);
            }
            setDirty((current) => new Set(current).add(noteId));
            showNotice(
              error instanceof Error
                ? `Could not save ${fileNameFromPath(pending.path)}: ${error.message}`
                : `Could not save ${fileNameFromPath(pending.path)}.`,
            );
            throw error;
          }
        }

        setDirty((current) => {
          const next = new Set(current);
          next.delete(noteId);
          return next;
        });
        if (activeIdRef.current === noteId) {
          if (nativeSavedTimer.current !== undefined) {
            window.clearTimeout(nativeSavedTimer.current);
          }
          setSaved(true);
          nativeSavedTimer.current = window.setTimeout(() => {
            nativeSavedTimer.current = undefined;
            setSaved(false);
          }, 1200);
        }
      })();

      nativeSavesInFlight.current.set(noteId, save);
      try {
        await save;
      } finally {
        if (nativeSavesInFlight.current.get(noteId) === save) {
          nativeSavesInFlight.current.delete(noteId);
        }
      }
    },
    [showNotice],
  );

  const scheduleNativeSave = useCallback(
    (noteId: string, path: string, content: string) => {
      nativePendingSaves.current.set(noteId, { path, content });
      const existing = nativeSaveTimers.current.get(noteId);
      if (existing !== undefined) window.clearTimeout(existing);
      const timer = window.setTimeout(() => {
        void flushNativeSave(noteId).catch(() => undefined);
      }, 420);
      nativeSaveTimers.current.set(noteId, timer);
    },
    [flushNativeSave],
  );

  const flushAllNativeSaves = useCallback(async () => {
    while (true) {
      const noteIds = new Set([
        ...nativePendingSaves.current.keys(),
        ...nativeSavesInFlight.current.keys(),
      ]);
      if (noteIds.size === 0) return;

      const results = await Promise.allSettled(
        Array.from(noteIds, (noteId) => flushNativeSave(noteId)),
      );
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed) throw failed.reason;
    }
  }, [flushNativeSave]);

  /**
   * Writes the page to reopen this library at. Page-to-page reading would
   * otherwise write the settings file on every keypress, so the record is held
   * back briefly — and flushed outright when the window is closing, which is
   * the moment it exists for.
   */
  const flushOpenNote = useCallback(async () => {
    if (openNoteTimer.current !== undefined) {
      window.clearTimeout(openNoteTimer.current);
      openNoteTimer.current = undefined;
    }
    const path = openNotePending.current;
    if (path === openNoteWritten.current) return;
    openNoteWritten.current = path;
    try {
      await nativeLibrary.rememberOpenNote(path ?? null);
    } catch {
      // Coming back to the library's first page is a small enough loss that it
      // is not worth interrupting a reader over.
    }
  }, []);

  useEffect(() => {
    if (!desktopMode || !nativeLibraryOpen) return undefined;
    openNotePending.current =
      active.id === EMPTY_NOTE.id ? undefined : active.path;
    openNoteTimer.current = window.setTimeout(() => void flushOpenNote(), 400);
    return () => {
      if (openNoteTimer.current !== undefined) {
        window.clearTimeout(openNoteTimer.current);
        openNoteTimer.current = undefined;
      }
    };
  }, [active.id, active.path, desktopMode, flushOpenNote, nativeLibraryOpen]);

  const selectNote = useCallback(
    (id: string) => {
      if (desktopMode && active.id !== id) {
        void flushNativeSave(active.id).catch(() => undefined);
      }
      setActiveId(id);
      setNavOpen(false);
      setOutlineOpen(false);
      requestAnimationFrame(() =>
        document.querySelector(".reading-scroll")?.scrollTo({ top: 0 }),
      );
    },
    [active.id, desktopMode, flushNativeSave],
  );

  const updateContent = useCallback(
    (content: string) => {
      if (active.id === EMPTY_NOTE.id) return;
      setNotes((current) =>
        current.map((note) =>
          note.id === active.id ? { ...note, content } : note,
        ),
      );
      setDirty((current) => new Set(current).add(active.id));
      if (nativeSavedTimer.current !== undefined) {
        window.clearTimeout(nativeSavedTimer.current);
        nativeSavedTimer.current = undefined;
      }
      setSaved(false);
      if (desktopMode && nativeLibraryOpen) {
        scheduleNativeSave(active.id, active.path, content);
      }
    },
    [
      active.id,
      active.path,
      desktopMode,
      nativeLibraryOpen,
      scheduleNativeSave,
    ],
  );

  // Read view's run toggle edits the fence itself, so the choice lives in the
  // Markdown and survives edits, moves, and other editors.
  const setFenceRunnable = useCallback(
    (sourceLine: number, runnable: boolean) => {
      const next = setPythonFenceRunnable(active.content, sourceLine, runnable);
      if (next !== active.content) updateContent(next);
    },
    [active.content, updateContent],
  );

  useEffect(() => {
    if (!desktopMode) return;
    let unlistenClose: (() => void) | undefined;

    const flushOnBlur = () => {
      void flushAllNativeSaves().catch(() => undefined);
    };
    window.addEventListener("blur", flushOnBlur);

    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const currentWindow = getCurrentWindow();
      unlistenClose = await currentWindow.onCloseRequested(async (event) => {
        if (nativeWindowClosing.current) return;
        event.preventDefault();
        nativeWindowClosing.current = true;

        // Give the latest debounced edit a brief chance to reach disk, but a
        // failed or slow save must never trap the user in the window.
        let closeSaveTimer: number | undefined;
        try {
          await Promise.race([
            Promise.all([
              flushAllNativeSaves().catch(() => undefined),
              // The page on screen right now is the one to come back to.
              flushOpenNote(),
            ]),
            new Promise<void>((resolve) => {
              closeSaveTimer = window.setTimeout(resolve, 1200);
            }),
          ]);
          await currentWindow.destroy();
        } catch (error) {
          nativeWindowClosing.current = false;
          console.error("Folio could not close its window.", error);
        } finally {
          if (closeSaveTimer !== undefined) window.clearTimeout(closeSaveTimer);
        }
      });
    });

    return () => {
      window.removeEventListener("blur", flushOnBlur);
      unlistenClose?.();
    };
  }, [desktopMode, flushAllNativeSaves, flushOpenNote]);

  const beginCreate = useCallback(
    (kind: CreateKind) => {
      if (desktopMode && !nativeLibraryOpen) {
        showNotice(
          "Choose a library folder before creating files or sections.",
        );
        return;
      }
      setCreateKind(kind);
      setNewEntryName("");
      setNewEntryParent(
        active.id === EMPTY_NOTE.id ? "" : parentPath(active.path),
      );
    },
    [active.id, active.path, desktopMode, nativeLibraryOpen, showNotice],
  );

  const createEntry = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!createKind) return;

    const rawName = newEntryName.trim();
    if (!rawName) {
      showNotice(`Enter a ${createKind} name.`);
      return;
    }
    if (/[\\/:*?"<>|]/.test(rawName)) {
      showNotice('Names cannot contain \\ / : * ? " < > or |.');
      return;
    }

    if (createKind === "folder") {
      const folderPath = joinPath(newEntryParent, rawName);
      if (
        folders.some(
          (folder) => folder.toLowerCase() === folderPath.toLowerCase(),
        )
      ) {
        showNotice("A folder with that name already exists here.");
        return;
      }
      try {
        if (desktopMode) {
          const snapshot = await nativeLibrary.createFolder(folderPath);
          setFolders(snapshot.folders);
        } else if (rootDirectory) {
          if (!(await hasWritePermission(rootDirectory))) {
            showNotice("Write access is needed to create a folder.");
            return;
          }
          const parent = await getDirectoryAtPath(
            rootDirectory,
            newEntryParent,
          );
          await parent.getDirectoryHandle(rawName, { create: true });
        }
        if (!desktopMode) {
          setFolders((current) =>
            [...current, folderPath].sort((a, b) =>
              a.localeCompare(b, undefined, {
                numeric: true,
                sensitivity: "base",
              }),
            ),
          );
        }
        setCollapsedGroups((current) => {
          const next = new Set(current);
          next.delete(folderPath);
          return next;
        });
        setRevealedFolders((current) => new Set(current).add(folderPath));
        setCreateKind(undefined);
        showNotice(`Created ${displayGroup(folderPath)}.`);
      } catch {
        showNotice("Folio could not create that folder.");
      }
      return;
    }

    const fileName = /\.md$/i.test(rawName) ? rawName : `${rawName}.md`;
    const path = joinPath(newEntryParent, fileName);
    if (notes.some((note) => note.path.toLowerCase() === path.toLowerCase())) {
      showNotice("A Markdown file with that name already exists here.");
      return;
    }

    const title = cleanTitle(fileName);
    const content = `# ${title}\n\n`;
    try {
      let handle: FileHandleLike | undefined;
      if (desktopMode) {
        await flushAllNativeSaves();
        const snapshot = await nativeLibrary.createNote(path, content);
        applyNativeLibrary(snapshot, path);
      } else if (rootDirectory) {
        if (!(await hasWritePermission(rootDirectory))) {
          showNotice("Write access is needed to create a file.");
          return;
        }
        const parent = await getDirectoryAtPath(rootDirectory, newEntryParent);
        handle = await parent.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable?.();
        if (!writable) throw new Error("File is not writable");
        await writable.write(content);
        await writable.close();
      }

      if (!desktopMode) {
        const note: Note = {
          id: globalThis.crypto?.randomUUID?.() ?? `note-${Date.now()}`,
          path,
          title,
          content,
          handle,
        };
        setNotes((current) =>
          [...current, note].sort((a, b) =>
            a.path.localeCompare(b.path, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          ),
        );
        setActiveId(note.id);
      }
      setView("editor");
      setCreateKind(undefined);
      showNotice(`Created ${fileName}.`);
    } catch {
      showNotice("Folio could not create that file.");
    }
  };

  /** The name a page can take in `folder` without displacing another page. */
  const availableFileName = (note: Note, folder: string) => {
    const originalName = fileNameFromPath(note.path);
    const extensionIndex = originalName.toLowerCase().lastIndexOf(".md");
    const baseName =
      extensionIndex >= 0
        ? originalName.slice(0, extensionIndex)
        : originalName;
    const extension =
      extensionIndex >= 0 ? originalName.slice(extensionIndex) : ".md";
    let name = originalName;
    let counter = 2;
    while (
      notes.some(
        (item) =>
          item.id !== note.id &&
          item.path.toLowerCase() === joinPath(folder, name).toLowerCase(),
      )
    ) {
      name = `${baseName} ${counter}${extension}`;
      counter += 1;
    }
    return name;
  };

  /**
   * Commits a drag. The page moves folders when it was dropped outside the one
   * holding it, and either way it takes the row the insertion line marked. The
   * new order is written before the library is re-read, so the panel and the
   * order file never disagree, even for a moment.
   */
  const dropNote = async (noteId: string, place: DropPlace) => {
    const note = notes.find((item) => item.id === noteId);
    if (!note) return;

    const sourceFolder = parentPath(note.path);
    const moving = sourceFolder !== place.folder;
    const destinationName = moving
      ? availableFileName(note, place.folder)
      : fileNameFromPath(note.path);
    const destinationPath = joinPath(place.folder, destinationName);

    const listed = folderNames(notes, place.folder, noteOrder);
    const names = placedFolderNames(listed, destinationName, place.index);
    // A page dropped back where it already sat is not a change worth writing.
    if (!moving && names.join("/") === listed.join("/")) return;
    const ordered = withFolderOrder(noteOrder, place.folder, names);

    try {
      if (desktopMode) {
        if (moving) await flushAllNativeSaves();
        const snapshot = moving
          ? await nativeLibrary.move(note.path, destinationPath)
          : undefined;
        const pruned = prunedOrder(ordered, snapshot?.notes ?? notes);
        try {
          await nativeLibrary.writeOrder(serializeFolderOrder(pruned));
          applyNoteOrder(pruned);
        } catch {
          // The page itself has already moved, if it was moving at all. Only
          // the record of where it sits is missing.
          showNotice("Folio could not save this order to the library folder.");
        }
        if (snapshot) {
          applyNativeLibrary(
            snapshot,
            active.id === note.id ? destinationPath : active.path,
          );
          showNotice(`Moved ${note.title} to ${displayGroup(place.folder)}.`);
        }
        return;
      }

      let destinationHandle = note.handle;
      if (moving && rootDirectory) {
        if (!(await hasWritePermission(rootDirectory))) {
          showNotice("Write access is needed to move a file.");
          return;
        }
        const destinationDirectory = await getDirectoryAtPath(
          rootDirectory,
          place.folder,
        );
        const createdHandle = await destinationDirectory.getFileHandle(
          destinationName,
          { create: true },
        );
        const writable = await createdHandle.createWritable?.();
        if (!writable) throw new Error("Destination is not writable");
        await writable.write(note.content);
        await writable.close();

        try {
          const sourceDirectory = await getDirectoryAtPath(
            rootDirectory,
            parentPath(note.path),
          );
          await sourceDirectory.removeEntry(fileNameFromPath(note.path));
        } catch (error) {
          await destinationDirectory.removeEntry(destinationName);
          throw error;
        }
        destinationHandle = createdHandle;
      }

      const moved = moving
        ? storedNotes.map((item) =>
            item.id === note.id
              ? { ...item, path: destinationPath, handle: destinationHandle }
              : item,
          )
        : storedNotes;
      if (moving) {
        setNotes(moved);
        if (rootDirectory) {
          setDirty((current) => {
            const next = new Set(current);
            next.delete(note.id);
            return next;
          });
        }
      }

      const pruned = prunedOrder(ordered, moved);
      applyNoteOrder(pruned);
      if (rootDirectory) {
        try {
          if (!(await hasWritePermission(rootDirectory))) {
            throw new Error("Write access is needed to save the page order.");
          }
          await writeDirectoryOrder(rootDirectory, pruned);
        } catch {
          // The pages are where the reader put them; only the record of it is
          // missing, and saying so is better than silently reverting.
          showNotice("Folio could not save this order to the library folder.");
        }
      }
      if (moving) {
        showNotice(`Moved ${note.title} to ${displayGroup(place.folder)}.`);
      }
    } catch {
      showNotice(
        "Folio could not move that file. The original was kept in place.",
      );
    }
  };

  // Renaming a folder rewrites the paths of everything inside it, so the open
  // page is followed to its new location rather than matched by path.
  const renameEntry = async (entry: LibraryEntry, rawName: string) => {
    setRenamingEntry(undefined);
    const currentName = entryEditName(entry, entry.path);
    const name = rawName.trim();
    if (!name || name === currentName) return;
    if (name.includes("/")) {
      showNotice("Names cannot contain slashes.");
      return;
    }

    const parent = parentPath(entry.path);
    const fileName = entry.kind === "folder" ? name : `${name}.md`;
    const destination = joinPath(parent, fileName);
    const label = entry.kind === "folder" ? "folder" : "page";

    if (!desktopMode || !nativeLibraryOpen) {
      showNotice(`Open a folder to rename a ${label}.`);
      return;
    }

    try {
      await flushAllNativeSaves();
      const snapshot = await nativeLibrary.rename(
        entry.path,
        fileName,
        entry.kind === "folder",
      );
      const openPath =
        entry.kind === "note" && active.path === entry.path
          ? destination
          : entry.kind === "folder" && active.path.startsWith(`${entry.path}/`)
            ? `${destination}${active.path.slice(entry.path.length)}`
            : active.path;
      // Carry a still-empty folder's place in the panel over to its new name.
      if (entry.kind === "folder") {
        setRevealedFolders((current) => {
          const next = new Set<string>();
          current.forEach((folder) => {
            if (folder === entry.path) next.add(destination);
            else if (folder.startsWith(`${entry.path}/`))
              next.add(`${destination}${folder.slice(entry.path.length)}`);
            else next.add(folder);
          });
          return next;
        });
        // A folder under a new name is the same folder, so it keeps its mark.
        const marks = prunedFolderIcons(
          renamedFolderIcons(folderIcons, entry.path, destination),
          snapshot.folders,
        );
        if (serializeFolderIcons(marks) !== serializeFolderIcons(folderIcons)) {
          void saveFolderIcons(marks);
        }
      }
      // A renamed page keeps the place it was dragged to, rather than dropping
      // to the end of its folder under a name the order file does not know.
      const renamed = prunedOrder(
        renamedInOrder(
          noteOrder,
          entry.path,
          destination,
          entry.kind === "folder",
        ),
        snapshot.notes,
      );
      if (serializeFolderOrder(renamed) !== serializeFolderOrder(noteOrder)) {
        await nativeLibrary.writeOrder(serializeFolderOrder(renamed));
      }
      applyNoteOrder(renamed);
      applyNativeLibrary(snapshot, openPath);
      setSelectedEntry({ kind: entry.kind, path: destination });
      showNotice(`Renamed to ${name}.`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  };

  // Renaming an image is two halves that have to agree: the file moves on
  // disk, and every page pointing at it is rewritten to the new name. Pages
  // are matched on where the src lands in the library, not on its text, so a
  // page reaching the image through `../` is fixed up along with its neighbour.
  const renameAttachment = async (entry: AttachmentEntry, rawName: string) => {
    setRenamingAttachment(undefined);
    const name = rawName.trim();
    const current = fileNameFromPath(decodeImageSrc(entry.src));
    if (!name || name === current) return;
    if (name.includes("/") || name.includes("\\")) {
      showNotice("Names cannot contain slashes.");
      return;
    }
    if (!desktopMode || !nativeLibraryOpen) {
      showNotice("Open a folder to rename an image.");
      return;
    }

    try {
      // Pending edits land first: the rewrite below is computed from the notes
      // in memory and written straight to disk, so nothing may be in flight.
      await flushAllNativeSaves();
      const newName = await nativeLibrary.renameAsset(
        entry.notePath,
        entry.src,
        name,
      );
      const target = attachmentPath(entry.notePath, entry.src);
      const rewritten = notes.flatMap((note) => {
        let content = note.content;
        for (const image of noteImageAttachments(note.content)) {
          if (!target || attachmentPath(note.path, image.src) !== target) {
            continue;
          }
          content = renameImageInContent(
            content,
            image.src,
            renamedImageSrc(image.src, newName),
          );
        }
        return content === note.content ? [] : [{ note, content }];
      });

      for (const { note, content } of rewritten) {
        await nativeLibrary.write(note.path, content);
      }
      setNotes((currentNotes) =>
        currentNotes.map((note) => {
          const update = rewritten.find((item) => item.note.id === note.id);
          return update ? { ...note, content: update.content } : note;
        }),
      );
      const pages = rewritten.length;
      showNotice(
        `Renamed to ${newName} on ${pages} page${pages === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  };

  // Re-reads the folder from disk to pick up changes made outside Folio.
  // Pending edits are flushed first, so a refresh can never discard them.
  const refreshLibrary = async (quiet = false) => {
    if (!desktopMode || !nativeLibraryOpen) {
      if (!quiet) showNotice("Open a folder to refresh it.");
      return;
    }
    setRefreshing(true);
    try {
      await flushAllNativeSaves();
      const snapshot = await nativeLibrary.scan();
      if (!snapshot) return;
      setNotes(snapshot.notes);
      setFolders(snapshot.folders);
      setLibraryName(snapshot.name);
      setDirty(new Set());
      // A refresh picks up an order or icons file edited outside Folio too.
      await loadNoteOrder();
      await loadFolderIcons();
      setRevealedFolders(
        (current) =>
          new Set(snapshot.folders.filter((folder) => current.has(folder))),
      );
      // Collapsed folders and the open page are left as they were, unless the
      // page itself is gone from disk.
      if (!snapshot.notes.some((note) => note.id === activeIdRef.current)) {
        setActiveId(snapshot.notes[0]?.id ?? "");
      }
      setSelectedEntry((current) => {
        if (!current) return current;
        const exists =
          current.kind === "folder"
            ? snapshot.folders.includes(current.path)
            : snapshot.notes.some((note) => note.path === current.path);
        return exists ? current : undefined;
      });
      if (!quiet) {
        showNotice(
          `Refreshed — ${snapshot.notes.length} page${
            snapshot.notes.length === 1 ? "" : "s"
          }.`,
        );
      }
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshing(false);
    }
  };

  // The watcher's handler outlives many renders, so it reads the pieces that
  // change — is the panel mid-gesture, and how to refresh — through a ref.
  const externalRefreshRef = useRef<{
    busy: boolean;
    refresh: () => Promise<void>;
  }>({ busy: false, refresh: async () => undefined });
  useEffect(() => {
    externalRefreshRef.current = {
      busy: Boolean(draggedNoteId || renamingEntry || createKind || refreshing),
      refresh: () => refreshLibrary(true),
    };
  });

  // External changes appear on their own: the backend watches the library
  // folder, filters out Folio's own saves, and says so once a burst of
  // changes has settled. Refreshing mid-gesture would pull rows out from
  // under the pointer, so a change landing during one waits for the hand to
  // lift, retrying until the panel is at rest.
  useEffect(() => {
    if (!desktopMode || !nativeLibraryOpen) return undefined;
    let disposed = false;
    let retry: number | undefined;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      window.clearTimeout(retry);
      if (externalRefreshRef.current.busy) {
        retry = window.setTimeout(refresh, 1000);
        return;
      }
      void externalRefreshRef.current.refresh();
    };
    void nativeLibrary.onChange(refresh).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      unlisten?.();
    };
  }, [desktopMode, nativeLibraryOpen]);

  const refreshSyncStatus = useCallback(async () => {
    if (!desktopMode || !nativeLibraryOpen) {
      setSyncInfo(undefined);
      return;
    }
    try {
      setSyncInfo(await nativeLibrary.syncStatus());
    } catch {
      // An unreadable status is not worth a toast; the footer simply
      // keeps its last word until a sync or a poll gets through.
    }
  }, [desktopMode, nativeLibraryOpen]);

  /**
   * One beat of sync: pending edits are flushed to disk, then the backend
   * commits them, pulls what other devices pushed, merges, and pushes back.
   * The quiet flags let the launch sweep run without narrating a no-op.
   */
  const commitAndSync = useCallback(
    async (options?: { quietWhenClean?: boolean; quietOnError?: boolean }) => {
      if (!desktopMode || !nativeLibraryOpen) {
        showNotice("Open a folder to sync it.");
        return;
      }
      setSyncBusy(true);
      try {
        await flushAllNativeSaves();
        const outcome = await nativeLibrary.syncNow();
        setSyncError(undefined);
        const idle = !outcome.committed && !outcome.pulled && !outcome.pushed;
        if (!idle || !options?.quietWhenClean) showNotice(outcome.summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setSyncError(message);
        if (!options?.quietOnError) showNotice(message);
      } finally {
        setSyncBusy(false);
        void refreshSyncStatus();
      }
    },
    [
      desktopMode,
      flushAllNativeSaves,
      nativeLibraryOpen,
      refreshSyncStatus,
      showNotice,
    ],
  );

  // The footer's word on sync stays current: on open, twice a minute, and
  // whenever the window comes back into focus.
  useEffect(() => {
    if (!desktopMode || !nativeLibraryOpen) return undefined;
    const first = window.setTimeout(() => void refreshSyncStatus(), 0);
    const timer = window.setInterval(() => void refreshSyncStatus(), 30000);
    const onFocus = () => void refreshSyncStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [desktopMode, nativeLibraryOpen, refreshSyncStatus]);

  // The launch sweep: changes from a session that ended without a commit — a
  // force quit, a crash — are committed now, and remote work is pulled in.
  // Quiet when there is nothing to say, and about being offline at launch.
  const launchSyncRan = useRef(false);
  useEffect(() => {
    if (!desktopMode || !nativeLibraryOpen || launchSyncRan.current) {
      return;
    }
    launchSyncRan.current = true;
    void (async () => {
      try {
        const status = await nativeLibrary.syncStatus();
        setSyncInfo(status);
        if (!status.configured) return;
        await commitAndSync({ quietWhenClean: true, quietOnError: true });
      } catch {
        // A library that cannot even report sync status simply stays local.
      }
    })();
  }, [commitAndSync, desktopMode, nativeLibraryOpen]);

  // Closing asks one question, and only when it is worth asking: with sync
  // configured and uncommitted changes on disk, the quit prompt opens.
  // Everything else — no sync, a clean tree, any error along the way — lets
  // the close through; quitting must never be the thing that breaks.
  const closeRef = useRef({
    flush: async () => undefined as void,
    nativeOpen: false,
    prompted: false,
  });
  useEffect(() => {
    closeRef.current.flush = flushAllNativeSaves;
    closeRef.current.nativeOpen = desktopMode && nativeLibraryOpen;
  });
  useEffect(() => {
    if (!desktopMode) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handler = async () => {
      if (closeRef.current.prompted) return;
      closeRef.current.prompted = true;
      try {
        await closeRef.current.flush();
        if (!closeRef.current.nativeOpen) {
          await nativeLibrary.approveClose();
          return;
        }
        const status = await nativeLibrary.syncStatus();
        if (!status.configured || status.changedFiles === 0) {
          await nativeLibrary.approveClose();
          return;
        }
        setClosePrompt(status.changedFiles);
      } catch {
        await nativeLibrary.approveClose();
      }
    };
    void nativeLibrary.onCloseRequested(() => void handler()).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopMode]);

  // Escape answers the quit prompt with "stay", like dismissing any dialog.
  useEffect(() => {
    if (closePrompt === undefined) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current.prompted = false;
      setClosePrompt(undefined);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [closePrompt]);

  /** The quit prompt's yes: commit and sync, then close whatever happens. */
  const commitAndQuit = useCallback(async () => {
    setClosePrompt(undefined);
    setSyncBusy(true);
    try {
      await flushAllNativeSaves();
      await nativeLibrary.syncNow();
    } catch {
      // The pages themselves are saved; a failed commit or push is caught up
      // by the launch sweep next time. Quitting still proceeds.
    }
    await nativeLibrary.approveClose();
  }, [flushAllNativeSaves]);

  const deleteEntry = async (entry: LibraryEntry) => {
    setEntryMenu(undefined);
      const label = entry.kind === "folder" ? "folder" : "page";
      if (!desktopMode || !nativeLibraryOpen) {
        showNotice(`Open a folder to delete a ${label}.`);
        return;
      }

      const name = entryEditName(entry, entry.path);
      if (entry.kind === "folder") {
        const contained = notes.filter(
          (note) =>
            note.path === entry.path || note.path.startsWith(`${entry.path}/`),
        ).length;
        const detail = contained
          ? ` and the ${contained} page${contained === 1 ? "" : "s"} inside it`
          : "";
        if (
          !window.confirm(
            `Move “${name}”${detail} to the Trash?\n\nYou can restore it from the Finder.`,
          )
        ) {
          return;
        }
      }

      try {
        await flushAllNativeSaves();
        const snapshot = await nativeLibrary.remove(
          entry.path,
          entry.kind === "folder",
        );
        // Keep the current page open when something else was removed.
        const stillOpen = snapshot.notes.some(
          (note) => note.path === active.path,
        );
        applyNativeLibrary(snapshot, stillOpen ? active.path : undefined);
        setSelectedEntry(undefined);
        // Nothing is left behind describing a folder that has gone.
        if (entry.kind === "folder") {
          const marks = prunedFolderIcons(folderIcons, snapshot.folders);
          if (
            serializeFolderIcons(marks) !== serializeFolderIcons(folderIcons)
          ) {
            void saveFolderIcons(marks);
          }
        }
      showNotice(`Moved ${name} to the Trash.`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  };

  // The document-level key handler needs the current version of this without
  // re-subscribing on every render.
  useEffect(() => {
    deleteEntryRef.current = deleteEntry;
  });

  const openEntryMenu = (event: React.MouseEvent, entry: LibraryEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedEntry(entry);
    setEntryMenu({ ...entry, x: event.clientX, y: event.clientY });
  };

  // Dragging pages runs on pointer events rather than the HTML5 drag and drop
  // API. That API hands the drag to a native macOS drag session, which the
  // desktop app's webview does not reliably start from web content — and a drag
  // that has to say *where* in a folder a page lands needs an insertion line
  // following the pointer, which a native drag image cannot draw.

  /**
   * Reads the row and folder under the pointer as a place to drop a page. A
   * pointer carried out of the panel names no place at all, so a page dragged
   * onto the reader — or off the window — is simply put back.
   */
  const placeFromPoint = (): DropPlace | undefined => {
    const list = pageListRef.current;
    if (!list) return undefined;
    const { x, y } = dragPointer.current;
    const listBox = list.getBoundingClientRect();
    if (
      x < listBox.left - DRAG_PANEL_REACH ||
      x > listBox.right + DRAG_PANEL_REACH
    ) {
      return undefined;
    }

    const sections = Array.from(
      list.querySelectorAll<HTMLElement>("[data-folder-path]"),
    );
    if (!sections.length) return undefined;

    let section = sections.find((element) => {
      const box = element.getBoundingClientRect();
      return y >= box.top && y < box.bottom;
    });
    if (!section) {
      // Between folders, or past either end of the list: aim at the nearer one.
      const above = sections.filter(
        (element) => element.getBoundingClientRect().bottom <= y,
      );
      section = above.length ? above[above.length - 1] : sections[0];
    }

    const rows = Array.from(
      section.querySelectorAll<HTMLElement>("[data-page-row]"),
    );
    const index = rows.findIndex((row) => {
      const box = row.getBoundingClientRect();
      return y < box.top + box.height / 2;
    });
    return {
      folder: section.dataset.folderPath ?? "",
      index: index === -1 ? rows.length : index,
    };
  };

  const showDropPlace = (place: DropPlace | undefined) => {
    const current = dropPlace.current;
    if (
      current?.folder === place?.folder &&
      current?.index === place?.index
    ) {
      return;
    }
    dropPlace.current = place;
    setDropTarget(place);
  };

  /** Keeps a drag near the panel's edge scrolling, without moving the mouse. */
  const stepDragScroll = () => {
    dragScrollFrame.current = 0;
    const list = pageListRef.current;
    if (!list || !dragScroll.current) return;
    const before = list.scrollTop;
    list.scrollTop += dragScroll.current;
    if (list.scrollTop !== before) {
      showDropPlace(placeFromPoint());
    }
    dragScrollFrame.current = requestAnimationFrame(stepDragScroll);
  };

  const trackDragScroll = (y: number) => {
    const list = pageListRef.current;
    if (!list) return;
    const box = list.getBoundingClientRect();
    const above = box.top + DRAG_SCROLL_MARGIN - y;
    const below = y - (box.bottom - DRAG_SCROLL_MARGIN);
    const speed =
      above > 0 ? -DRAG_SCROLL_STEP : below > 0 ? DRAG_SCROLL_STEP : 0;

    // A page picked up near either end of the list starts inside the band that
    // scrolls it. Scrolling only once the pointer has been clear of both ends
    // keeps the list still until the reader actually carries a page to an edge.
    if (!speed) dragScrollArmed.current = true;
    dragScroll.current = dragScrollArmed.current ? speed : 0;
    if (dragScroll.current && !dragScrollFrame.current) {
      dragScrollFrame.current = requestAnimationFrame(stepDragScroll);
    }
  };

  const endDragScroll = () => {
    dragScroll.current = 0;
    if (dragScrollFrame.current) {
      cancelAnimationFrame(dragScrollFrame.current);
      dragScrollFrame.current = 0;
    }
  };

  const beginNoteDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    note: Note,
  ) => {
    // Touch belongs to scrolling the panel; a drag needs a mouse or a pen.
    if (event.button !== 0 || event.pointerType === "touch") return;
    if (renamingEntry) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    dragEnded.current = false;
    dragScrollArmed.current = false;

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
    };

    const stop = () => {
      detach();
      endDragScroll();
      dropPlace.current = undefined;
      setDropTarget(undefined);
      setDraggedNoteId(undefined);
      document.body.classList.remove("dragging-page");
    };

    const onMove = (moving: PointerEvent) => {
      if (moving.pointerId !== event.pointerId) return;
      dragPointer.current = { x: moving.clientX, y: moving.clientY };
      if (!dragging) {
        if (
          Math.abs(moving.clientX - startX) < DRAG_THRESHOLD &&
          Math.abs(moving.clientY - startY) < DRAG_THRESHOLD
        ) {
          return;
        }
        dragging = true;
        setDraggedNoteId(note.id);
        document.body.classList.add("dragging-page");
      }
      moving.preventDefault();
      positionDragGhost(moving.clientX, moving.clientY);
      showDropPlace(placeFromPoint());
      trackDragScroll(moving.clientY);
    };

    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== event.pointerId) return;
      const place = dropPlace.current;
      const dropped = dragging;
      stop();
      if (!dropped) return;
      // The click that follows this pointerup would open the page underneath.
      dragEnded.current = true;
      if (place) void dropNote(note.id, place);
    };

    const onCancel = (cancelled: PointerEvent) => {
      if (cancelled.pointerId !== event.pointerId) return;
      stop();
    };

    const onKey = (key: globalThis.KeyboardEvent) => {
      if (key.key !== "Escape" || !dragging) return;
      key.preventDefault();
      key.stopPropagation();
      dragEnded.current = true;
      stop();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  const positionDragGhost = (x: number, y: number) => {
    const ghost = dragGhostRef.current;
    if (ghost) ghost.style.transform = `translate3d(${x + 14}px, ${y - 12}px, 0)`;
  };

  const downloadNote = useCallback((note: Note) => {
    const blob = new Blob([note.content], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${note.title}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const saveActive = useCallback(async () => {
    if (active.id === EMPTY_NOTE.id) return;
    if (desktopMode) {
      if (!nativeLibraryOpen) {
        showNotice("Choose a library folder before saving notes.");
        return;
      }
      try {
        await flushNativeSave(active.id);
      } catch {
        // flushNativeSave already reports the filesystem error in the UI.
      }
      return;
    }
    if (active.handle?.createWritable) {
      const permissionOptions = { mode: "readwrite" as const };
      const existingPermission = active.handle.queryPermission
        ? await active.handle.queryPermission(permissionOptions)
        : "prompt";
      const permission =
        existingPermission === "granted" || !active.handle.requestPermission
          ? existingPermission
          : await active.handle.requestPermission(permissionOptions);

      if (permission === "granted" || !active.handle.requestPermission) {
        const writable = await active.handle.createWritable();
        await writable.write(active.content);
        await writable.close();
      } else {
        downloadNote(active);
      }
    } else {
      downloadNote(active);
    }
    setDirty((current) => {
      const next = new Set(current);
      next.delete(active.id);
      return next;
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }, [
    active,
    desktopMode,
    downloadNote,
    flushNativeSave,
    nativeLibraryOpen,
    showNotice,
  ]);

  const openFolder = useCallback(async () => {
    if (desktopMode) {
      try {
        await flushAllNativeSaves();
        const snapshot = await nativeLibrary.choose();
        if (!snapshot) return;
        applyNativeLibrary(snapshot, undefined, true);
        setView("preview");
      } catch (error) {
        showNotice(
          error instanceof Error
            ? `Folio could not open that folder: ${error.message}`
            : "Folio could not open that folder.",
        );
      }
      return;
    }
    if (!window.showDirectoryPicker) {
      folderInput.current?.click();
      return;
    }
    try {
      const directory = await window.showDirectoryPicker({
        mode: "read",
        id: "folio-markdown-library",
      });
      const loaded = await readDirectory(directory);
      setNotes(loaded.notes);
      setFolders(loaded.folders);
      applyNoteOrder(await readDirectoryOrder(directory));
      void loadFolderIcons(directory);
      setRootDirectory(directory);
      setActiveId(loaded.notes[0]?.id ?? "");
      setLibraryName(directory.name);
      setDirty(new Set());
      setCollapsedGroups(
        foldersClosedAround(
          loaded.notes,
          loaded.folders,
          loaded.notes[0]?.path,
        ),
      );
      setRevealedFolders(new Set());
      setView("preview");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      folderInput.current?.click();
    }
  }, [
    applyNativeLibrary,
    applyNoteOrder,
    desktopMode,
    flushAllNativeSaves,
    loadFolderIcons,
    showNotice,
  ]);

  const executeAppCommand = useCallback(
    (commandId: AppCommandId) => {
      switch (commandId) {
        case "find":
          setSearchOpen(true);
          return;
        case "save":
          void saveActive();
          return;
        case "sync-commit":
          void commitAndSync();
          return;
        case "previous-page":
          if (activeIndex > 0) selectNote(notes[activeIndex - 1].id);
          return;
        case "next-page":
          if (activeIndex < notes.length - 1)
            selectNote(notes[activeIndex + 1].id);
          return;
        case "new-file":
          beginCreate("file");
          return;
        case "new-folder":
          beginCreate("folder");
          return;
        case "open-folder":
          void openFolder();
          return;
        case "toggle-read-write":
          setView((current) => {
            const singleView =
              current === "split" ? lastSingleViewRef.current : current;
            const next = singleView === "preview" ? "editor" : "preview";
            lastSingleViewRef.current = next;
            return next;
          });
          return;
        case "toggle-split":
          setView((current) => {
            if (current === "split") return lastSingleViewRef.current;
            lastSingleViewRef.current = current;
            return "split";
          });
          return;
        case "toggle-library":
          if (window.matchMedia("(max-width: 960px)").matches) {
            setOutlineOpen(false);
            setNavOpen((current) => !current);
          } else {
            setLibraryCollapsed((current) => !current);
          }
          return;
        case "toggle-outline":
          if (window.matchMedia("(max-width: 1120px)").matches) {
            setNavOpen(false);
            setOutlineOpen((current) => !current);
          } else {
            setOutlineCollapsed((current) => !current);
          }
      }
    },
    [
      activeIndex,
      beginCreate,
      commitAndSync,
      notes,
      openFolder,
      saveActive,
      selectNote,
    ],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".shortcut-recorder")) return;

      if (event.key === "Escape") {
        setSearchOpen(false);
        setNavOpen(false);
        setOutlineOpen(false);
        setFontPanelOpen(false);
        setCreateKind(undefined);
        return;
      }

      const pressedShortcut = shortcutFromEvent(event, {
        allowUnmodified: true,
      });
      if (!pressedShortcut) return;
      const command = APP_SHORTCUT_COMMANDS.find(({ id }) =>
        shortcutMatches(appShortcuts[id], pressedShortcut),
      );
      if (!command) return;

      const isTyping = Boolean(
        target?.closest(
          "input, select, textarea, .cm-editor, [contenteditable='true'], [contenteditable='plaintext-only']",
        ),
      );
      const hasPrimaryModifier = event.ctrlKey || event.metaKey || event.altKey;
      if (isTyping && !hasPrimaryModifier) return;

      event.preventDefault();
      event.stopPropagation();
      if (
        event.repeat &&
        command.id !== "previous-page" &&
        command.id !== "next-page"
      ) {
        return;
      }
      executeAppCommand(command.id);
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [appShortcuts, executeAppCommand]);

  const importFolder = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) =>
      /\.md$/i.test(file.name),
    );
    if (!files.length) return;
    const loaded = await Promise.all(
      files.map(async (file, index) => {
        const relative = file.webkitRelativePath || file.name;
        const parts = relative.split("/");
        const path = parts.length > 1 ? parts.slice(1).join("/") : relative;
        return {
          id: `${path}-${index}`,
          path,
          title: cleanTitle(path),
          content: await file.text(),
        };
      }),
    );
    loaded.sort((a, b) =>
      a.path.localeCompare(b.path, undefined, { numeric: true }),
    );
    const importedFolders = new Set<string>();
    loaded.forEach((note) => {
      let folder = parentPath(note.path);
      while (folder) {
        importedFolders.add(folder);
        folder = parentPath(folder);
      }
    });
    setNotes(loaded);
    setFolders(
      Array.from(importedFolders).sort((a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
      ),
    );
    // An imported copy has no files of Folio's own, and the last library's
    // order and folder marks say nothing about these pages.
    applyNoteOrder({});
    setFolderIcons({});
    setRootDirectory(undefined);
    setActiveId(loaded[0].id);
    setCollapsedGroups(
      foldersClosedAround(loaded, [...importedFolders], loaded[0].path),
    );
    setRevealedFolders(new Set());
    setLibraryName(files[0].webkitRelativePath.split("/")[0] || "My notes");
    event.target.value = "";
  };

  // Link resolution reads the library through refs so the markdown component
  // map below can stay referentially stable while notes are edited. A new map
  // identity makes React remount every rendered element, which would discard
  // Python block outputs on each keystroke or preference change.
  const notesRef = useRef(notes);
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  const activeNotePath = useCallback(
    () =>
      notesRef.current.find((note) => note.id === activeIdRef.current)?.path ??
      "",
    [],
  );

  const findLinkedNote = useCallback((link: NoteLink) => {
    const currentNotes = notesRef.current;
    if (link.kind === "wiki") {
      const target = link.target.toLowerCase();
      return currentNotes.find(
        (note) =>
          note.title.toLowerCase() === target ||
          fileNameFromPath(note.path).replace(/\.md$/i, "").toLowerCase() ===
            target,
      );
    }
    // A link that walks above the library root names a file the open library
    // does not hold, whatever the folded-down path happens to match.
    if (link.kind !== "page" || link.escapes) return undefined;
    const resolved = link.path.toLowerCase();
    return currentNotes.find(
      (note) => normalizePath(note.path).toLowerCase() === resolved,
    );
  }, []);

  // Last resort for a link written against a different folder layout: the same
  // file name anywhere in the library.
  const findNoteByFileName = useCallback((link: NoteLink) => {
    if (link.kind !== "page") return undefined;
    const fileName = fileNameFromPath(link.target).toLowerCase();
    if (!fileName) return undefined;
    return notesRef.current.find(
      (note) => fileNameFromPath(note.path).toLowerCase() === fileName,
    );
  }, []);

  const openLinkedNote = useCallback(
    (id: string, hash: string) => {
      selectNote(id);
      if (!hash) return;
      window.setTimeout(
        () => document.getElementById(hash)?.scrollIntoView(),
        50,
      );
    },
    [selectNote],
  );

  // A link can name a page outside the open folder — the two libraries a reader
  // keeps side by side, or a folder opened one level too deep. Folio follows it
  // by reopening the library at the folder that holds both pages, so the linked
  // page arrives with its neighbours rather than on its own.
  const followMarkdownLink = useCallback(
    async (link: LibraryLink) => {
      const linked = findLinkedNote(link);
      if (linked) {
        openLinkedNote(linked.id, link.hash);
        return;
      }

      const notePath = activeNotePath();
      if (link.kind === "page" && desktopMode && nativeLibraryOpen && notePath) {
        try {
          // The relative paths a save is queued under belong to the current
          // root, so nothing may still be in flight when the root changes.
          await flushAllNativeSaves();
          const opened = await nativeLibrary.openLinked(notePath, link.target);
          if (opened) {
            applyNativeLibrary(opened.snapshot, opened.path);
            setNavOpen(false);
            setOutlineOpen(false);
            requestAnimationFrame(() =>
              document.querySelector(".reading-scroll")?.scrollTo({ top: 0 }),
            );
            if (link.hash) {
              window.setTimeout(
                () => document.getElementById(link.hash)?.scrollIntoView(),
                50,
              );
            }
            // The sidebar just changed underneath the reader; say why.
            if (opened.rerooted) {
              showNotice(`Opened ${opened.snapshot.name} to follow that link.`);
            }
            return;
          }
        } catch (error) {
          showNotice(error instanceof Error ? error.message : String(error));
          return;
        }
      }

      const named = findNoteByFileName(link);
      if (named) {
        openLinkedNote(named.id, link.hash);
        return;
      }
      showNotice(
        `Folio could not find ${
          link.kind === "wiki" ? `[[${link.target}]]` : link.target
        }.`,
      );
    },
    [
      activeNotePath,
      applyNativeLibrary,
      desktopMode,
      findLinkedNote,
      findNoteByFileName,
      flushAllNativeSaves,
      nativeLibraryOpen,
      openLinkedNote,
      showNotice,
    ],
  );

  const handleMarkdownLink = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, href?: string) => {
      const link = resolveNoteLink(activeNotePath(), href);
      // Headings scroll on their own, and an external link is the browser's.
      if (link.kind === "fragment" || link.kind === "external") return;
      // Everything else is a page: never let the click navigate the window,
      // which in the desktop app would unload Folio itself.
      event.preventDefault();
      void followMarkdownLink(link);
    },
    [activeNotePath, followMarkdownLink],
  );

  const normalizedMarkdown = useMemo(
    () => normalizeMathDelimiters(withWikiLinks(active.content)),
    [active.content],
  );

  const markdownComponents = useMemo(
    () => ({
      ...MARKDOWN_HEADING_COMPONENTS,
      // Python fences become runnable blocks only when the info string says
      // ```python run. The pre's props — notably the data-source-line
      // scroll-sync anchor — move onto the block wrapper.
      pre: ({
        node,
        children,
        ...props
      }: React.ComponentPropsWithoutRef<"pre"> & {
        node?: unknown;
        "data-source-line"?: number | string;
      }) => {
        const fence = pythonFenceFromPre(node);
        if (!fence) return <pre {...props}>{children}</pre>;

        // The same anchor the scroll sync uses locates the opening fence,
        // so the toggle can rewrite that one line of Markdown.
        const sourceLine = Number(props["data-source-line"]);
        const toggle = Number.isFinite(sourceLine)
          ? () => setFenceRunnable(sourceLine, !fence.runnable)
          : undefined;

        if (!fence.runnable) {
          return (
            <StaticPythonBlock onEnableRun={toggle} {...props}>
              {children}
            </StaticPythonBlock>
          );
        }
        return (
          <PythonCodeBlock
            code={fence.code}
            sessionId={activeId}
            onDisableRun={toggle}
            {...(props as React.HTMLAttributes<HTMLDivElement>)}
          >
            {children}
          </PythonCodeBlock>
        );
      },
      code: ({
        className,
        children,
      }: React.ComponentPropsWithoutRef<"code">) => {
        const language = className?.match(/language-([\w-]+)/)?.[1];
        return (
          <code className={className} data-language={language}>
            {children}
          </code>
        );
      },
      a: ({ href, children }: React.ComponentPropsWithoutRef<"a">) => (
        <a href={href} onClick={(event) => handleMarkdownLink(event, href)}>
          {href?.startsWith("wiki:") && <Link2 size={13} aria-hidden="true" />}
          {children}
        </a>
      ),
      img: ({ src, alt, title }: React.ComponentPropsWithoutRef<"img">) => (
        <MarkdownImage
          notePath={active.path}
          src={typeof src === "string" ? src : undefined}
          alt={alt}
          title={title}
        />
      ),
    }),
    [activeId, active.path, handleMarkdownLink, setFenceRunnable],
  );

  const markdown = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: true }]]}
      rehypePlugins={[
        [rehypeSanitize, markdownSanitizeSchema],
        [rehypeSourceLines, { sourceLines: normalizedMarkdown.sourceLines }],
        [
          rehypeKatex,
          {
            strict: false,
            trust: false,
            output: "htmlAndMathml",
            errorColor: "#b6574f",
          },
        ],
        rehypeHighlight,
      ]}
      urlTransform={(url) => url}
      components={markdownComponents}
    >
      {normalizedMarkdown.content}
    </ReactMarkdown>
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-zone">
          <button
            className="icon-button mobile-only"
            onClick={() => {
              setOutlineOpen(false);
              setNavOpen(true);
            }}
            aria-label="Open library"
            aria-controls="library-panel"
            aria-expanded={navOpen}
          >
            <Menu size={19} />
          </button>
          <button
            className="icon-button docked-panel-toggle docked-library-toggle"
            onClick={() => setLibraryCollapsed((collapsed) => !collapsed)}
            aria-label={`${libraryCollapsed ? "Show" : "Hide"} library panel`}
            aria-controls="library-panel"
            aria-expanded={!libraryCollapsed}
            title={`${libraryCollapsed ? "Show" : "Hide"} library panel`}
          >
            {libraryCollapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
          </button>
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="brand-name">Folio</span>
          <span className="brand-rule" />
          <span className="library-title">{libraryName}</span>
        </div>

        <div className="top-actions">
          <button
            className="search-trigger"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={15} />
            <span>Find a page</span>
            {appShortcuts.find && (
              <kbd>{formatShortcut(appShortcuts.find)}</kbd>
            )}
          </button>
          <button
            ref={preferencesTrigger}
            className={`icon-button ${fontPanelOpen ? "active" : ""}`}
            onClick={() => setFontPanelOpen((open) => !open)}
            aria-label="Open preferences"
            aria-expanded={fontPanelOpen}
            title="Preferences"
          >
            <Palette size={17} />
          </button>
          <button
            className="icon-button"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label={`Use ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <button
            className="icon-button mobile-only"
            onClick={() => {
              setNavOpen(false);
              setOutlineOpen(true);
            }}
            aria-label="Open page outline"
            aria-controls="outline-panel"
            aria-expanded={outlineOpen}
          >
            <PanelRight size={18} />
          </button>
          <button
            className="icon-button docked-panel-toggle docked-outline-toggle"
            onClick={() => setOutlineCollapsed((collapsed) => !collapsed)}
            aria-label={`${outlineCollapsed ? "Show" : "Hide"} page outline panel`}
            aria-controls="outline-panel"
            aria-expanded={!outlineCollapsed}
            title={`${outlineCollapsed ? "Show" : "Hide"} page outline panel`}
          >
            {outlineCollapsed ? (
              <PanelRightOpen size={16} />
            ) : (
              <PanelRightClose size={16} />
            )}
          </button>
          {!desktopMode && (
            <input
              ref={folderInput}
              className="visually-hidden"
              type="file"
              multiple
              accept=".md,text/markdown"
              onChange={importFolder}
              {...({
                webkitdirectory: "",
                directory: "",
              } as React.InputHTMLAttributes<HTMLInputElement>)}
            />
          )}
        </div>
      </header>

      {fontPanelOpen && (
        <>
          <button
            className="font-popover-scrim"
            onClick={() => setFontPanelOpen(false)}
            aria-label="Close preferences"
          />
          <dialog
            ref={preferencesDialog}
            className="font-popover"
            open
            aria-modal="true"
            aria-label="Preferences"
            tabIndex={-1}
            onKeyDown={trapPreferencesFocus}
          >
            <div className="font-popover-head">
              <span>
                <small>Folio</small>
                <strong>Preferences</strong>
              </span>
              <button
                className="subtle-icon"
                onClick={() => setFontPanelOpen(false)}
                aria-label="Close preferences"
              >
                <X size={16} />
              </button>
            </div>

            <div
              className="preference-tabs"
              role="tablist"
              aria-label="Preferences sections"
            >
              <button
                type="button"
                className={preferenceTab === "appearance" ? "selected" : ""}
                onClick={() => setPreferenceTab("appearance")}
                role="tab"
                aria-selected={preferenceTab === "appearance"}
              >
                <Palette size={14} /> Appearance
              </button>
              <button
                type="button"
                className={preferenceTab === "shortcuts" ? "selected" : ""}
                onClick={() => setPreferenceTab("shortcuts")}
                role="tab"
                aria-selected={preferenceTab === "shortcuts"}
                aria-label="Keyboard shortcuts"
              >
                <Command size={14} /> Shortcuts
              </button>
              {desktopMode && (
                <button
                  type="button"
                  className={preferenceTab === "sync" ? "selected" : ""}
                  onClick={() => setPreferenceTab("sync")}
                  role="tab"
                  aria-selected={preferenceTab === "sync"}
                >
                  <GitBranch size={14} /> Sync
                </button>
              )}
              <button
                type="button"
                className={preferenceTab === "snippets" ? "selected" : ""}
                onClick={() => setPreferenceTab("snippets")}
                role="tab"
                aria-selected={preferenceTab === "snippets"}
              >
                <Keyboard size={14} /> Text snippets
              </button>
            </div>

            {preferenceTab === "appearance" && (
              <div className="preference-pane" role="tabpanel">
                <fieldset className="palette-control">
                  <legend>
                    Color scheme
                    <em>
                      {
                        COLOR_PALETTES.find((entry) => entry.id === palette)
                          ?.description
                      }
                    </em>
                  </legend>
                  <div
                    className="palette-grid"
                    role="radiogroup"
                    aria-label="Color scheme"
                  >
                    {COLOR_PALETTES.map((colorPalette) => (
                      <button
                        type="button"
                        key={colorPalette.id}
                        className={
                          palette === colorPalette.id ? "selected" : ""
                        }
                        onClick={() => setPalette(colorPalette.id)}
                        role="radio"
                        aria-checked={palette === colorPalette.id}
                        aria-label={`${colorPalette.label} — ${colorPalette.description}`}
                        title={colorPalette.description}
                      >
                        <span className="palette-swatches" aria-hidden="true">
                          {colorPalette[theme].map((color) => (
                            <i key={color} style={{ background: color }} />
                          ))}
                        </span>
                        <strong>{colorPalette.label}</strong>
                        {palette === colorPalette.id && (
                          <span className="palette-check" aria-hidden="true">
                            <Check size={11} strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className="font-control">
                  <span>Reader font</span>
                  <select
                    value={readerFont}
                    onChange={(event) =>
                      setReaderFont(event.target.value as FontId)
                    }
                  >
                    {FONT_CATEGORIES.map((category) => (
                      <optgroup key={category} label={category}>
                        {FONT_CHOICES.filter(
                          (font) => font.category === category,
                        ).map((font) => (
                          <option key={font.id} value={font.id}>
                            {font.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <div
                  className="font-sample reader-sample"
                  style={{ fontFamily: fontStack(readerFont) }}
                >
                  <span>Aa</span>
                  <p>The shape of a thoughtful page.</p>
                </div>

                <label className="font-control">
                  <span>Editor font</span>
                  <select
                    value={editorFont}
                    onChange={(event) =>
                      setEditorFont(event.target.value as FontId)
                    }
                  >
                    {FONT_CATEGORIES.map((category) => (
                      <optgroup key={category} label={category}>
                        {FONT_CHOICES.filter(
                          (font) => font.category === category,
                        ).map((font) => (
                          <option key={font.id} value={font.id}>
                            {font.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <div
                  className="font-sample editor-sample"
                  style={{ fontFamily: fontStack(editorFont) }}
                >
                  <span>01</span>
                  <p>{'const note = "connected";'}</p>
                </div>
                <fieldset className="width-control">
                  <legend>Reading width</legend>
                  <input
                    type="range"
                    min={0}
                    max={READER_WIDTHS.length - 1}
                    step={1}
                    value={readerWidth}
                    list="reader-width-notches"
                    onChange={(event) =>
                      setReaderWidth(Number(event.target.value))
                    }
                    aria-label="Reading width"
                    aria-valuetext={READER_WIDTHS[readerWidth].label}
                  />
                  <datalist id="reader-width-notches">
                    {READER_WIDTHS.map((option) => (
                      <option
                        key={option.width}
                        value={READER_WIDTHS.indexOf(option)}
                      />
                    ))}
                  </datalist>
                  <div className="width-readout">
                    <strong>{READER_WIDTHS[readerWidth].label}</strong>
                    <span>{READER_WIDTHS[readerWidth].width}px</span>
                  </div>
                  <p className="width-note">
                    Applies to Read and Split views alike. A narrower pane just
                    uses the room it has.
                  </p>
                </fieldset>

                <p className="font-footnote">
                  Preferences stay on this device.
                </p>
              </div>
            )}

            {preferenceTab === "shortcuts" && (
              <div
                className="preference-pane shortcut-preferences"
                role="tabpanel"
              >
                <p className="shortcut-help">
                  Focus a shortcut field and press the keys you want. Backspace
                  clears a binding. Bare navigation and function keys are
                  allowed; printable keys need Ctrl, Command, or Alt. Modified
                  shortcuts also work while writing.
                </p>
                <div className="app-shortcut-groups">
                  {(["General", "Navigation", "Files", "View"] as const).map(
                    (group) => (
                      <fieldset className="app-shortcut-group" key={group}>
                        <legend>{group}</legend>
                        {APP_SHORTCUT_COMMANDS.filter(
                          (command) => command.group === group,
                        ).map((command) => {
                          const issue = appShortcutIssue(
                            command.id,
                            appShortcuts,
                            textSnippets,
                          );
                          return (
                            <label
                              className="app-shortcut-row"
                              key={command.id}
                            >
                              <span>{command.label}</span>
                              <input
                                className={`shortcut-recorder ${issue ? "has-issue" : ""}`}
                                // Symbols are set large, so the unbound state
                                // uses a short placeholder rather than a label
                                // that would not fit.
                                value={
                                  appShortcuts[command.id]
                                    ? formatShortcut(appShortcuts[command.id])
                                    : ""
                                }
                                placeholder="Not set"
                                onKeyDown={(event) =>
                                  recordAppShortcut(event, command.id)
                                }
                                onFocus={(event) =>
                                  event.currentTarget.select()
                                }
                                readOnly
                                aria-label={`Record shortcut for ${command.label}`}
                                aria-invalid={Boolean(issue)}
                                title="Focus, then press the shortcut. Backspace clears it."
                              />
                              {issue && (
                                <small className="shortcut-issue">
                                  {issue}
                                </small>
                              )}
                            </label>
                          );
                        })}
                      </fieldset>
                    ),
                  )}
                </div>
                <div className="snippet-actions shortcut-actions">
                  <button type="button" onClick={restoreDefaultAppShortcuts}>
                    Restore defaults
                  </button>
                </div>
              </div>
            )}

            {preferenceTab === "sync" && (
              <div className="preference-pane sync-preferences" role="tabpanel">
                {!syncInfo?.configured ? (
                  <>
                    <p className="sync-help">
                      Sync this library through a Git repository you own.
                      Folio commits when you ask, pulls what your other
                      devices pushed, and merges page edits line by line —
                      always into one file, never a conflicted copy.
                    </p>
                    <label className="sync-field">
                      <span>Remote URL</span>
                      <input
                        type="text"
                        value={syncRemoteDraft}
                        onChange={(event) =>
                          setSyncRemoteDraft(event.target.value)
                        }
                        placeholder="https://github.com/you/notes.git"
                        spellCheck={false}
                      />
                    </label>
                    <label className="sync-field">
                      <span>Access token</span>
                      <input
                        type="password"
                        value={syncTokenDraft}
                        onChange={(event) =>
                          setSyncTokenDraft(event.target.value)
                        }
                        placeholder="For https remotes — ssh uses your agent"
                        spellCheck={false}
                      />
                    </label>
                    <button
                      type="button"
                      className="sync-action"
                      disabled={syncBusy || !syncRemoteDraft.trim()}
                      onClick={() =>
                        void (async () => {
                          if (!nativeLibraryOpen) {
                            showNotice("Open a folder to sync it.");
                            return;
                          }
                          setSyncBusy(true);
                          try {
                            await flushAllNativeSaves();
                            const outcome = await nativeLibrary.syncConnect(
                              syncRemoteDraft.trim(),
                              syncTokenDraft.trim(),
                            );
                            setSyncTokenDraft("");
                            setSyncError(undefined);
                            showNotice(outcome.summary);
                          } catch (error) {
                            showNotice(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            );
                          } finally {
                            setSyncBusy(false);
                            void refreshSyncStatus();
                          }
                        })()
                      }
                    >
                      {syncBusy ? "Connecting…" : "Connect & sync"}
                    </button>
                    <p className="font-footnote">
                      The token stays on this device, outside the library, so
                      it is never committed. An empty remote receives this
                      library; a remote with pages brings them down.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="sync-remote-line">
                      Connected to <strong>{syncInfo.remote}</strong>
                      {syncInfo.branch ? ` on ${syncInfo.branch}` : ""}.
                    </p>
                    <p className="sync-help">
                      {syncInfo.changedFiles > 0
                        ? `${syncInfo.changedFiles} change${
                            syncInfo.changedFiles === 1 ? "" : "s"
                          } waiting for a commit.`
                        : "Everything on disk is committed."}{" "}
                      Commit &amp; sync any time with{" "}
                      <kbd>{formatShortcut(appShortcuts["sync-commit"])}</kbd>,
                      when quitting, and when Folio opens.
                    </p>
                    {/* A connected library still needs a way in for a
                        token: they expire, and a first sync that failed
                        before saving one leaves a remote with no credential
                        to reach it with. */}
                    <label className="sync-field">
                      <span>Access token</span>
                      <input
                        type="password"
                        value={syncTokenDraft}
                        onChange={(event) =>
                          setSyncTokenDraft(event.target.value)
                        }
                        placeholder="Replace the stored token"
                        spellCheck={false}
                      />
                    </label>
                    <div className="sync-actions">
                      <button
                        type="button"
                        className="sync-action"
                        disabled={syncBusy || !syncTokenDraft.trim()}
                        onClick={() =>
                          void (async () => {
                            try {
                              await nativeLibrary.syncSetToken(
                                syncTokenDraft.trim(),
                              );
                              setSyncTokenDraft("");
                              showNotice("Access token saved.");
                            } catch (error) {
                              showNotice(
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                              );
                            }
                          })()
                        }
                      >
                        Save token
                      </button>
                      <button
                        type="button"
                        className="sync-action"
                        disabled={syncBusy}
                        onClick={() => void commitAndSync()}
                      >
                        {syncBusy ? "Syncing…" : "Sync now"}
                      </button>
                      <button
                        type="button"
                        className="sync-action sync-disconnect"
                        disabled={syncBusy}
                        onClick={() =>
                          void (async () => {
                            try {
                              await nativeLibrary.syncDisconnect();
                              showNotice(
                                "Sync disconnected. History stays in the library.",
                              );
                            } catch (error) {
                              showNotice(
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                              );
                            } finally {
                              void refreshSyncStatus();
                            }
                          })()
                        }
                      >
                        Disconnect
                      </button>
                    </div>
                    <p className="font-footnote">
                      History lives in .git inside the library folder.
                      Disconnecting keeps it; only the remote and this
                      device&apos;s token are forgotten.
                    </p>
                  </>
                )}
              </div>
            )}

            {preferenceTab === "snippets" && (
              <div
                className="preference-pane snippet-preferences"
                role="tabpanel"
              >
                <p className="snippet-help">
                  Record a shortcut, then enter the text it should insert. Use{" "}
                  <code>$1</code>, <code>$2</code>, and so on for Tab stops;{" "}
                  <code>$0</code> is the final cursor. Write <code>\$1</code>{" "}
                  for literal text.
                </p>
                <div className="snippet-list">
                  {textSnippets.map((textSnippet) => {
                    const issue = snippetShortcutIssue(
                      textSnippet,
                      textSnippets,
                      appShortcuts,
                    );
                    const label = textSnippet.name || "snippet";
                    return (
                      <article
                        className={`snippet-card ${textSnippet.enabled ? "" : "disabled"}`}
                        key={textSnippet.id}
                      >
                        <div className="snippet-card-head">
                          <input
                            type="checkbox"
                            className="snippet-enabled"
                            checked={textSnippet.enabled}
                            onChange={(event) =>
                              updateTextSnippet(textSnippet.id, {
                                enabled: event.target.checked,
                              })
                            }
                            aria-label={`Enable ${label}`}
                            title={textSnippet.enabled ? "Enabled" : "Disabled"}
                          />
                          <input
                            className="snippet-name"
                            value={textSnippet.name}
                            onChange={(event) =>
                              updateTextSnippet(textSnippet.id, {
                                name: event.target.value,
                              })
                            }
                            placeholder="Snippet name"
                            aria-label="Snippet name"
                          />
                          <input
                            className={`shortcut-recorder ${issue ? "has-issue" : ""}`}
                            // The compact box has no room for the long empty
                            // label the Shortcuts tab uses.
                            value={
                              textSnippet.shortcut
                                ? formatShortcut(textSnippet.shortcut)
                                : ""
                            }
                            placeholder="Set"
                            onKeyDown={(event) =>
                              recordSnippetShortcut(event, textSnippet.id)
                            }
                            onFocus={(event) => event.currentTarget.select()}
                            readOnly
                            aria-label={`Record shortcut for ${label}`}
                            aria-invalid={Boolean(issue)}
                            title="Focus, then press the shortcut. Backspace clears it."
                          />
                          <button
                            type="button"
                            className="subtle-icon"
                            onClick={() =>
                              setTextSnippets((current) =>
                                current.filter(
                                  (candidate) =>
                                    candidate.id !== textSnippet.id,
                                ),
                              )
                            }
                            aria-label={`Delete ${label}`}
                            title="Delete snippet"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                        {issue && (
                          <small className="snippet-issue">{issue}</small>
                        )}
                        <textarea
                          className="snippet-template"
                          value={textSnippet.template}
                          onChange={(event) =>
                            updateTextSnippet(textSnippet.id, {
                              template: event.target.value,
                            })
                          }
                          placeholder="Text to insert…"
                          spellCheck={false}
                          aria-label={`Text inserted by ${label}`}
                        />
                      </article>
                    );
                  })}
                  {!textSnippets.length && (
                    <p className="snippet-empty">
                      No snippets yet. Add one to get started.
                    </p>
                  )}
                </div>
                <div className="snippet-actions">
                  <button type="button" onClick={addTextSnippet}>
                    <Plus size={14} /> Add snippet
                  </button>
                  <button type="button" onClick={restoreDefaultTextSnippets}>
                    Restore defaults
                  </button>
                </div>
              </div>
            )}
          </dialog>
        </>
      )}

      <div
        className={`workspace ${libraryCollapsed ? "library-collapsed" : ""} ${
          outlineCollapsed ? "outline-collapsed" : ""
        }`}
      >
        {navOpen && (
          <button
            className="scrim library-scrim"
            onClick={() => setNavOpen(false)}
            aria-label="Close library"
          />
        )}
        <aside
          id="library-panel"
          className={`library-panel ${navOpen ? "is-open" : ""}`}
        >
          <div className="panel-mobile-head">
            <span>Library</span>
            <button
              className="icon-button"
              onClick={() => setNavOpen(false)}
              aria-label="Close library"
            >
              <X size={18} />
            </button>
          </div>
          <div className="library-heading">
            <div>
              <span className="eyebrow">Your library</span>
              <h2>{libraryName}</h2>
            </div>
            <div className="library-create-actions">
              <button
                className="subtle-icon"
                onClick={() => void refreshLibrary()}
                disabled={refreshing}
                aria-label="Refresh library"
                title="Re-read this folder from disk"
              >
                <RefreshCw size={15} className={refreshing ? "spinning" : ""} />
              </button>
              <button
                className="subtle-icon"
                onClick={() => beginCreate("file")}
                aria-label="New Markdown file"
                title="New Markdown file"
              >
                <FilePlus2 size={16} />
              </button>
              <button
                className="subtle-icon"
                onClick={() => beginCreate("folder")}
                aria-label="New folder"
                title="New folder"
              >
                <FolderPlus size={16} />
              </button>
            </div>
          </div>

          <nav
            className="section-list"
            aria-label="Library pages"
            ref={pageListRef}
          >
            {!listedGroups.length && (
              <p className="library-empty">
                No Markdown files here yet. Create one to start this library.
              </p>
            )}
            {listedGroups.map(([group, groupNotes]) => {
              const collapsed = collapsedGroups.has(group);
              // The row a drop would take in this folder, drawn as a line
              // between pages. Only the folder under the pointer draws one.
              const dropRow =
                draggedNoteId && dropTarget?.folder === group
                  ? dropTarget.index
                  : undefined;
              // A folder listed only for the drag in hand — an empty one the
              // panel normally hides. It is drawn as a drop zone, so appearing
              // for the drag reads as an offer, not as the library changing.
              const dropZone =
                Boolean(draggedNoteId) &&
                !groupNotes.length &&
                !revealedFolders.has(group);
              return (
                <section
                  className={`section-group ${
                    group === activeGroupPath ? "active-section" : ""
                  } ${dropRow === undefined ? "" : "drop-target"} ${
                    dropZone ? "drop-zone" : ""
                  }`}
                  key={group || "__root__"}
                  data-folder-path={group}
                >
                  {/* The mark sits outside the folder's own button so it can
                      be a button itself: a click on the folder opens it, a
                      click on its mark asks how it should look. */}
                  <div className="section-head">
                    <button
                      type="button"
                      className="section-icon"
                      data-color={folderIcons[group]?.color}
                      aria-label={`Icon for ${displayGroup(group)}`}
                      aria-haspopup="dialog"
                      aria-expanded={folderIconMenu?.folder === group}
                      title="Choose an icon for this folder"
                      onClick={(event) => openFolderIconMenu(event, group)}
                      onContextMenu={(event) =>
                        group &&
                        openEntryMenu(event, { kind: "folder", path: group })
                      }
                    >
                      <FolderMark mark={folderIcons[group]} />
                    </button>
                    {renamingEntry?.kind === "folder" &&
                    renamingEntry.path === group ? (
                      <EntryRenameField
                        className="section-label renaming"
                        initial={entryEditName(renamingEntry, group)}
                        onCommit={(value) =>
                          void renameEntry(renamingEntry, value)
                        }
                        onCancel={() => setRenamingEntry(undefined)}
                      />
                    ) : (
                      <button
                        className={`section-label ${
                          sameEntry(selectedEntry, {
                            kind: "folder",
                            path: group,
                          })
                            ? "selected-entry"
                            : ""
                        }`}
                        onClick={() => {
                          setSelectedEntry({ kind: "folder", path: group });
                          setCollapsedGroups((current) => {
                            const next = new Set(current);
                            if (next.has(group)) next.delete(group);
                            else next.add(group);
                            return next;
                          });
                        }}
                        onContextMenu={(event) =>
                          group &&
                          openEntryMenu(event, { kind: "folder", path: group })
                        }
                      >
                        <strong>{displayGroup(group)}</strong>
                        <small>
                          {dropZone ? "drop here" : groupNotes.length}
                        </small>
                        <ChevronDown
                          size={14}
                          className={collapsed ? "rotated" : ""}
                        />
                      </button>
                    )}
                  </div>
                  {!collapsed && (
                    <div className="page-list">
                      {groupNotes.map((note, noteIndex) => {
                        // The insertion line is painted onto the row it would
                        // land against rather than inserted between rows: a
                        // real element would take a grid row of its own and
                        // nudge everything below it while the drag is held.
                        const dropMark =
                          dropRow === noteIndex
                            ? "drop-before"
                            : dropRow === groupNotes.length &&
                                noteIndex === groupNotes.length - 1
                              ? "drop-after"
                              : "";
                        if (
                          renamingEntry?.kind === "note" &&
                          renamingEntry.path === note.path
                        ) {
                          return (
                            <EntryRenameField
                              key={note.id}
                              className="page-row renaming"
                              initial={entryEditName(renamingEntry, note.path)}
                              onCommit={(value) =>
                                void renameEntry(renamingEntry, value)
                              }
                              onCancel={() => setRenamingEntry(undefined)}
                            />
                          );
                        }
                        const noteImages = attachments.get(note.id);
                        const imagesOpen = expandedAttachments.has(note.id);
                        return (
                          <div
                            className={`page-entry ${dropMark}`}
                            key={note.id}
                          >
                            <button
                              className={`page-row ${note.id === active.id ? "active" : ""} ${
                                draggedNoteId === note.id ? "dragging" : ""
                              } ${noteImages ? "has-attachments" : ""} ${
                                sameEntry(selectedEntry, {
                                  kind: "note",
                                  path: note.path,
                                })
                                  ? "selected-entry"
                                  : ""
                              }`}
                              onClick={() => {
                                // The click that ends a drag would otherwise
                                // open whichever page was dropped on.
                                if (dragEnded.current) {
                                  dragEnded.current = false;
                                  return;
                                }
                                setSelectedEntry({
                                  kind: "note",
                                  path: note.path,
                                });
                                selectNote(note.id);
                              }}
                              onContextMenu={(event) =>
                                openEntryMenu(event, {
                                  kind: "note",
                                  path: note.path,
                                })
                              }
                              onPointerDown={(event) =>
                                beginNoteDrag(event, note)
                              }
                              data-page-row=""
                              title="Open this page, or drag it into place"
                            >
                              <span className="page-spine" />
                              <span className="page-order">
                                {String(noteIndex + 1).padStart(2, "0")}
                              </span>
                              <span className="page-title">{note.title}</span>
                              {dirty.has(note.id) && (
                                <i aria-label="Unsaved changes" />
                              )}
                              <GripVertical
                                className="drag-handle"
                                size={13}
                                aria-hidden="true"
                              />
                            </button>
                            {noteImages && (
                              <button
                                className="attachment-toggle"
                                onClick={() =>
                                  setExpandedAttachments((current) => {
                                    const next = new Set(current);
                                    if (next.has(note.id)) next.delete(note.id);
                                    else next.add(note.id);
                                    return next;
                                  })
                                }
                                aria-expanded={imagesOpen}
                                aria-controls={`attachments-${note.id}`}
                                aria-label={`${imagesOpen ? "Hide" : "Show"} the ${
                                  noteImages.length
                                } image${
                                  noteImages.length === 1 ? "" : "s"
                                } in ${note.title}`}
                                title={`${noteImages.length} image${
                                  noteImages.length === 1 ? "" : "s"
                                } in this page`}
                              >
                                <ChevronRight
                                  size={10}
                                  className={imagesOpen ? "rotated" : ""}
                                  aria-hidden="true"
                                />
                                <ImageIcon size={11} aria-hidden="true" />
                                <span>{noteImages.length}</span>
                              </button>
                            )}
                            {noteImages && imagesOpen && (
                              <ul
                                className="attachment-list"
                                id={`attachments-${note.id}`}
                              >
                                {noteImages.map((image) => {
                                  const attachment = {
                                    noteId: note.id,
                                    notePath: note.path,
                                    src: image.src,
                                  };
                                  if (
                                    sameAttachment(
                                      renamingAttachment,
                                      attachment,
                                    )
                                  ) {
                                    return (
                                      <li key={image.src}>
                                        <EntryRenameField
                                          className="attachment-row renaming"
                                          initial={image.name}
                                          onCommit={(value) =>
                                            void renameAttachment(
                                              attachment,
                                              value,
                                            )
                                          }
                                          onCancel={() =>
                                            setRenamingAttachment(undefined)
                                          }
                                        />
                                      </li>
                                    );
                                  }
                                  return (
                                    <li
                                      className="attachment-row"
                                      key={image.src}
                                      title={image.src}
                                      onDoubleClick={() =>
                                        setRenamingAttachment(attachment)
                                      }
                                    >
                                      <ImageIcon size={11} aria-hidden="true" />
                                      <span>{image.name}</span>
                                      <button
                                        className="attachment-rename"
                                        onClick={() =>
                                          setRenamingAttachment(attachment)
                                        }
                                        aria-label={`Rename ${image.name}`}
                                        title="Rename this image and every link to it"
                                      >
                                        <PenLine
                                          size={11}
                                          aria-hidden="true"
                                        />
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                      {/* An empty folder has no row to paint the line on, and
                          a folder always sits above whatever follows it, so a
                          real element cannot shift anything here either. */}
                      {dropRow === 0 && !groupNotes.length && (
                        <div className="drop-line" aria-hidden="true" />
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </nav>
          {/* The page following the pointer. It stays mounted so a drag can
              place it before it is shown, rather than flashing at the corner
              of the screen for the frame before the first move arrives. */}
          <div
            className={`drag-ghost ${draggedNoteId ? "is-dragging" : ""}`}
            ref={dragGhostRef}
            aria-hidden="true"
          >
            <GripVertical size={12} />
            <span>{notes.find((note) => note.id === draggedNoteId)?.title}</span>
          </div>

          <div className="library-foot">
            <div className="page-count">
              <BookOpen size={16} />
              <span>{notes.length} pages</span>
            </div>
            {desktopMode && nativeLibraryOpen && syncInfo?.configured && (
              <div
                className="sync-state"
                title={syncInfo.remote ?? undefined}
                aria-live="polite"
              >
                <GitBranch size={11} aria-hidden="true" />
                <span>
                  {syncBusy
                    ? "Syncing…"
                    : syncError
                      ? "Sync offline"
                      : syncInfo.changedFiles > 0
                        ? `${syncInfo.changedFiles} uncommitted change${
                            syncInfo.changedFiles === 1 ? "" : "s"
                          }`
                        : "Synced"}
                </span>
              </div>
            )}
            <button className="mini-open" onClick={openFolder}>
              <FolderOpen size={15} />
              {desktopMode && nativeLibraryOpen
                ? "Change folder"
                : "Open folder"}
            </button>
          </div>
        </aside>

        <section className="document-area">
          <div className="document-toolbar">
            {/* Where the reader is, counted within the folder they are
                reading: a page's neighbours are the pages beside it in its own
                folder. Each folder stands on its own, so nothing here numbers
                it against the others. Kept quiet on purpose — it is a glance,
                not a headline, and it sits above the page's own title. */}
            <div
              className="document-position"
              aria-label={`Page ${activeFileIndex + 1} of ${
                activeSectionNotes.length
              } in ${displayGroup(activeGroupPath)}`}
            >
              <span className="position-page">
                <span>Page</span>
                <strong>{String(activeFileIndex + 1).padStart(2, "0")}</strong>
                <small>
                  / {String(activeSectionNotes.length).padStart(2, "0")}
                </small>
              </span>
              <span className="position-path">
                <strong>{displayGroup(activeGroupPath)}</strong>
                <ChevronRight size={12} aria-hidden="true" />
                <span>{active.title}</span>
              </span>
            </div>

            <div className="document-actions">
              <div
                className="view-switcher"
                role="group"
                aria-label="Document view"
              >
                <button
                  className={view === "preview" ? "selected" : ""}
                  onClick={() => setView("preview")}
                  aria-label="Read view"
                  title="Read view"
                >
                  <BookOpen size={15} />
                  <span>Read</span>
                </button>
                <button
                  className={view === "editor" ? "selected" : ""}
                  onClick={() => setView("editor")}
                  aria-label="Write view"
                  title="Write view"
                >
                  <FileCode2 size={15} />
                  <span>Write</span>
                </button>
                <button
                  className={view === "split" ? "selected" : ""}
                  onClick={() => setView("split")}
                  aria-label="Split view"
                  title="Split view"
                >
                  <Columns2 size={15} />
                  <span>Split</span>
                </button>
              </div>
              {view === "split" && (
                <button
                  className={`icon-button split-lock-toggle ${
                    splitScrollLocked ? "active" : ""
                  }`}
                  onClick={() => setSplitScrollLocked((locked) => !locked)}
                  aria-pressed={splitScrollLocked}
                  aria-label={
                    splitScrollLocked
                      ? "Unlock synchronized scrolling"
                      : "Lock synchronized scrolling"
                  }
                  title={
                    splitScrollLocked
                      ? "Panes scroll together — click to scroll them independently"
                      : "Panes scroll independently — click to scroll them together"
                  }
                >
                  {splitScrollLocked ? (
                    <Lock size={14} />
                  ) : (
                    <LockOpen size={14} />
                  )}
                </button>
              )}
              {!desktopMode && (
                <button
                  className={`save-button ${saved ? "saved" : ""}`}
                  onClick={() => void saveActive()}
                  disabled={!dirty.has(active.id) && !saved}
                  title={
                    active.handle
                      ? "Save to Markdown file"
                      : "Download Markdown file"
                  }
                >
                  {saved ? (
                    <Check size={15} />
                  ) : active.handle ? (
                    <Save size={15} />
                  ) : (
                    <Download size={15} />
                  )}
                  <span>
                    {saved ? "Saved" : active.handle ? "Save" : "Export"}
                  </span>
                </button>
              )}
            </div>
            <span className="document-progress" aria-hidden="true">
              <i style={{ width: `${pageProgress}%` }} />
            </span>
          </div>

          <div className={`reading-scroll mode-${view}`}>
            {(view === "preview" || view === "split") && (
              <article
                className="markdown-page"
                ref={previewScrollRef}
                onScroll={handlePreviewScroll}
              >
                <div className="markdown-body" ref={markdownBodyRef}>
                  {markdown}
                </div>

                <nav className="page-turner" aria-label="Page navigation">
                  {activeIndex > 0 ? (
                    <button
                      onClick={() => selectNote(notes[activeIndex - 1].id)}
                    >
                      <ChevronLeft size={18} />
                      <span>
                        <small>Previous</small>
                        <strong>{notes[activeIndex - 1].title}</strong>
                      </span>
                    </button>
                  ) : (
                    <span />
                  )}
                  {activeIndex < notes.length - 1 ? (
                    <button
                      className="next"
                      onClick={() => selectNote(notes[activeIndex + 1].id)}
                    >
                      <span>
                        <small>Next</small>
                        <strong>{notes[activeIndex + 1].title}</strong>
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  ) : (
                    <span />
                  )}
                </nav>
              </article>
            )}

            {(view === "editor" || view === "split") && (
              <div className="editor-pane">
                <div className="editor-chrome">
                  <span className="editor-file">
                    <FileCode2 size={14} /> {active.path}
                    {dirty.has(active.id) && <i />}
                  </span>
                  <span className="editor-chrome-end">
                    <button
                      type="button"
                      className="editor-image-button"
                      onClick={() => void insertImagesFromPicker()}
                      title="Insert image — or paste and drop images right into the editor"
                      aria-label="Insert image"
                    >
                      <ImagePlus size={13} aria-hidden="true" />
                      <span>Image</span>
                    </button>
                    <input
                      ref={imageFileInput}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={handleImageFilePick}
                    />
                    <div className="editor-table-menu" ref={tableMenu}>
                      <button
                        type="button"
                        className="editor-image-button"
                        onClick={() => setTableMenuOpen((open) => !open)}
                        title="Insert a table"
                        aria-label="Insert a table"
                        aria-expanded={tableMenuOpen}
                        aria-haspopup="dialog"
                      >
                        <Table2 size={13} aria-hidden="true" />
                        <span>Table</span>
                      </button>
                      {tableMenuOpen && (
                        <div
                          className="table-popover"
                          role="dialog"
                          aria-label="Table size"
                        >
                          <div
                            className="table-grid"
                            ref={tableGrid}
                            role="group"
                            aria-label="Table size"
                          >
                            {Array.from(
                              { length: TABLE_MAX_ROWS },
                              (_, row) => (
                                <div className="table-grid-row" key={row}>
                                  {Array.from(
                                    { length: TABLE_MAX_COLUMNS },
                                    (_, column) => {
                                      const columns = column + 1;
                                      const rows = row + 1;
                                      const active =
                                        columns <= tableSize.columns &&
                                        rows <= tableSize.rows;
                                      return (
                                        <button
                                          type="button"
                                          key={column}
                                          data-cell={`${columns}x${rows}`}
                                          className={`table-grid-cell${active ? " active" : ""}${
                                            rows === 1 ? " heading" : ""
                                          }`}
                                          tabIndex={
                                            columns === tableSize.columns &&
                                            rows === tableSize.rows
                                              ? 0
                                              : -1
                                          }
                                          aria-label={`${columns} columns by ${rows} rows`}
                                          onKeyDown={handleTableGridKey}
                                          onMouseEnter={() =>
                                            setTableSize({ columns, rows })
                                          }
                                          onFocus={() =>
                                            setTableSize({ columns, rows })
                                          }
                                          onClick={() =>
                                            insertTable(columns, rows)
                                          }
                                        />
                                      );
                                    },
                                  )}
                                </div>
                              ),
                            )}
                          </div>
                          <p className="table-readout" aria-live="polite">
                            <strong>
                              {tableSize.columns} × {tableSize.rows}
                            </strong>
                            <span>
                              {tableSize.columns} column
                              {tableSize.columns === 1 ? "" : "s"}, header +{" "}
                              {tableSize.rows - 1} row
                              {tableSize.rows - 1 === 1 ? "" : "s"}
                            </span>
                          </p>
                        </div>
                      )}
                    </div>
                    <span className="editor-language">Markdown</span>
                  </span>
                </div>
                <div className="editor-workspace">
                  <CodeMirror
                    key={active.id}
                    className="folio-code-editor"
                    value={active.content}
                    height="100%"
                    theme="none"
                    extensions={editorExtensions}
                    basicSetup={EDITOR_BASIC_SETUP}
                    onCreateEditor={handleEditorCreate}
                    onChange={updateContent}
                    aria-label={`Edit ${active.title}`}
                  />
                </div>
                <div className="editor-status">
                  <span>
                    {active.content.split(/\s+/).filter(Boolean).length} words
                  </span>
                  <span>{active.content.length} characters</span>
                </div>
              </div>
            )}
          </div>
        </section>

        {outlineOpen && (
          <button
            className="scrim outline-scrim"
            onClick={() => setOutlineOpen(false)}
            aria-label="Close outline"
          />
        )}
        <aside
          id="outline-panel"
          className={`outline-panel ${outlineOpen ? "is-open" : ""}`}
        >
          <div className="panel-mobile-head">
            <span>On this page</span>
            <button
              className="icon-button"
              onClick={() => setOutlineOpen(false)}
              aria-label="Close outline"
            >
              <X size={18} />
            </button>
          </div>
          <section className="outline-section">
            <div className="aside-label">
              <ListTree size={15} />
              <span>On this page</span>
            </div>
            <nav className="heading-list" aria-label="Page headings">
              {pageHeadings.length ? (
                pageHeadings.map((heading) => (
                  <button
                    key={`${heading.slug}-${heading.depth}`}
                    className={heading.depth === 3 ? "nested" : ""}
                    onClick={() =>
                      document
                        .getElementById(heading.slug)
                        ?.scrollIntoView({ behavior: "smooth" })
                    }
                  >
                    {heading.text}
                  </button>
                ))
              ) : (
                <span className="empty-aside">No section headings</span>
              )}
            </nav>
          </section>

          <section className="backlinks-section">
            <div className="aside-label">
              <Link2 size={14} />
              <span>Linked from</span>
              <b>{backlinks.length}</b>
            </div>
            <div className="backlink-list">
              {backlinks.length ? (
                backlinks.map((note) => (
                  <button key={note.id} onClick={() => selectNote(note.id)}>
                    <FileText size={14} />
                    <span>
                      <strong>{note.title}</strong>
                      <small>{cleanGroup(note.path.split("/")[0])}</small>
                    </span>
                  </button>
                ))
              ) : (
                <span className="empty-aside">No pages link here yet</span>
              )}
            </div>
          </section>

          <div className="keyboard-hint">
            {(appShortcuts["previous-page"] || appShortcuts["next-page"]) && (
              <span>
                {appShortcuts["previous-page"] && (
                  <kbd>{formatShortcut(appShortcuts["previous-page"])}</kbd>
                )}
                {appShortcuts["next-page"] && (
                  <kbd>{formatShortcut(appShortcuts["next-page"])}</kbd>
                )}
                turn pages
              </span>
            )}
            {appShortcuts.save && (
              <span>
                <kbd>{formatShortcut(appShortcuts.save)}</kbd>{" "}
                {desktopMode ? "save now" : "save"}
              </span>
            )}
          </div>
        </aside>
      </div>

      {createKind && (
        <div
          className="create-layer"
          role="dialog"
          aria-modal="true"
          aria-label={`Create a new ${createKind}`}
        >
          <button
            className="command-backdrop"
            onClick={() => setCreateKind(undefined)}
            aria-label="Cancel"
          />
          <form className="create-dialog" onSubmit={createEntry}>
            <div className="create-dialog-head">
              <span className="create-dialog-icon">
                {createKind === "file" ? (
                  <FilePlus2 size={19} />
                ) : (
                  <FolderPlus size={19} />
                )}
              </span>
              <span>
                <small>New {createKind}</small>
                <strong>
                  {createKind === "file"
                    ? "Start a new page"
                    : "Organize your library"}
                </strong>
              </span>
              <button
                type="button"
                className="subtle-icon"
                onClick={() => setCreateKind(undefined)}
                aria-label="Close"
              >
                <X size={17} />
              </button>
            </div>

            <label className="create-field">
              <span>{createKind === "file" ? "File name" : "Folder name"}</span>
              <input
                ref={createNameInput}
                value={newEntryName}
                onChange={(event) => setNewEntryName(event.target.value)}
                placeholder={
                  createKind === "file" ? "Untitled note" : "New section"
                }
              />
            </label>

            <label className="create-field">
              <span>Location</span>
              <select
                value={newEntryParent}
                onChange={(event) => setNewEntryParent(event.target.value)}
              >
                <option value="">Library root</option>
                {folders.map((folder) => (
                  <option key={folder} value={folder}>
                    {displayGroup(folder)}
                  </option>
                ))}
              </select>
            </label>

            <p className="create-note">
              {desktopMode
                ? "This will be created on disk immediately and future edits will save automatically."
                : rootDirectory
                  ? "This will be created directly in your open folder."
                  : "This browser opened a read-only copy; new items remain in this session until exported."}
            </p>

            <div className="create-actions">
              <button type="button" onClick={() => setCreateKind(undefined)}>
                Cancel
              </button>
              <button type="submit" className="create-primary">
                Create {createKind}
              </button>
            </div>
          </form>
        </div>
      )}

      {searchOpen && (
        <div
          className="command-layer"
          role="dialog"
          aria-modal="true"
          aria-label="Find a page"
        >
          <button
            className="command-backdrop"
            onClick={() => setSearchOpen(false)}
            aria-label="Close search"
          />
          <div className="command-palette">
            <div className="command-input">
              <Search size={18} />
              <input
                ref={searchInput}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || !searchResults[0]) return;
                  event.preventDefault();
                  selectNote(searchResults[0].note.id);
                  setSearchOpen(false);
                  setSearchQuery("");
                }}
                placeholder="Search titles, sections, and contents…"
              />
              <kbd>esc</kbd>
            </div>
            <div className="command-results">
              <span className="result-label">
                {searchQuery.trim()
                  ? `${searchResults.length} matching ${searchResults.length === 1 ? "page" : "pages"}`
                  : "All pages"}
              </span>
              {searchResults.map(({ note, excerpts }) => (
                <button
                  key={note.id}
                  className="search-result"
                  onClick={() => {
                    selectNote(note.id);
                    setSearchOpen(false);
                    setSearchQuery("");
                  }}
                >
                  <span className="result-icon">
                    <FileText size={16} />
                  </span>
                  <span className="result-copy">
                    <strong>
                      {highlightSearchText(note.title, searchQuery)}
                    </strong>
                    <small>{highlightSearchText(note.path, searchQuery)}</small>
                    {excerpts.length > 0 && (
                      <span
                        className="result-excerpts"
                        aria-label="Matching lines"
                      >
                        {excerpts.map((excerpt) => (
                          <span
                            className="result-excerpt"
                            key={`${note.id}:${excerpt.line}`}
                          >
                            <span className="result-line">L{excerpt.line}</span>
                            <span>
                              {highlightSearchText(excerpt.text, searchQuery)}
                            </span>
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <ArrowRight className="result-arrow" size={15} />
                </button>
              ))}
              {!searchResults.length && (
                <div className="no-results">
                  No page matches “{searchQuery}”.
                </div>
              )}
            </div>
            <div className="command-foot">
              <span>
                <kbd>↵</kbd> open page
              </span>
              <span>
                {notes.length} pages in {libraryName}
              </span>
            </div>
          </div>
        </div>
      )}

      {entryMenu && (
        <div
          className="entry-menu"
          role="menu"
          tabIndex={-1}
          aria-label={
            entryMenu.kind === "folder" ? "Folder actions" : "Page actions"
          }
          style={{ left: entryMenu.x, top: entryMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(undefined);
              setRenamingEntry({ kind: entryMenu.kind, path: entryMenu.path });
            }}
          >
            <PenLine size={13} aria-hidden="true" />
            <span>Rename</span>
            <small>⏎</small>
          </button>
          <button
            type="button"
            role="menuitem"
            className="entry-menu-danger"
            onClick={() =>
              void deleteEntry({ kind: entryMenu.kind, path: entryMenu.path })
            }
          >
            <Trash2 size={13} aria-hidden="true" />
            <span>Move to Trash</span>
            <small>⌘⌫</small>
          </button>
        </div>
      )}

      {folderIconMenu && (
        <FolderIconPicker
          name={displayGroup(folderIconMenu.folder)}
          mark={folderIcons[folderIconMenu.folder]}
          at={folderIconMenu}
          onChoose={(mark) => setFolderIcon(folderIconMenu.folder, mark)}
          onChoosePicture={() => {
            const folder = folderIconMenu.folder;
            setFolderIconMenu(undefined);
            void chooseFolderPicture(folder);
          }}
        />
      )}

      <input
        ref={folderIconInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={handleFolderPicturePick}
      />

      {closePrompt !== undefined && (
        <>
          <div className="close-prompt-scrim" aria-hidden="true" />
          <div
            className="close-prompt"
            role="alertdialog"
            aria-modal="true"
            aria-label="Commit before quitting"
          >
            <strong>Commit before quitting?</strong>
            <p>
              {closePrompt} change{closePrompt === 1 ? "" : "s"} on this
              device {closePrompt === 1 ? "hasn't" : "haven't"} been committed
              to your sync repository. Folio can commit and sync{" "}
              {closePrompt === 1 ? "it" : "them"} now.
            </p>
            <div className="close-prompt-actions">
              <button
                type="button"
                className="close-prompt-stay"
                onClick={() => {
                  closeRef.current.prompted = false;
                  setClosePrompt(undefined);
                }}
              >
                Stay
              </button>
              <button
                type="button"
                className="close-prompt-skip"
                onClick={() => void nativeLibrary.approveClose()}
              >
                Quit without committing
              </button>
              <button
                type="button"
                className="close-prompt-commit"
                ref={(button) => button?.focus()}
                onClick={() => void commitAndQuit()}
              >
                Commit &amp; quit
              </button>
            </div>
          </div>
        </>
      )}

      {notice && (
        <div className="notice-toast" role="status">
          <Check size={15} />
          <span>{notice}</span>
          <button
            onClick={() => setNotice(undefined)}
            aria-label="Dismiss message"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="mobile-page-nav">
        <button
          onClick={() =>
            activeIndex > 0 && selectNote(notes[activeIndex - 1].id)
          }
          disabled={activeIndex === 0}
          aria-label="Previous page"
        >
          <ArrowLeft size={17} />
        </button>
        <span>
          {activeSectionNotes.length ? activeFileIndex + 1 : 0} /{" "}
          {activeSectionNotes.length}
        </span>
        <button
          onClick={() =>
            activeIndex < notes.length - 1 &&
            selectNote(notes[activeIndex + 1].id)
          }
          disabled={activeIndex === notes.length - 1}
          aria-label="Next page"
        >
          <ArrowRight size={17} />
        </button>
      </div>
    </main>
  );
}
