"use client";

import React, {
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
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
  Download,
  FileCode2,
  FilePlus2,
  FileText,
  FolderPlus,
  FolderOpen,
  GripVertical,
  Link2,
  ListTree,
  Menu,
  Moon,
  PanelRight,
  Save,
  Search,
  Sun,
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
type LibraryScan = { notes: Note[]; folders: string[] };

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-./, "math-inline", "math-display"],
    ],
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
- Move between pages with the arrows or your keyboard.
- Switch between **Read**, **Write**, and **Split** views.
- Press \`⌘ K\` to find any page and \`⌘ S\` to save your work.

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
];

const SAMPLE_FOLDERS = ["01 Foundations", "02 Research", "03 Synthesis"];

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

function normalizeMathDelimiters(content: string) {
  return content
    .split(/(\x60{3}[\s\S]*?\x60{3}|~~~[\s\S]*?~~~)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression) => {
          return "$$\n" + expression.trim() + "\n$$";
        })
        .replace(/\\\((.*?)\\\)/g, (_, expression) => "$" + expression + "$");
    })
    .join("");
}

const INLINE_MARKDOWN_PATTERN =
  /(\x60[^\x60\n]+\x60|\\\((?:\\.|[^\\\n])*?\\\)|\\\[(?:\\.|[^\\\n])*?\\\]|\$\$[^$\n]+?\$\$|\$[^$\n]+?\$|!\[[^\]\n]*\]\([^)]+\)|\[[^\]\n]+\]\([^)]+\)|\[\[[^\]\n]+\]\]|~~[^~\n]+~~|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*)|(?<!_)_[^_\n]+_(?!_)|https?:\/\/[^\s<]+|<\/?[A-Za-z][^>\n]*>)/g;

const CODE_TOKEN_PATTERN =
  /(\/\/.*$|\/\*.*?\*\/|#(?!\[).*?$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60|\b(?:as|async|await|break|case|catch|class|const|continue|crate|def|default|else|enum|export|extends|false|fn|for|from|function|if|impl|import|in|interface|let|loop|match|mod|move|mut|new|null|of|pub|ref|return|self|Self|Some|static|struct|super|switch|throw|trait|true|try|type|use|var|where|while|yield|None|Ok|Err)\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b[A-Z][A-Za-z0-9_]*\b|\b[a-zA-Z_][A-Za-z0-9_]*(?=\s*\())/g;

function inlineTokenClass(token: string) {
  if (
    token.startsWith("$") ||
    token.startsWith("\\(") ||
    token.startsWith("\\[")
  ) {
    return "syntax-math";
  }
  if (token.startsWith("\x60")) return "syntax-inline-code";
  if (
    token.startsWith("[") ||
    token.startsWith("![") ||
    token.startsWith("http")
  ) {
    return "syntax-link";
  }
  if (token.startsWith("<")) return "syntax-html";
  return "syntax-emphasis";
}

function renderPatternTokens(
  value: string,
  pattern: RegExp,
  classForToken: (token: string) => string,
  keyPrefix: string,
) {
  const output: ReactNode[] = [];
  let cursor = 0;
  pattern.lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) output.push(value.slice(cursor, index));
    output.push(
      <span className={classForToken(match[0])} key={keyPrefix + "-" + index}>
        {match[0]}
      </span>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < value.length) output.push(value.slice(cursor));
  return output;
}

function renderInlineMarkdown(value: string, keyPrefix: string) {
  return renderPatternTokens(
    value,
    INLINE_MARKDOWN_PATTERN,
    inlineTokenClass,
    keyPrefix,
  );
}

function codeTokenClass(token: string) {
  if (/^(?:\/\/|\/\*|#)/.test(token)) return "syntax-code-comment";
  if (/^["'\x60]/.test(token)) return "syntax-code-string";
  if (/^\d/.test(token)) return "syntax-code-number";
  if (/^(?:as|async|await|break|case|catch|class|const|continue|crate|def|default|else|enum|export|extends|false|fn|for|from|function|if|impl|import|in|interface|let|loop|match|mod|move|mut|new|null|of|pub|ref|return|self|Self|Some|static|struct|super|switch|throw|trait|true|try|type|use|var|where|while|yield|None|Ok|Err)$/.test(token)) {
    return "syntax-code-keyword";
  }
  if (/^[A-Z]/.test(token)) return "syntax-code-type";
  return "syntax-code-function";
}

function renderCodeLine(value: string, keyPrefix: string) {
  return renderPatternTokens(value, CODE_TOKEN_PATTERN, codeTokenClass, keyPrefix);
}

function renderEditorSyntax(source: string) {
  let fenceCharacter: string | undefined;
  let inFrontmatter = false;
  let mathCloser: "$$" | "\\]" | undefined;

  return source.split("\n").map((line, index) => {
    const trimmed = line.trim();
    const key = "editor-line-" + index;

    if (index === 0 && trimmed === "---") {
      inFrontmatter = true;
      return (
        <span className="syntax-line syntax-frontmatter syntax-frontmatter-line" key={key}>
          {line}
        </span>
      );
    }

    if (inFrontmatter) {
      if (trimmed === "---" || trimmed === "...") {
        inFrontmatter = false;
        return (
          <span className="syntax-line syntax-frontmatter syntax-frontmatter-line" key={key}>
            {line}
          </span>
        );
      }
      const yaml = line.match(/^(\s*)([A-Za-z0-9_.-]+)(\s*:)(.*)$/);
      return (
        <span className="syntax-line syntax-frontmatter-line" key={key}>
          {yaml ? (
            <>
              {yaml[1]}
              <span className="syntax-frontmatter-key">{yaml[2]}</span>
              <span className="syntax-punctuation">{yaml[3]}</span>
              <span className="syntax-frontmatter-value">{yaml[4]}</span>
            </>
          ) : (
            <span className="syntax-frontmatter-value">{line}</span>
          )}
        </span>
      );
    }

    if (fenceCharacter) {
      const closesFence =
        fenceCharacter === "\x60"
          ? /^\s*\x60{3,}\s*$/.test(line)
          : /^\s*~{3,}\s*$/.test(line);
      if (closesFence) {
        fenceCharacter = undefined;
        return (
          <span className="syntax-line syntax-code-fence" key={key}>
            {line}
          </span>
        );
      }
      return (
        <span className="syntax-line syntax-code-line" key={key}>
          {renderCodeLine(line, key)}
        </span>
      );
    }

    const fence = line.match(/^(\s*)((?:\x60{3,})|(?:~{3,}))(\s*)(.*)$/);
    if (fence) {
      fenceCharacter = fence[2][0];
      return (
        <span className="syntax-line syntax-code-fence" key={key}>
          {fence[1]}
          <span className="syntax-punctuation">{fence[2]}</span>
          {fence[3]}
          <span className="syntax-code-language">{fence[4]}</span>
        </span>
      );
    }

    if (mathCloser) {
      const closesMath = line.includes(mathCloser);
      if (closesMath) mathCloser = undefined;
      return (
        <span className="syntax-line syntax-math-block" key={key}>
          {line}
        </span>
      );
    }

    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const opener = trimmed.startsWith("$$") ? "$$" : "\\[";
      const closer = opener === "$$" ? "$$" : "\\]";
      if (trimmed.slice(opener.length).includes(closer)) {
        mathCloser = undefined;
      } else {
        mathCloser = closer;
      }
      return (
        <span className="syntax-line syntax-math-block" key={key}>
          {line}
        </span>
      );
    }

    const heading = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/);
    if (heading) {
      return (
        <span className="syntax-line syntax-heading" key={key}>
          {heading[1]}
          <span className="syntax-punctuation">{heading[2]}</span>
          {heading[3]}
          {renderInlineMarkdown(heading[4], key)}
        </span>
      );
    }

    const quote = line.match(/^(\s*)(>+)(\s?)(.*)$/);
    if (quote) {
      return (
        <span className="syntax-line syntax-quote-line" key={key}>
          {quote[1]}
          <span className="syntax-quote-marker">{quote[2]}</span>
          {quote[3]}
          <span className="syntax-quote-text">
            {renderInlineMarkdown(quote[4], key)}
          </span>
        </span>
      );
    }

    const list = line.match(/^(\s*)([-+*]|\d+[.)])(\s+)(.*)$/);
    if (list) {
      return (
        <span className="syntax-line" key={key}>
          {list[1]}
          <span className="syntax-list-marker">{list[2]}</span>
          {list[3]}
          {renderInlineMarkdown(list[4], key)}
        </span>
      );
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      return (
        <span className="syntax-line syntax-divider" key={key}>
          {line}
        </span>
      );
    }

    return (
      <span className="syntax-line" key={key}>
        {renderInlineMarkdown(line, key)}
      </span>
    );
  });
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

export default function Home() {
  const [notes, setNotes] = useState<Note[]>(SAMPLE_NOTES);
  const [folders, setFolders] = useState<string[]>(SAMPLE_FOLDERS);
  const [rootDirectory, setRootDirectory] = useState<DirectoryHandleLike>();
  const [activeId, setActiveId] = useState(SAMPLE_NOTES[0].id);
  const [libraryName, setLibraryName] = useState("The Folio Field Guide");
  const [view, setView] = useState<ViewMode>("preview");
  const [theme, setTheme] = useState<Theme>("light");
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
  const editorHighlight = useRef<HTMLPreElement>(null);
  const editorLineNumbers = useRef<HTMLDivElement>(null);

  const activeIndex = Math.max(
    0,
    notes.findIndex((note) => note.id === activeId),
  );
  const active = notes[activeIndex] ?? EMPTY_NOTE;
  const editorSyntax = useMemo(
    () => renderEditorSyntax(active.content),
    [active.content],
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
    const query = searchQuery.trim().toLowerCase();
    if (!query) return notes;
    return notes
      .map((note) => ({
        note,
        score:
          (note.title.toLowerCase().includes(query) ? 3 : 0) +
          (note.path.toLowerCase().includes(query) ? 2 : 0) +
          (note.content.toLowerCase().includes(query) ? 1 : 0),
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((result) => result.note);
  }, [notes, searchQuery]);

  useEffect(() => {
    const stored = localStorage.getItem("folio-theme") as Theme | null;
    const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    setTheme(stored ?? preferred);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("folio-theme", theme);
  }, [theme]);

  const selectNote = useCallback((id: string) => {
    setActiveId(id);
    setNavOpen(false);
    setOutlineOpen(false);
    requestAnimationFrame(() =>
      document.querySelector(".reading-scroll")?.scrollTo({ top: 0 }),
    );
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => {
      setNotice((current) => (current === message ? undefined : current));
    }, 3600);
  }, []);

  const updateContent = (content: string) => {
    if (active.id === EMPTY_NOTE.id) return;
    setNotes((current) =>
      current.map((note) => (note.id === active.id ? { ...note, content } : note)),
    );
    setDirty((current) => new Set(current).add(active.id));
    setSaved(false);
  };

  const syncEditorScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
    if (editorHighlight.current) {
      editorHighlight.current.scrollTop = event.currentTarget.scrollTop;
      editorHighlight.current.scrollLeft = event.currentTarget.scrollLeft;
    }
    if (editorLineNumbers.current) {
      editorLineNumbers.current.scrollTop = event.currentTarget.scrollTop;
    }
  };

  const beginCreate = (kind: CreateKind) => {
    setCreateKind(kind);
    setNewEntryName("");
    setNewEntryParent(
      active.id === EMPTY_NOTE.id ? "" : parentPath(active.path),
    );
  };

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
        if (rootDirectory) {
          if (!(await hasWritePermission(rootDirectory))) {
            showNotice("Write access is needed to create a folder.");
            return;
          }
          const parent = await getDirectoryAtPath(rootDirectory, newEntryParent);
          await parent.getDirectoryHandle(rawName, { create: true });
        }
        setFolders((current) =>
          [...current, folderPath].sort((a, b) =>
            a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
          ),
        );
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
      if (rootDirectory) {
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
      setView("editor");
      setCreateKind(undefined);
      showNotice(`Created ${fileName}.`);
    } catch {
      showNotice("Folio could not create that file.");
    }
  };

  const moveNote = async (noteId: string, targetFolder: string) => {
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
    setDraggedNoteId(noteId);
    event.dataTransfer.effectAllowed = "move";
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
  }, [active, downloadNote]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isTyping = ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveActive();
      }
      if (event.key === "Escape") {
        setSearchOpen(false);
        setNavOpen(false);
        setOutlineOpen(false);
        setCreateKind(undefined);
      }
      if (!isTyping && event.key === "ArrowRight" && activeIndex < notes.length - 1) {
        selectNote(notes[activeIndex + 1].id);
      }
      if (!isTyping && event.key === "ArrowLeft" && activeIndex > 0) {
        selectNote(notes[activeIndex - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeIndex, notes, saveActive, selectNote]);

  const openFolder = async () => {
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
  };

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

  const findLinkedNote = (href: string) => {
    if (href.startsWith("wiki:")) {
      const target = decodeURIComponent(href.slice(5)).toLowerCase();
      return notes.find(
        (note) =>
          note.title.toLowerCase() === target ||
          note.path.split("/").pop()?.replace(/\.md$/i, "").toLowerCase() === target,
      );
    }
    const withoutHash = decodeURIComponent(href.split("#")[0]);
    const base = active.path.includes("/")
      ? active.path.slice(0, active.path.lastIndexOf("/") + 1)
      : "";
    const resolved = normalizePath(
      withoutHash.startsWith("/") ? withoutHash.slice(1) : `${base}${withoutHash}`,
    ).toLowerCase();
    return notes.find(
      (note) =>
        normalizePath(note.path).toLowerCase() === resolved ||
        note.path.split("/").pop()?.toLowerCase() === withoutHash.split("/").pop()?.toLowerCase(),
    );
  };

  const handleMarkdownLink = (event: MouseEvent<HTMLAnchorElement>, href?: string) => {
    if (!href || href.startsWith("#")) return;
    const linked = findLinkedNote(href);
    if (!linked) return;
    event.preventDefault();
    selectNote(linked.id);
    const hash = href.split("#")[1];
    if (hash) {
      window.setTimeout(() => document.getElementById(hash)?.scrollIntoView(), 50);
    }
  };

  const markdown = (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        [remarkMath, { singleDollarTextMath: true }],
      ]}
      rehypePlugins={[
        [rehypeSanitize, markdownSanitizeSchema],
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
      components={{
        h1: ({ children }) => <h1 id={slugify(nodeText(children))}>{children}</h1>,
        h2: ({ children }) => <h2 id={slugify(nodeText(children))}>{children}</h2>,
        h3: ({ children }) => <h3 id={slugify(nodeText(children))}>{children}</h3>,
        h4: ({ children }) => <h4 id={slugify(nodeText(children))}>{children}</h4>,
        code: ({ className, children, node: _node, ...props }) => {
          const language = className?.match(/language-([\w-]+)/)?.[1];
          return (
            <code
              className={className}
              data-language={language}
              {...props}
            >
              {children}
            </code>
          );
        },
        a: ({ href, children }) => (
          <a href={href} onClick={(event) => handleMarkdownLink(event, href)}>
            {href?.startsWith("wiki:") && <Link2 size={13} aria-hidden="true" />}
            {children}
          </a>
        ),
      }}
    >
      {withWikiLinks(normalizeMathDelimiters(active?.content ?? ""))}
    </ReactMarkdown>
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-zone">
          <button
            className="icon-button mobile-only"
            onClick={() => setNavOpen(true)}
            aria-label="Open library"
          >
            <Menu size={19} />
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
            <kbd>⌘ K</kbd>
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
            onClick={() => setOutlineOpen(true)}
            aria-label="Open page outline"
          >
            <PanelRight size={18} />
          </button>
          <button className="open-button" onClick={openFolder}>
            <FolderOpen size={16} />
            <span>Open folder</span>
          </button>
          <input
            ref={folderInput}
            className="visually-hidden"
            type="file"
            multiple
            accept=".md,text/markdown"
            onChange={importFolder}
            {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
          />
        </div>
      </header>

      <div className="workspace">
        {navOpen && <button className="scrim" onClick={() => setNavOpen(false)} aria-label="Close library" />}
        <aside className={`library-panel ${navOpen ? "is-open" : ""}`}>
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
                    dropTarget === group ? "drop-target" : ""
                  }`}
                  key={group || "__root__"}
                  onDragOver={(event) => {
                    if (!draggedNoteId) return;
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
                      draggedNoteId || event.dataTransfer.getData("text/plain");
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
                    <ChevronDown size={14} className={collapsed ? "rotated" : ""} />
                  </button>
                  {!collapsed && (
                    <div className="page-list">
                      {groupNotes.map((note) => (
                        <button
                          key={note.id}
                          className={`page-row ${note.id === active.id ? "active" : ""} ${
                            draggedNoteId === note.id ? "dragging" : ""
                          }`}
                          onClick={() => selectNote(note.id)}
                          draggable
                          onDragStart={(event) => startNoteDrag(event, note.id)}
                          onDragEnd={() => {
                            setDraggedNoteId(undefined);
                            setDropTarget(undefined);
                          }}
                          title="Open this page, or drag it into another folder"
                        >
                          <span className="page-spine" />
                          <FileText size={15} />
                          <span>{note.title}</span>
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
            <div className="breadcrumb">
              <span>{cleanGroup(active.path.split("/")[0] || "Notes")}</span>
              <ChevronRight size={13} />
              <strong>{active.title}</strong>
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
              <button
                className={`save-button ${saved ? "saved" : ""}`}
                onClick={() => void saveActive()}
                disabled={!dirty.has(active.id) && !saved}
                title={active.handle ? "Save to Markdown file" : "Download Markdown file"}
              >
                {saved ? <Check size={15} /> : active.handle ? <Save size={15} /> : <Download size={15} />}
                <span>{saved ? "Saved" : active.handle ? "Save" : "Export"}</span>
              </button>
            </div>
          </div>

          <div className={`reading-scroll mode-${view}`}>
            {(view === "preview" || view === "split") && (
              <article className="markdown-page">
                <div className="page-kicker">
                  <span>{String(activeIndex + 1).padStart(2, "0")}</span>
                  <span>—</span>
                  <span>{cleanGroup(active.path.split("/")[0] || "Notes")}</span>
                </div>
                <div className="markdown-body">{markdown}</div>

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
                  <span className="editor-language">Markdown</span>
                </div>
                <div className="editor-workspace">
                  <div
                    className="line-numbers"
                    ref={editorLineNumbers}
                    aria-hidden="true"
                  >
                    {active.content.split("\n").map((_, index) => (
                      <span key={index}>{index + 1}</span>
                    ))}
                  </div>
                  <div className="editor-source">
                    <pre
                      className="editor-highlight"
                      ref={editorHighlight}
                      aria-hidden="true"
                    >
                      {editorSyntax}
                    </pre>
                    <textarea
                      value={active.content}
                      onChange={(event) => updateContent(event.target.value)}
                      onScroll={syncEditorScroll}
                      spellCheck="true"
                      aria-label={`Edit ${active.title}`}
                    />
                  </div>
                </div>
                <div className="editor-status">
                  <span>Markdown</span>
                  <span>{active.content.split(/\s+/).filter(Boolean).length} words</span>
                  <span>{active.content.length} characters</span>
                </div>
              </div>
            )}
          </div>
        </section>

        {outlineOpen && <button className="scrim" onClick={() => setOutlineOpen(false)} aria-label="Close outline" />}
        <aside className={`outline-panel ${outlineOpen ? "is-open" : ""}`}>
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
            <span><kbd>←</kbd><kbd>→</kbd> turn pages</span>
            <span><kbd>⌘</kbd><kbd>S</kbd> save</span>
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
                autoFocus
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
              {rootDirectory
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
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search titles, sections, and contents…"
              />
              <kbd>esc</kbd>
            </div>
            <div className="command-results">
              <span className="result-label">{searchQuery ? "Best matches" : "All pages"}</span>
              {searchResults.slice(0, 8).map((note) => (
                <button
                  key={note.id}
                  onClick={() => {
                    selectNote(note.id);
                    setSearchOpen(false);
                    setSearchQuery("");
                  }}
                >
                  <span className="result-icon"><FileText size={16} /></span>
                  <span>
                    <strong>{note.title}</strong>
                    <small>{note.path}</small>
                  </span>
                  <ArrowRight size={15} />
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
