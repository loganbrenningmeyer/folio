# Folio

A Markdown reader and editor for macOS and Windows. You point it at a folder of `.md` files
and it gives you a nicer way to read and write them than a plain text editor —
rendered pages, a sidebar for your folders, an outline, wiki-style links between
pages, and Python code blocks you can actually run.

It's a personal project, not a product. There's no account, no sync, no server.
Your files stay where they are on disk, and Folio just reads and writes them.

## Install

Both downloads are on the [Releases](../../releases) page.

### macOS

Grab the `.dmg`, open it, and drag Folio to your Applications folder.

**macOS will block it on first launch** — it says Apple "could not verify" the app.
That's because the build isn't signed with a paid Apple Developer certificate, not
because anything is wrong with it. To get past it, run this once:

```sh
xattr -dr com.apple.quarantine /Applications/Folio.app
```

Or, without the terminal: try to open it, click **Done**, then go to
**System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.

### Windows

Grab the `-setup.exe` and run it. It installs for the current user, so it doesn't
ask for an administrator.

**SmartScreen will warn you on first run**, for the same reason macOS does: the
installer isn't signed with a paid certificate. Click **More info → Run anyway**.

Folio needs the Microsoft Edge WebView2 runtime. Windows 11 already has it, and
the installer fetches it if yours doesn't.

If you'd rather not click past either warning, build it yourself from source (see
the bottom).

## Getting started

On first launch Folio asks you to pick a folder. Choose any folder containing
Markdown files — an existing notes directory, a project's docs, or a new empty
folder if you're starting fresh. Folio remembers it and reopens it next time.

Subfolders become sections in the sidebar. Nothing gets copied or imported; it's
reading the folder directly. To switch libraries later, use **Change folder**
(or ⌘O).

Edits save to disk automatically. There's no separate save step, though ⌘S forces
one if you want it.

## Reading and writing

Three view modes, in the top bar or via shortcut:

| View | What it does |
| --- | --- |
| **Read** (⌘E toggles) | Rendered page, no editor |
| **Write** (⌘E toggles) | Raw Markdown in a CodeMirror editor |
| **Split** (⌘⇧E) | Both, side by side, with the panes scroll-locked to each other |

The rendered view supports GitHub-flavored Markdown — tables, task lists,
strikethrough — plus syntax-highlighted code blocks and LaTeX math via KaTeX
(`$inline$` and `$$display$$`).

At the bottom of each page there are Previous/Next buttons that walk through your
library in order, and a thin progress bar at the top tracks how far into the page
you are.

## Linking pages

Write `[[Page title]]` to link to another page. Click it to jump there. Ordinary
Markdown links to `.md` files work the same way, including relative ones like
`[Topology](../math/Topology.md)`.

A link can point outside the folder you have open. When you follow one, Folio
reopens your library at the nearest folder holding both pages — click a link to
`notes/math/Topology.md` while reading `notes/rust/Ownership.md` and the library
becomes `notes`, with both sections in the sidebar. If the two pages share no
sensible parent, Folio opens the linked page's own folder instead.

The outline panel on the right lists the current page's headings, and below that,
**backlinks** — every other page that links to this one. It's the main way to find
your way back into things you wrote earlier.

## Images

In Write view you can get images into a page without touching Markdown syntax:

- **Paste** an image from the clipboard
- **Drag and drop** image files from Finder
- Click the **image button** in the editor's top bar to pick files

Folio copies the file into the same folder as the page and inserts the Markdown
for you. The editor then shows the image itself instead of the code:

- **Drag the corner handle** to resize (double-click it to reset to natural size)
- Hover the image for **left / center / right** alignment buttons
- Click the **caption button** to type a caption under the image; press Enter to
  keep it, or clear it to remove it
- Click the **`</>` button** to reveal the underlying Markdown line and edit it
  by hand; click again to hide it
- **Click an image** to select it — you get a light outline showing the space it
  occupies, and Backspace removes the image and its Markdown together

Everything stays plain Markdown under the hood. The caption, size, and alignment
live in the image title — `![alt](plot.png "My caption | width=420 center")` — so
the file still renders as a normal image in any other Markdown tool. The `|`
keeps a caption safe even when it contains a word like "center".

## Finding things

⌘K opens search. It looks at page titles, section names, and the full text of every
page, and shows matching lines inline so you can tell which result you want before
opening it.

## Organizing

The library panel handles files:

- **New file** (⌘N) and **new folder** (⌘⇧N)
- **Drag a page** anywhere in the panel: a line shows where it will land, whether
  that is a new position in its own folder or a place inside another one. Moving
  it to another folder moves the actual file on disk; press Escape, or let go
  outside the panel, to leave it where it was
- A page's own order is remembered in `.folio/order.json` beside the library, so
  nothing is renamed and links between pages keep working. Pages that file does
  not mention — anything added outside Folio — stay in alphabetical order
- A dot next to a page name means unsaved changes

## Running Python

Python blocks are ordinary code blocks by default. Open the fence with
` ```python run ` instead of ` ```python ` and the block gets a **Run** button in
Read view — or just hover a plain Python block and click **Enable running**, and
Folio adds the `run` flag to the fence for you (the ⚡ button on a runnable block
removes it again). Code runs locally in your browser engine via
[Pyodide](https://pyodide.org) (Python compiled to WebAssembly) — nothing is sent
anywhere. The first run downloads the runtime, so it takes a moment; after that
it's quick.

Printed output appears under the block, and the last expression's value shows up
like a notebook cell would.

**Packages.** NumPy, Matplotlib, and other scientific packages download
automatically the first time a block imports them. Plots render inline.

**Controls.** Import from `folio` to get knobs that re-run the block when you
change them:

```python
from folio import slider, toggle, select

freq = slider("frequency", 1, 12, value=3)
grid = toggle("grid", value=True)
mode = select("mode", ["sin", "cos"])
```

Matplotlib's own widgets (`Slider`, `Button`, `CheckButtons`, `RadioButtons`,
`TextBox`) also work, and drive their Python callbacks against the live figure
without re-running the block. `FuncAnimation` animates in place.

**Sessions.** All blocks on a page share one Python session, so definitions from
earlier blocks are available in later ones. Each block header has a restart button
(clears the session) and a stop button (kills a runaway loop).

The bundled **Interactive Python** sample page has working examples of all of this.

## Preferences

Open with the gear icon in the top bar. Three tabs:

**Appearance** — twelve color schemes (Sage, Moss, Tide, Slate, Indigo, Plum,
Rose, Clay, Sepia, Amber, Graphite, Contrast), each with a light and dark
variant that follows the mode toggle in the top bar, and separate font choices
for the reader and the editor (serif, sans, and monospace options).

**Shortcuts** — rebind any of the commands below. Click a field, press the keys you
want; Backspace clears a binding.

**Text snippets** — shortcuts that insert Markdown while you're writing. Three come
built in: equation block (⌃⇧E), code block (⌃⇧\\), Python block (⌃⇧P), on Alt+Shift
instead on Windows. You can add your own, with `$1`, `$2` as tab stops and `$0`
for where the cursor lands.

All preferences are stored locally on your machine.

## Default shortcuts

| macOS | Windows | |
| --- | --- | --- |
| ⌘K | Ctrl+K | Find a page |
| ⌘S | Ctrl+S | Save now |
| ⌘← / ⌘→ | Ctrl+Left / Ctrl+Right | Previous / next page |
| ⌘N | Ctrl+N | New file |
| ⌘⇧N | Ctrl+Shift+N | New folder |
| ⌘O | Ctrl+O | Open folder |
| ⌘E | Ctrl+E | Toggle Read / Write |
| ⌘⇧E | Ctrl+Shift+E | Toggle Split view |

Toggling the library and outline panels is unbound by default — assign keys in
Preferences if you want them.

Shortcuts elsewhere in this README are written the macOS way. On Windows, read ⌘
as Ctrl, and the ⌃⇧ snippet shortcuts as Alt+Shift — Ctrl+Shift is taken there by
the app commands above.

## Building from source

Requires Node 22+ and a Rust toolchain. Each platform builds on itself: Tauri
links against the system webview, so a Windows build needs a Windows machine.

```sh
npm install
npm run desktop:dev      # dev mode with hot reload

# macOS
npm run desktop:install  # build and install to ~/Applications
npm run desktop:dmg      # build a .dmg

# Windows
npm run desktop:exe      # build a setup .exe
```

See [DESKTOP.md](DESKTOP.md) for more detail.
