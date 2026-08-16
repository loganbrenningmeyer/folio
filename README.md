# Folio

A Markdown reader and editor for macOS. You point it at a folder of `.md` files
and it gives you a nicer way to read and write them than a plain text editor —
rendered pages, a sidebar for your folders, an outline, wiki-style links between
pages, and Python code blocks you can actually run.

It's a personal project, not a product. There's no account, no sync, no server.
Your files stay where they are on disk, and Folio just reads and writes them.

## Install

Grab the `.dmg` from the [Releases](../../releases) page, open it, and drag Folio
to your Applications folder.

**macOS will block it on first launch** — it says Apple "could not verify" the app.
That's because the build isn't signed with a paid Apple Developer certificate, not
because anything is wrong with it. To get past it, run this once:

```sh
xattr -dr com.apple.quarantine /Applications/Folio.app
```

Or, without the terminal: try to open it, click **Done**, then go to
**System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.

If you'd rather not do either, build it yourself from source (see the bottom).

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

Write `[[Page title]]` to link to another page. Click it to jump there.

The outline panel on the right lists the current page's headings, and below that,
**backlinks** — every other page that links to this one. It's the main way to find
your way back into things you wrote earlier.

## Finding things

⌘K opens search. It looks at page titles, section names, and the full text of every
page, and shows matching lines inline so you can tell which result you want before
opening it.

## Organizing

The library panel handles files:

- **New file** (⌘N) and **new folder** (⌘⇧N)
- **Drag a page onto a folder** to move it — this moves the actual file on disk
- A dot next to a page name means unsaved changes

## Running Python

Any ` ```python ` code block gets a **Run** button in Read view. Code runs locally
in your browser engine via [Pyodide](https://pyodide.org) (Python compiled to
WebAssembly) — nothing is sent anywhere. The first run downloads the runtime, so
it takes a moment; after that it's quick.

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

**Appearance** — five color schemes (Sage, Slate, Graphite, Sepia, Plum), and
separate font choices for the reader and the editor (serif, sans, and monospace
options).

**Shortcuts** — rebind any of the commands below. Click a field, press the keys you
want; Backspace clears a binding.

**Text snippets** — shortcuts that insert Markdown while you're writing. Three come
built in: equation block (⌃⇧E), code block (⌃⇧\\), Python block (⌃⇧P). You can add
your own, with `$1`, `$2` as tab stops and `$0` for where the cursor lands.

All preferences are stored locally on your machine.

## Default shortcuts

| | |
| --- | --- |
| ⌘K | Find a page |
| ⌘S | Save now |
| ⌘← / ⌘→ | Previous / next page |
| ⌘N | New file |
| ⌘⇧N | New folder |
| ⌘O | Open folder |
| ⌘E | Toggle Read / Write |
| ⌘⇧E | Toggle Split view |

Toggling the library and outline panels is unbound by default — assign keys in
Preferences if you want them.

## Building from source

Requires Node 22+ and a Rust toolchain.

```sh
npm install
npm run desktop:dev      # dev mode with hot reload
npm run desktop:install  # build and install to ~/Applications
npm run desktop:dmg      # build a .dmg
```

See [DESKTOP.md](DESKTOP.md) for more detail.
