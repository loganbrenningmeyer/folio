# Folio for macOS

Folio's desktop build is a native macOS application. Its packaged app loads the
reader directly from the application bundle; it does not run a localhost server,
open a browser, or require ChatGPT/Sites authentication.

## Install or update Folio

From this project folder, run:

```sh
npm install
npm run desktop:install
```

The command builds the current source and installs `Folio.app` into your personal
`~/Applications` folder. Future source changes need only:

```sh
npm run desktop:update
```

To install somewhere else, set `FOLIO_INSTALL_DIR` for that command:

```sh
FOLIO_INSTALL_DIR=/Applications npm run desktop:install
```

macOS may ask for administrator approval when writing to `/Applications`.

## Build a DMG

```sh
npm run desktop:dmg
```

The installer is written under `src-tauri/target/release/bundle/dmg/`.

## Development

```sh
npm run desktop:dev
```

Development mode uses a temporary Vite development address for hot reload. The
installed production app never uses localhost.

## Folder access and saving

The first folder selection uses the native macOS folder picker. Folio remembers
that folder and reopens it directly on later launches, so Folio does not show its
folder picker again unless you choose **Change folder** or the saved folder is no
longer available. Edits, newly created files, new folders, and drag-and-drop moves
are written to disk automatically.

Folio's window stays hidden for the moment it takes to read your appearance
settings and your library, so the first thing on screen is your own theme and
your own pages rather than the starting state repainting into them.

Folio also remembers the page you were reading and reopens it on the next launch.
If that page has since been renamed, moved, or deleted outside Folio, the library
opens at its first page instead. Choosing a different folder starts fresh.

Dragging pages into the order you want to read them writes only `.folio/order.json`
inside the library — Folio never renames a file to record its position. Deleting
that file returns the library to alphabetical order.

macOS itself can still show a one-time privacy request for protected locations
such as Documents, Desktop, removable drives, or network volumes. That operating
system request cannot be bypassed safely. macOS normally remembers the choice for
the installed build.

## Sync between devices

Folio can sync a library through a Git repository you own. Open
**Preferences → Sync**, paste the remote URL (an empty private repository
works — Folio pushes the library into it), and for an https remote a
personal access token with repository write access; ssh remotes use your
ssh-agent. On another machine, open an empty folder as the library and
connect it to the same remote: the pages come down.

Saving stays local and constant. Committing is a chosen moment: press
⌘⇧S (Ctrl+Shift+S on Windows) to commit and sync, answer the prompt that
appears if you quit with uncommitted changes, and Folio sweeps up anything
a force-quit left behind the next time it opens — then pulls what your
other devices pushed. Changes landing from a sync appear on their own.

Merges always resolve to one file. Page edits merge line by line; when both
devices changed the very same line, the merged page keeps both versions in
sequence for you to tidy — nothing is lost and no conflicted copies appear.
Folio's own page order and folder icons merge folder by folder. History
lives in a `.git` folder inside the library; the access token lives in
Folio's settings on each device, never in the repository.

## Sharing the app with other Macs

This local build is suitable for this Mac and is ad-hoc signed. A rebuilt ad-hoc
version can be treated as a new code identity by macOS, so a protected folder may
occasionally require privacy approval again after an update. Consistent permissions
across signed updates—and distribution to other Macs without a Gatekeeper warning—
require the same Apple Developer ID certificate and notarization. Folio keeps a
stable bundle identifier so a signed release can retain that identity.
