"use client";

import React, {
  type ChangeEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
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
  FileText,
  FolderOpen,
  Link2,
  ListTree,
  Menu,
  Moon,
  MoreHorizontal,
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
};

type DirectoryHandleLike = {
  kind: "directory";
  name: string;
  values: () => AsyncIterableIterator<FileHandleLike | DirectoryHandleLike>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: "read" | "readwrite";
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

function normalizePath(path: string) {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
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
): Promise<Note[]> {
  const notes: Note[] = [];
  for await (const entry of directory.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      notes.push(...(await readDirectory(entry, path)));
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
  return notes.sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export default function Home() {
  const [notes, setNotes] = useState<Note[]>(SAMPLE_NOTES);
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
  const folderInput = useRef<HTMLInputElement>(null);

  const activeIndex = Math.max(
    0,
    notes.findIndex((note) => note.id === activeId),
  );
  const active = notes[activeIndex] ?? notes[0];

  const grouped = useMemo(() => {
    const groups = new Map<string, Note[]>();
    notes.forEach((note) => {
      const segments = note.path.split("/");
      const group = segments.length > 1 ? segments.slice(0, -1).join(" / ") : "Notes";
      groups.set(group, [...(groups.get(group) ?? []), note]);
    });
    return Array.from(groups.entries());
  }, [notes]);

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

  const updateContent = (content: string) => {
    if (!active) return;
    setNotes((current) =>
      current.map((note) => (note.id === active.id ? { ...note, content } : note)),
    );
    setDirty((current) => new Set(current).add(active.id));
    setSaved(false);
  };

  const saveActive = useCallback(async () => {
    if (!active) return;
    if (active.handle?.createWritable) {
      const writable = await active.handle.createWritable();
      await writable.write(active.content);
      await writable.close();
    } else {
      const blob = new Blob([active.content], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${active.title}.md`;
      link.click();
      URL.revokeObjectURL(url);
    }
    setDirty((current) => {
      const next = new Set(current);
      next.delete(active.id);
      return next;
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }, [active]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isTyping = ["INPUT", "TEXTAREA"].includes(target.tagName);
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
      const directory = await window.showDirectoryPicker({ mode: "readwrite" });
      const loaded = await readDirectory(directory);
      if (!loaded.length) {
        window.alert("This folder does not contain any Markdown files.");
        return;
      }
      setNotes(loaded);
      setActiveId(loaded[0].id);
      setLibraryName(directory.name);
      setDirty(new Set());
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
    setNotes(loaded);
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
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      urlTransform={(url) => url}
      components={{
        h1: ({ children }) => <h1 id={slugify(nodeText(children))}>{children}</h1>,
        h2: ({ children }) => <h2 id={slugify(nodeText(children))}>{children}</h2>,
        h3: ({ children }) => <h3 id={slugify(nodeText(children))}>{children}</h3>,
        a: ({ href, children }) => (
          <a href={href} onClick={(event) => handleMarkdownLink(event, href)}>
            {href?.startsWith("wiki:") && <Link2 size={13} aria-hidden="true" />}
            {children}
          </a>
        ),
      }}
    >
      {withWikiLinks(active?.content ?? "")}
    </ReactMarkdown>
  );

  if (!active) return null;

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
            <button className="subtle-icon" aria-label="Library options">
              <MoreHorizontal size={17} />
            </button>
          </div>

          <nav className="section-list" aria-label="Library pages">
            {grouped.map(([group, groupNotes], groupIndex) => {
              const collapsed = collapsedGroups.has(group);
              return (
                <section className="section-group" key={group}>
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
                    <strong>{cleanGroup(group)}</strong>
                    <ChevronDown size={14} className={collapsed ? "rotated" : ""} />
                  </button>
                  {!collapsed && (
                    <div className="page-list">
                      {groupNotes.map((note) => (
                        <button
                          key={note.id}
                          className={`page-row ${note.id === active.id ? "active" : ""}`}
                          onClick={() => selectNote(note.id)}
                        >
                          <span className="page-spine" />
                          <FileText size={15} />
                          <span>{note.title}</span>
                          {dirty.has(note.id) && <i aria-label="Unsaved changes" />}
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
                  <div className="line-numbers" aria-hidden="true">
                    {active.content.split("\n").map((_, index) => (
                      <span key={index}>{index + 1}</span>
                    ))}
                  </div>
                  <textarea
                    value={active.content}
                    onChange={(event) => updateContent(event.target.value)}
                    spellCheck="true"
                    aria-label={`Edit ${active.title}`}
                  />
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

      <div className="mobile-page-nav">
        <button
          onClick={() => activeIndex > 0 && selectNote(notes[activeIndex - 1].id)}
          disabled={activeIndex === 0}
          aria-label="Previous page"
        >
          <ArrowLeft size={17} />
        </button>
        <span>{activeIndex + 1} / {notes.length}</span>
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
