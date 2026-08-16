"use client";

import React, {
  type ChangeEvent,
  type DragEvent,
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
  parseImageTitle,
  setPythonFenceRunnable,
  shortcutFromEvent,
  shortcutMatches,
  toCodeMirrorSnippet,
} from "@/app/editor-utils.js";
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
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Command,
  Download,
  FileCode2,
  FilePlus2,
  FileText,
  FolderPlus,
  FolderOpen,
  GripVertical,
  ImagePlus,
  Keyboard,
  Link2,
  ListTree,
  Lock,
  LockOpen,
  Menu,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Save,
  Search,
  Sun,
  Trash2,
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
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
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

type ViewMode = "preview" | "editor" | "split";
type Theme = "light" | "dark";
type CreateKind = "file" | "folder";
type PreferenceTab = "appearance" | "shortcuts" | "snippets";
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
const FOLIO_NOTE_DRAG_TYPE = "application/x-folio-note";
type LibraryScan = { notes: Note[]; folders: string[] };

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
  { id: "find", label: "Find a page", group: "General", defaultShortcut: "Meta-k" },
  { id: "save", label: "Save now", group: "General", defaultShortcut: "Meta-s" },
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
  { id: "new-file", label: "New file", group: "Files", defaultShortcut: "Meta-n" },
  {
    id: "new-folder",
    label: "New folder",
    group: "Files",
    defaultShortcut: "Meta-Shift-n",
  },
  { id: "open-folder", label: "Open folder", group: "Files", defaultShortcut: "Meta-o" },
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
  { id: "iowan", label: "Iowan Old Style", category: "Serif", stack: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' },
  { id: "new-york", label: "New York", category: "Serif", stack: '"New York", "Iowan Old Style", Georgia, serif' },
  { id: "charter", label: "Charter", category: "Serif", stack: 'Charter, "Bitstream Charter", Georgia, serif' },
  { id: "georgia", label: "Georgia", category: "Serif", stack: 'Georgia, "Times New Roman", serif' },
  { id: "palatino", label: "Palatino", category: "Serif", stack: 'Palatino, "Palatino Linotype", Georgia, serif' },
  { id: "geist-sans", label: "Geist Sans", category: "Sans serif", stack: 'var(--font-geist-sans), -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif' },
  { id: "system", label: "System UI", category: "Sans serif", stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif' },
  { id: "avenir", label: "Avenir Next", category: "Sans serif", stack: '"Avenir Next", Avenir, "Helvetica Neue", sans-serif' },
  { id: "helvetica", label: "Helvetica Neue", category: "Sans serif", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: "futura", label: "Futura", category: "Sans serif", stack: 'Futura, "Avenir Next", Avenir, sans-serif' },
  { id: "trebuchet", label: "Trebuchet", category: "Sans serif", stack: '"Trebuchet MS", "Helvetica Neue", sans-serif' },
  { id: "geist-mono", label: "Geist Mono", category: "Monospace", stack: 'var(--font-geist-mono), "SFMono-Regular", Menlo, monospace' },
  { id: "sf-mono", label: "SF Mono", category: "Monospace", stack: '"SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, monospace' },
  { id: "menlo", label: "Menlo", category: "Monospace", stack: 'Menlo, Monaco, "Courier New", monospace' },
  { id: "monaco", label: "Monaco", category: "Monospace", stack: 'Monaco, Menlo, "Courier New", monospace' },
  { id: "courier", label: "Courier Prime", category: "Monospace", stack: '"Courier Prime", "Courier New", Courier, monospace' },
] as const;

type FontId = (typeof FONT_CHOICES)[number]["id"];
type FontCategory = (typeof FONT_CHOICES)[number]["category"];

const FONT_CATEGORIES: FontCategory[] = ["Serif", "Sans serif", "Monospace"];

function isFontId(value: string | null): value is FontId {
  return FONT_CHOICES.some((font) => font.id === value);
}

function fontStack(id: FontId) {
  return FONT_CHOICES.find((font) => font.id === id)?.stack ?? FONT_CHOICES[0].stack;
}

const COLOR_PALETTES = [
  { id: "sage", label: "Sage", description: "Greenish gray", swatches: ["#f3f1ea", "#45664e", "#252621"] },
  { id: "slate", label: "Slate", description: "Bluish gray", swatches: ["#edf1f4", "#476d8a", "#20262b"] },
  { id: "graphite", label: "Graphite", description: "Neutral gray", swatches: ["#f1f1f1", "#61666b", "#222222"] },
  { id: "sepia", label: "Sepia", description: "Warm paper", swatches: ["#f3ecdf", "#876342", "#2b251e"] },
  { id: "plum", label: "Plum", description: "Muted violet", swatches: ["#f1edf3", "#765d82", "#29232c"] },
] as const;

type PaletteId = (typeof COLOR_PALETTES)[number]["id"];

function isPaletteId(value: string | null): value is PaletteId {
  return COLOR_PALETTES.some((palette) => palette.id === value);
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

function freshDefaultTextSnippets() {
  return DEFAULT_TEXT_SNIPPETS.map((snippet) => ({ ...snippet }));
}

function freshDefaultAppShortcuts() {
  return Object.fromEntries(
    APP_SHORTCUT_COMMANDS.map(({ id, defaultShortcut }) => [id, defaultShortcut]),
  ) as AppShortcuts;
}

function parseStoredAppShortcuts(value: string | null) {
  if (!value) return;
  try {
    const stored = JSON.parse(value) as Partial<StoredAppShortcutSettings>;
    if (stored.version !== 1 || !stored.shortcuts || typeof stored.shortcuts !== "object") {
      return;
    }
    const shortcuts = freshDefaultAppShortcuts();
    for (const { id } of APP_SHORTCUT_COMMANDS) {
      const shortcut = stored.shortcuts[id];
      if (typeof shortcut === "string" && (!shortcut || isCommandShortcut(shortcut))) {
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
  if (snippetConflict) return `Already assigned to ${snippetConflict.name || "a text snippet"}.`;
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
    Object.values(appShortcuts).filter(Boolean).map((shortcut) => shortcut.toLowerCase()),
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
    const insert = applyCodeMirrorSnippet(toCodeMirrorSnippet(textSnippet.template));
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
    parts.push(<mark key={`${matchIndex}-${end}`}>{value.slice(matchIndex, end)}</mark>);
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
  if (handle.queryPermission && (await handle.queryPermission(options)) === "granted") {
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
  return content.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => {
    const href = `wiki:${encodeURIComponent(target.trim())}`;
    return `[${(label || target).trim()}](${href})`;
  });
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
      const replacement = match[1] !== undefined
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

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
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
      tag: [
        tags.typeName,
        tags.className,
        tags.namespace,
        tags.attributeName,
      ],
      color: "var(--syntax-type)",
    },
    {
      tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
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
function markdownHeading<Tag extends "h1" | "h2" | "h3" | "h4">(HeadingTag: Tag) {
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
      if (typeof child === "string" || typeof child === "number") return String(child);
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
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }),
  );
  folders.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  return { notes, folders };
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
      images.push({ src, alt: imageAltFromName(file.name || "") });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  insertImageMarkdown(view, pos, images);
}

export default function Home() {
  const [notes, setNotes] = useState<Note[]>(SAMPLE_NOTES);
  const [folders, setFolders] = useState<string[]>(SAMPLE_FOLDERS);
  const [rootDirectory, setRootDirectory] = useState<DirectoryHandleLike>();
  const [activeId, setActiveId] = useState(SAMPLE_NOTES[0].id);
  const [libraryName, setLibraryName] = useState("The Folio Field Guide");
  const [view, setView] = useState<ViewMode>("preview");
  const [theme, setTheme] = useState<Theme>("light");
  const [palette, setPalette] = useState<PaletteId>("sage");
  const [readerFont, setReaderFont] = useState<FontId>("iowan");
  const [editorFont, setEditorFont] = useState<FontId>("sf-mono");
  const [appearancePreferencesLoaded, setAppearancePreferencesLoaded] = useState(false);
  const [preferenceTab, setPreferenceTab] = useState<PreferenceTab>("appearance");
  const [textSnippets, setTextSnippets] = useState<TextSnippet[]>(
    freshDefaultTextSnippets,
  );
  const [snippetPreferencesLoaded, setSnippetPreferencesLoaded] = useState(false);
  const [appShortcuts, setAppShortcuts] = useState<AppShortcuts>(
    freshDefaultAppShortcuts,
  );
  const [appShortcutsLoaded, setAppShortcutsLoaded] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [splitScrollLocked, setSplitScrollLocked] = useState(true);
  const [layoutPreferencesLoaded, setLayoutPreferencesLoaded] = useState(false);
  const [desktopMode] = useState(() => isNativeRuntime());
  const [nativeLibraryOpen, setNativeLibraryOpen] = useState(false);
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [createKind, setCreateKind] = useState<CreateKind>();
  const [newEntryName, setNewEntryName] = useState("");
  const [newEntryParent, setNewEntryParent] = useState("");
  const [draggedNoteId, setDraggedNoteId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
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
  const draggedNoteIdRef = useRef<string | undefined>(undefined);
  const nativeSaveTimers = useRef<Map<string, number>>(new Map());
  const nativePendingSaves = useRef<
    Map<string, { path: string; content: string }>
  >(new Map());
  const nativeSavesInFlight = useRef<Map<string, Promise<void>>>(new Map());
  const nativeSavedTimer = useRef<number | undefined>(undefined);
  const nativeWindowClosing = useRef(false);
  const activeIdRef = useRef(activeId);
  const lastSingleViewRef = useRef<Exclude<ViewMode, "split">>("preview");
  const imageFileInput = useRef<HTMLInputElement>(null);

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
      if (editorViewRef.current === editor) splitScrollEventRef.current?.("editor");
    });
    splitScrollMapRef.current = undefined;
    splitScrollRefreshRef.current?.("editor");
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
      ...createEditorImageExtensions({
        notePath: imageNotePath,
        nativeStore: imageNativeStore,
        notice: showNotice,
      }),
    ],
    [
      appShortcuts,
      imageNativeStore,
      imageNotePath,
      showNotice,
      textSnippets,
      theme,
    ],
  );

  const grouped = useMemo(() => {
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
  const pageProgress = notes.length ? ((activeIndex + 1) / notes.length) * 100 : 0;

  const pageHeadings = useMemo(
    () => headingsFrom(active?.content ?? ""),
    [active?.content],
  );

  const backlinks = useMemo(() => {
    if (!active) return [];
    const base = active.path.split("/").pop()?.replace(/\.md$/i, "") ?? active.title;
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
      return notes.map<SearchResult>((note) => ({ note, score: 0, excerpts: [] }));
    }
    return notes
      .map<SearchResult>((note) => {
        const titleMatch = note.title.toLowerCase().includes(normalizedQuery);
        const pathMatch = note.path.toLowerCase().includes(normalizedQuery);
        const contentMatch = note.content.toLowerCase().includes(normalizedQuery);
        const excerpts = contentMatch ? extractSearchExcerpts(note.content, query) : [];
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

  const applyNativeLibrary = useCallback(
    (snapshot: LibrarySnapshot, preferredPath?: string) => {
      setNotes(snapshot.notes);
      setFolders(snapshot.folders);
      setRootDirectory(undefined);
      const preferred = preferredPath
        ? snapshot.notes.find((note) => note.path === preferredPath)
        : undefined;
      setActiveId(preferred?.id ?? snapshot.notes[0]?.id ?? "");
      setLibraryName(snapshot.name);
      setNativeLibraryOpen(true);
      setDirty(new Set());
      setCollapsedGroups(new Set());
    },
    [],
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
      const previewOrigin = preview.getBoundingClientRect().top - preview.scrollTop;
      const lastLine = editor.state.doc.lines;
      const scroller = editor.scrollDOM;

      for (const anchor of body.querySelectorAll<HTMLElement>("[data-source-line]")) {
        const sourceLine = Number(anchor.dataset.sourceLine);
        if (!Number.isInteger(sourceLine) || sourceLine < 1 || sourceLine > lastLine) {
          continue;
        }
        const editorOffset =
          editor.documentPadding.top +
          editor.lineBlockAt(editor.state.doc.line(sourceLine).from).top;
        const previewOffset = anchor.getBoundingClientRect().top - previewOrigin;
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
          ? mapScrollOffset(source.scrollTop, map.editorOffsets, map.previewOffsets)
          : mapScrollOffset(source.scrollTop, map.previewOffsets, map.editorOffsets);
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
      splitScrollFrameRef.current = window.requestAnimationFrame(syncSplitScroll);
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
    const observer = new ResizeObserver(() => splitScrollRefreshRef.current?.());
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
    const frame = window.requestAnimationFrame(() => createNameInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [createKind]);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => searchInput.current?.focus());
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
      const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
      const storedPalette = localStorage.getItem("folio-color-palette");
      const storedReaderFont = localStorage.getItem("folio-reader-font");
      const storedEditorFont = localStorage.getItem("folio-editor-font");
      setTheme(storedTheme ?? preferred);
      if (isPaletteId(storedPalette)) setPalette(storedPalette);
      if (isFontId(storedReaderFont)) setReaderFont(storedReaderFont);
      if (isFontId(storedEditorFont)) setEditorFont(storedEditorFont);
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
    const stored: StoredSnippetSettings = { version: 1, snippets: textSnippets };
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
      setLibraryCollapsed(localStorage.getItem("folio-library-collapsed") === "true");
      setOutlineCollapsed(localStorage.getItem("folio-outline-collapsed") === "true");
      setSplitScrollLocked(localStorage.getItem("folio-split-scroll-locked") !== "false");
      setLayoutPreferencesLoaded(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!layoutPreferencesLoaded) return;
    localStorage.setItem("folio-library-collapsed", String(libraryCollapsed));
    localStorage.setItem("folio-outline-collapsed", String(outlineCollapsed));
    localStorage.setItem("folio-split-scroll-locked", String(splitScrollLocked));
  }, [layoutPreferencesLoaded, libraryCollapsed, outlineCollapsed, splitScrollLocked]);

  useEffect(() => {
    if (!desktopMode) return;
    let cancelled = false;

    void (async () => {
      try {
        const restored = await nativeLibrary.restore();
        if (!cancelled && restored) {
          applyNativeLibrary(restored);
        } else if (!cancelled) {
          const message = "Choose a Markdown folder when you're ready to open your library.";
          setNotice(message);
          window.setTimeout(
            () => setNotice((current) => (current === message ? undefined : current)),
            4800,
          );
        }
      } catch {
        if (cancelled) return;
        const message = "Folio could not reopen that folder. Choose it again to reconnect.";
        setNotice(message);
        window.setTimeout(
          () => setNotice((current) => (current === message ? undefined : current)),
          4800,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyNativeLibrary, desktopMode]);

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
          names.map((name) => ({ src: name, alt: imageAltFromName(name) })),
        );
      } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error));
      }
    } else {
      imageFileInput.current?.click();
    }
  }, [active.id, active.path, desktopMode, nativeLibraryOpen, showNotice]);

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
        showNotice(`That shortcut is already assigned to ${appConflict.label}.`);
        return;
      }
      if (
        textSnippets.some(
          (candidate) =>
            candidate.id !== id &&
            candidate.shortcut.toLowerCase() === shortcut.toLowerCase(),
        )
      ) {
        showNotice("That shortcut is already assigned to another text snippet.");
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
        showNotice(`That shortcut is already assigned to ${commandConflict.label}.`);
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
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
    }
  }, [flushNativeSave]);

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
            flushAllNativeSaves().catch(() => undefined),
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
  }, [desktopMode, flushAllNativeSaves]);

  const beginCreate = useCallback((kind: CreateKind) => {
    if (desktopMode && !nativeLibraryOpen) {
      showNotice("Choose a library folder before creating files or sections.");
      return;
    }
    setCreateKind(kind);
    setNewEntryName("");
    setNewEntryParent(
      active.id === EMPTY_NOTE.id ? "" : parentPath(active.path),
    );
  }, [active.id, active.path, desktopMode, nativeLibraryOpen, showNotice]);

  const createEntry = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!createKind) return;

    const rawName = newEntryName.trim();
    if (!rawName) {
      showNotice(`Enter a ${createKind} name.`);
      return;
    }
    if (/[\\/:*?"<>|]/.test(rawName)) {
      showNotice("Names cannot contain \\ / : * ? \" < > or |.");
      return;
    }

    if (createKind === "folder") {
      const folderPath = joinPath(newEntryParent, rawName);
      if (folders.some((folder) => folder.toLowerCase() === folderPath.toLowerCase())) {
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
          const parent = await getDirectoryAtPath(rootDirectory, newEntryParent);
          await parent.getDirectoryHandle(rawName, { create: true });
        }
        if (!desktopMode) {
          setFolders((current) =>
            [...current, folderPath].sort((a, b) =>
              a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
            ),
          );
        }
        setCollapsedGroups((current) => {
          const next = new Set(current);
          next.delete(folderPath);
          return next;
        });
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

  const moveNote = async (noteId: string, targetFolder: string) => {
    draggedNoteIdRef.current = undefined;
    setDropTarget(undefined);
    setDraggedNoteId(undefined);
    const note = notes.find((item) => item.id === noteId);
    if (!note || parentPath(note.path) === targetFolder) return;

    const originalName = fileNameFromPath(note.path);
    const extensionIndex = originalName.toLowerCase().lastIndexOf(".md");
    const baseName = extensionIndex >= 0 ? originalName.slice(0, extensionIndex) : originalName;
    const extension = extensionIndex >= 0 ? originalName.slice(extensionIndex) : ".md";
    let destinationName = originalName;
    let counter = 2;
    while (
      notes.some(
        (item) =>
          item.id !== note.id &&
          item.path.toLowerCase() === joinPath(targetFolder, destinationName).toLowerCase(),
      )
    ) {
      destinationName = `${baseName} ${counter}${extension}`;
      counter += 1;
    }
    const destinationPath = joinPath(targetFolder, destinationName);

    try {
      if (desktopMode) {
        await flushAllNativeSaves();
        const snapshot = await nativeLibrary.move(note.path, destinationPath);
        const preferredPath = active.id === note.id ? destinationPath : active.path;
        applyNativeLibrary(snapshot, preferredPath);
        showNotice(`Moved ${note.title} to ${displayGroup(targetFolder)}.`);
        return;
      }

      let destinationHandle = note.handle;
      if (rootDirectory) {
        if (!(await hasWritePermission(rootDirectory))) {
          showNotice("Write access is needed to move a file.");
          return;
        }
        const destinationDirectory = await getDirectoryAtPath(
          rootDirectory,
          targetFolder,
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

      setNotes((current) =>
        current
          .map((item) =>
            item.id === note.id
              ? { ...item, path: destinationPath, handle: destinationHandle }
              : item,
          )
          .sort((a, b) =>
            a.path.localeCompare(b.path, undefined, {
              numeric: true,
              sensitivity: "base",
            }),
          ),
      );
      if (rootDirectory) {
        setDirty((current) => {
          const next = new Set(current);
          next.delete(note.id);
          return next;
        });
      }
      showNotice(`Moved ${note.title} to ${displayGroup(targetFolder)}.`);
    } catch {
      showNotice("Folio could not move that file. The original was kept in place.");
    }
  };

  const startNoteDrag = (
    event: DragEvent<HTMLButtonElement>,
    noteId: string,
  ) => {
    draggedNoteIdRef.current = noteId;
    setDraggedNoteId(noteId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(FOLIO_NOTE_DRAG_TYPE, noteId);
    event.dataTransfer.setData("text/plain", noteId);
  };

  const downloadNote = useCallback((note: Note) => {
    const blob = new Blob([note.content], { type: "text/markdown;charset=utf-8" });
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
        applyNativeLibrary(snapshot);
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
      setRootDirectory(directory);
      setActiveId(loaded.notes[0]?.id ?? "");
      setLibraryName(directory.name);
      setDirty(new Set());
      setCollapsedGroups(new Set());
      setView("preview");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      folderInput.current?.click();
    }
  }, [applyNativeLibrary, desktopMode, flushAllNativeSaves, showNotice]);

  const executeAppCommand = useCallback(
    (commandId: AppCommandId) => {
      switch (commandId) {
        case "find":
          setSearchOpen(true);
          return;
        case "save":
          void saveActive();
          return;
        case "previous-page":
          if (activeIndex > 0) selectNote(notes[activeIndex - 1].id);
          return;
        case "next-page":
          if (activeIndex < notes.length - 1) selectNote(notes[activeIndex + 1].id);
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
            const singleView = current === "split" ? lastSingleViewRef.current : current;
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
    [activeIndex, beginCreate, notes, openFolder, saveActive, selectNote],
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

      const pressedShortcut = shortcutFromEvent(event, { allowUnmodified: true });
      if (!pressedShortcut) return;
      const command = APP_SHORTCUT_COMMANDS.find(
        ({ id }) => shortcutMatches(appShortcuts[id], pressedShortcut),
      );
      if (!command) return;

      const isTyping =
        Boolean(
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
    loaded.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
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
    setRootDirectory(undefined);
    setActiveId(loaded[0].id);
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

  const findLinkedNote = useCallback((href: string) => {
    const currentNotes = notesRef.current;
    if (href.startsWith("wiki:")) {
      const target = decodeURIComponent(href.slice(5)).toLowerCase();
      return currentNotes.find(
        (note) =>
          note.title.toLowerCase() === target ||
          note.path.split("/").pop()?.replace(/\.md$/i, "").toLowerCase() === target,
      );
    }
    const activePath =
      currentNotes.find((note) => note.id === activeIdRef.current)?.path ?? "";
    const withoutHash = decodeURIComponent(href.split("#")[0]);
    const base = activePath.includes("/")
      ? activePath.slice(0, activePath.lastIndexOf("/") + 1)
      : "";
    const resolved = normalizePath(
      withoutHash.startsWith("/") ? withoutHash.slice(1) : `${base}${withoutHash}`,
    ).toLowerCase();
    return currentNotes.find(
      (note) =>
        normalizePath(note.path).toLowerCase() === resolved ||
        note.path.split("/").pop()?.toLowerCase() === withoutHash.split("/").pop()?.toLowerCase(),
    );
  }, []);

  const handleMarkdownLink = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, href?: string) => {
      if (!href || href.startsWith("#")) return;
      const linked = findLinkedNote(href);
      if (!linked) return;
      event.preventDefault();
      selectNote(linked.id);
      const hash = href.split("#")[1];
      if (hash) {
        window.setTimeout(() => document.getElementById(hash)?.scrollIntoView(), 50);
      }
    },
    [findLinkedNote, selectNote],
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
          <code
            className={className}
            data-language={language}
          >
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
      remarkPlugins={[
        remarkGfm,
        [remarkMath, { singleDollarTextMath: true }],
      ]}
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
            {libraryCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
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
          <button className="search-trigger" onClick={() => setSearchOpen(true)}>
            <Search size={15} />
            <span>Find a page</span>
            {appShortcuts.find && <kbd>{formatShortcut(appShortcuts.find)}</kbd>}
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
            {outlineCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
          </button>
          <button className="open-button" onClick={openFolder}>
            <FolderOpen size={16} />
            <span>{desktopMode && nativeLibraryOpen ? "Change folder" : "Open folder"}</span>
          </button>
          {!desktopMode && (
            <input
              ref={folderInput}
              className="visually-hidden"
              type="file"
              multiple
              accept=".md,text/markdown"
              onChange={importFolder}
              {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
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

            <div className="preference-tabs" role="tablist" aria-label="Preferences sections">
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
                  <legend>Color scheme</legend>
                  <div className="palette-grid" role="radiogroup" aria-label="Color scheme">
                    {COLOR_PALETTES.map((colorPalette) => (
                      <button
                        type="button"
                        key={colorPalette.id}
                        className={palette === colorPalette.id ? "selected" : ""}
                        onClick={() => setPalette(colorPalette.id)}
                        role="radio"
                        aria-checked={palette === colorPalette.id}
                        title={colorPalette.description}
                      >
                        <span className="palette-swatches" aria-hidden="true">
                          {colorPalette.swatches.map((color) => (
                            <i key={color} style={{ background: color }} />
                          ))}
                        </span>
                        <span>
                          <strong>{colorPalette.label}</strong>
                          <small>{colorPalette.description}</small>
                        </span>
                        {palette === colorPalette.id && <Check size={13} />}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className="font-control">
                  <span>Reader font</span>
                  <select
                    value={readerFont}
                    onChange={(event) => setReaderFont(event.target.value as FontId)}
                  >
                    {FONT_CATEGORIES.map((category) => (
                      <optgroup key={category} label={category}>
                        {FONT_CHOICES.filter((font) => font.category === category).map(
                          (font) => (
                            <option key={font.id} value={font.id}>
                              {font.label}
                            </option>
                          ),
                        )}
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
                    onChange={(event) => setEditorFont(event.target.value as FontId)}
                  >
                    {FONT_CATEGORIES.map((category) => (
                      <optgroup key={category} label={category}>
                        {FONT_CHOICES.filter((font) => font.category === category).map(
                          (font) => (
                            <option key={font.id} value={font.id}>
                              {font.label}
                            </option>
                          ),
                        )}
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
                <p className="font-footnote">Preferences stay on this device.</p>
              </div>
            )}

            {preferenceTab === "shortcuts" && (
              <div className="preference-pane shortcut-preferences" role="tabpanel">
                <p className="shortcut-help">
                  Focus a shortcut field and press the keys you want. Backspace clears a
                  binding. Bare navigation and function keys are allowed; printable keys need
                  Ctrl, Command, or Alt. Modified shortcuts also work while writing.
                </p>
                <div className="app-shortcut-groups">
                  {(["General", "Navigation", "Files", "View"] as const).map((group) => (
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
                          <label className="app-shortcut-row" key={command.id}>
                            <span>{command.label}</span>
                            <input
                              className={`shortcut-recorder ${issue ? "has-issue" : ""}`}
                              value={formatShortcut(appShortcuts[command.id])}
                              onKeyDown={(event) =>
                                recordAppShortcut(event, command.id)
                              }
                              onFocus={(event) => event.currentTarget.select()}
                              readOnly
                              aria-label={`Record shortcut for ${command.label}`}
                              aria-invalid={Boolean(issue)}
                              title="Focus, then press the shortcut. Backspace clears it."
                            />
                            {issue && <small className="shortcut-issue">{issue}</small>}
                          </label>
                        );
                      })}
                    </fieldset>
                  ))}
                </div>
                <div className="snippet-actions shortcut-actions">
                  <button
                    type="button"
                    onClick={restoreDefaultAppShortcuts}
                  >
                    Restore defaults
                  </button>
                </div>
              </div>
            )}

            {preferenceTab === "snippets" && (
              <div className="preference-pane snippet-preferences" role="tabpanel">
                <p className="snippet-help">
                  Record a shortcut, then enter the text it should insert. Use <code>$1</code>,{" "}
                  <code>$2</code>, and so on for Tab stops; <code>$0</code> is the final cursor.
                  Write <code>\$1</code> for literal text.
                </p>
                <div className="snippet-list">
                  {textSnippets.map((textSnippet, index) => {
                    const issue = snippetShortcutIssue(
                      textSnippet,
                      textSnippets,
                      appShortcuts,
                    );
                    return (
                      <article
                        className={`snippet-card ${textSnippet.enabled ? "" : "disabled"}`}
                        key={textSnippet.id}
                      >
                        <div className="snippet-card-head">
                          <strong>Snippet {index + 1}</strong>
                          <label className="snippet-enabled">
                            <input
                              type="checkbox"
                              checked={textSnippet.enabled}
                              onChange={(event) =>
                                updateTextSnippet(textSnippet.id, {
                                  enabled: event.target.checked,
                                })
                              }
                            />
                            <span>Enabled</span>
                          </label>
                          <button
                            type="button"
                            className="subtle-icon"
                            onClick={() =>
                              setTextSnippets((current) =>
                                current.filter((candidate) => candidate.id !== textSnippet.id),
                              )
                            }
                            aria-label={`Delete ${textSnippet.name || "snippet"}`}
                            title="Delete snippet"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        <label className="snippet-field">
                          <span>Name</span>
                          <input
                            value={textSnippet.name}
                            onChange={(event) =>
                              updateTextSnippet(textSnippet.id, { name: event.target.value })
                            }
                            placeholder="Snippet name"
                          />
                        </label>
                        <label className="snippet-field">
                          <span>Shortcut</span>
                          <input
                            className={`shortcut-recorder ${issue ? "has-issue" : ""}`}
                            value={formatShortcut(textSnippet.shortcut)}
                            onKeyDown={(event) =>
                              recordSnippetShortcut(event, textSnippet.id)
                            }
                            onFocus={(event) => event.currentTarget.select()}
                            readOnly
                            aria-label={`Record shortcut for ${textSnippet.name || "snippet"}`}
                            aria-invalid={Boolean(issue)}
                            title="Focus, then press the shortcut. Backspace clears it."
                          />
                        </label>
                        {issue && <small className="snippet-issue">{issue}</small>}
                        <label className="snippet-field snippet-template">
                          <span>Text to insert</span>
                          <textarea
                            rows={5}
                            value={textSnippet.template}
                            onChange={(event) =>
                              updateTextSnippet(textSnippet.id, { template: event.target.value })
                            }
                            spellCheck={false}
                          />
                        </label>
                      </article>
                    );
                  })}
                  {!textSnippets.length && (
                    <p className="snippet-empty">No snippets yet. Add one to get started.</p>
                  )}
                </div>
                <div className="snippet-actions">
                  <button type="button" onClick={addTextSnippet}>
                    <Plus size={14} /> Add snippet
                  </button>
                  <button
                    type="button"
                    onClick={restoreDefaultTextSnippets}
                  >
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
        <aside id="library-panel" className={`library-panel ${navOpen ? "is-open" : ""}`}>
          <div className="panel-mobile-head">
            <span>Library</span>
            <button className="icon-button" onClick={() => setNavOpen(false)} aria-label="Close library">
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

          <nav className="section-list" aria-label="Library pages">
            {grouped.map(([group, groupNotes], groupIndex) => {
              const collapsed = collapsedGroups.has(group);
              return (
                <section
                  className={`section-group ${
                    group === activeGroupPath ? "active-section" : ""
                  } ${dropTarget === group ? "drop-target" : ""}`}
                  key={group || "__root__"}
                  data-folder-path={group}
                  onDragEnter={(event) => {
                    const hasFolioNote =
                      Boolean(draggedNoteIdRef.current) ||
                      Array.from(event.dataTransfer.types).includes(
                        FOLIO_NOTE_DRAG_TYPE,
                      );
                    if (!hasFolioNote) return;
                    event.preventDefault();
                    setDropTarget(group);
                  }}
                  onDragOver={(event) => {
                    const hasFolioNote =
                      Boolean(draggedNoteIdRef.current) ||
                      Array.from(event.dataTransfer.types).includes(
                        FOLIO_NOTE_DRAG_TYPE,
                      );
                    if (!hasFolioNote) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDropTarget(group);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                      setDropTarget(undefined);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const noteId =
                      draggedNoteIdRef.current ||
                      event.dataTransfer.getData(FOLIO_NOTE_DRAG_TYPE) ||
                      event.dataTransfer.getData("text/plain");
                    if (noteId) void moveNote(noteId, group);
                  }}
                >
                  <button
                    className="section-label"
                    onClick={() =>
                      setCollapsedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group)) next.delete(group);
                        else next.add(group);
                        return next;
                      })
                    }
                  >
                    <span>{String(groupIndex + 1).padStart(2, "0")}</span>
                    <strong>{displayGroup(group)}</strong>
                    <small>{groupNotes.length}</small>
                    <ChevronDown size={14} className={collapsed ? "rotated" : ""} />
                  </button>
                  {!collapsed && (
                    <div className="page-list">
                      {groupNotes.map((note, noteIndex) => (
                        <button
                          key={note.id}
                          className={`page-row ${note.id === active.id ? "active" : ""} ${
                            draggedNoteId === note.id ? "dragging" : ""
                          }`}
                          onClick={() => selectNote(note.id)}
                          draggable
                          onDragStart={(event) => startNoteDrag(event, note.id)}
                          onDragEnd={() => {
                            draggedNoteIdRef.current = undefined;
                            setDraggedNoteId(undefined);
                            setDropTarget(undefined);
                          }}
                          title="Open this page, or drag it into another folder"
                        >
                          <span className="page-spine" />
                          <span className="page-order">
                            {String(noteIndex + 1).padStart(2, "0")}
                          </span>
                          <span className="page-title">{note.title}</span>
                          {dirty.has(note.id) && <i aria-label="Unsaved changes" />}
                          <GripVertical className="drag-handle" size={13} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </nav>

          <div className="library-foot">
            <div className="page-count">
              <BookOpen size={16} />
              <span>{notes.length} pages</span>
            </div>
            <button className="mini-open" onClick={openFolder}>
              <FolderOpen size={15} /> Change folder
            </button>
          </div>
        </aside>

        <section className="document-area">
          <div className="document-toolbar">
            <div
              className="document-position"
              aria-label={`Page ${activeIndex + 1} of ${notes.length}, section ${
                activeSectionIndex + 1
              } of ${grouped.length}, file ${activeFileIndex + 1} of ${
                activeSectionNotes.length
              }`}
            >
              <span className="position-page">
                <span>Page</span>
                <strong>{String(activeIndex + 1).padStart(2, "0")}</strong>
                <small>/ {String(notes.length).padStart(2, "0")}</small>
              </span>
              <span className="position-copy">
                <span className="position-overline">
                  Section {String(activeSectionIndex + 1).padStart(2, "0")} of{" "}
                  {String(grouped.length).padStart(2, "0")}
                  <i aria-hidden="true">•</i>
                  File {String(activeFileIndex + 1).padStart(2, "0")} of{" "}
                  {String(activeSectionNotes.length).padStart(2, "0")}
                </span>
                <span className="position-path">
                  <strong>{displayGroup(activeGroupPath)}</strong>
                  <ChevronRight size={12} aria-hidden="true" />
                  <span>{active.title}</span>
                </span>
              </span>
            </div>

            <div className="document-actions">
              <div className="view-switcher" role="group" aria-label="Document view">
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
                  {splitScrollLocked ? <Lock size={14} /> : <LockOpen size={14} />}
                </button>
              )}
              {!desktopMode && (
                <button
                  className={`save-button ${saved ? "saved" : ""}`}
                  onClick={() => void saveActive()}
                  disabled={!dirty.has(active.id) && !saved}
                  title={active.handle ? "Save to Markdown file" : "Download Markdown file"}
                >
                  {saved ? (
                    <Check size={15} />
                  ) : active.handle ? (
                    <Save size={15} />
                  ) : (
                    <Download size={15} />
                  )}
                  <span>{saved ? "Saved" : active.handle ? "Save" : "Export"}</span>
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
                <div className="markdown-body" ref={markdownBodyRef}>{markdown}</div>

                <nav className="page-turner" aria-label="Page navigation">
                  {activeIndex > 0 ? (
                    <button onClick={() => selectNote(notes[activeIndex - 1].id)}>
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
                    <button className="next" onClick={() => selectNote(notes[activeIndex + 1].id)}>
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
                  <span>{active.content.split(/\s+/).filter(Boolean).length} words</span>
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
        <aside id="outline-panel" className={`outline-panel ${outlineOpen ? "is-open" : ""}`}>
          <div className="panel-mobile-head">
            <span>On this page</span>
            <button className="icon-button" onClick={() => setOutlineOpen(false)} aria-label="Close outline">
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
                    onClick={() => document.getElementById(heading.slug)?.scrollIntoView({ behavior: "smooth" })}
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
                  {createKind === "file" ? "Start a new page" : "Organize your library"}
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
                placeholder={createKind === "file" ? "Untitled note" : "New section"}
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
        <div className="command-layer" role="dialog" aria-modal="true" aria-label="Find a page">
          <button className="command-backdrop" onClick={() => setSearchOpen(false)} aria-label="Close search" />
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
                  <span className="result-icon"><FileText size={16} /></span>
                  <span className="result-copy">
                    <strong>{highlightSearchText(note.title, searchQuery)}</strong>
                    <small>{highlightSearchText(note.path, searchQuery)}</small>
                    {excerpts.length > 0 && (
                      <span className="result-excerpts" aria-label="Matching lines">
                        {excerpts.map((excerpt) => (
                          <span className="result-excerpt" key={`${note.id}:${excerpt.line}`}>
                            <span className="result-line">L{excerpt.line}</span>
                            <span>{highlightSearchText(excerpt.text, searchQuery)}</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <ArrowRight className="result-arrow" size={15} />
                </button>
              ))}
              {!searchResults.length && (
                <div className="no-results">No page matches “{searchQuery}”.</div>
              )}
            </div>
            <div className="command-foot">
              <span><kbd>↵</kbd> open page</span>
              <span>{notes.length} pages in {libraryName}</span>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div className="notice-toast" role="status">
          <Check size={15} />
          <span>{notice}</span>
          <button onClick={() => setNotice(undefined)} aria-label="Dismiss message">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="mobile-page-nav">
        <button
          onClick={() => activeIndex > 0 && selectNote(notes[activeIndex - 1].id)}
          disabled={activeIndex === 0}
          aria-label="Previous page"
        >
          <ArrowLeft size={17} />
        </button>
        <span>{notes.length ? activeIndex + 1 : 0} / {notes.length}</span>
        <button
          onClick={() => activeIndex < notes.length - 1 && selectNote(notes[activeIndex + 1].id)}
          disabled={activeIndex === notes.length - 1}
          aria-label="Next page"
        >
          <ArrowRight size={17} />
        </button>
      </div>
    </main>
  );
}
