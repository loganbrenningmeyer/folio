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

macOS itself can still show a one-time privacy request for protected locations
such as Documents, Desktop, removable drives, or network volumes. That operating
system request cannot be bypassed safely. macOS normally remembers the choice for
the installed build.

## Sharing the app with other Macs

This local build is suitable for this Mac and is ad-hoc signed. A rebuilt ad-hoc
version can be treated as a new code identity by macOS, so a protected folder may
occasionally require privacy approval again after an update. Consistent permissions
across signed updates—and distribution to other Macs without a Gatekeeper warning—
require the same Apple Developer ID certificate and notarization. Folio keeps a
stable bundle identifier so a signed release can retain that identity.
