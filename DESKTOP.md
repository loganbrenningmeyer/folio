# Folio on the desktop

Folio's desktop build is a native application on macOS and on Windows. Its
packaged app loads the reader directly from the installed program; it does not
run a localhost server, open a browser, or require ChatGPT/Sites authentication.

Each platform has to be built on itself. Tauri links against the system webview —
WKWebView on macOS, WebView2 on Windows — so there is no cross-compiling from one
to the other. The [release workflows](.github/workflows/) build both from a tag,
one job per runner.

## macOS

### Install or update Folio

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

### Build a DMG

```sh
npm run desktop:dmg
```

The installer is written under `src-tauri/target/release/bundle/dmg/`.

### Sharing the app with other Macs

This local build is suitable for this Mac and is ad-hoc signed. A rebuilt ad-hoc
version can be treated as a new code identity by macOS, so a protected folder may
occasionally require privacy approval again after an update. Consistent permissions
across signed updates—and distribution to other Macs without a Gatekeeper warning—
require the same Apple Developer ID certificate and notarization. Folio keeps a
stable bundle identifier so a signed release can retain that identity.

## Windows

Windows needs the MSVC build tools Rust links against; installing Rust through
[rustup](https://rustup.rs) with the default `x86_64-pc-windows-msvc` toolchain
prompts for them. Then:

```sh
npm install
npm run desktop:exe
```

The installer is written to
`src-tauri/target/release/bundle/nsis/Folio_<version>_x64-setup.exe`. Running it
installs Folio for the current user, so it needs no administrator approval. Use
`npm run desktop:msi` instead for an MSI, which is the form group policy
deployment usually wants.

Folio needs the Microsoft Edge WebView2 runtime, which Windows 11 already has.
The installer downloads it on machines that do not, so it is not vendored into
the download.

`npm run desktop:install` is macOS-only — it moves an app bundle into an
Applications folder, which has no Windows equivalent. Run the installer above
instead.

### Signing

Windows shows a SmartScreen warning for an unsigned installer, the way Gatekeeper
does on macOS. Removing it requires an Authenticode certificate; Folio does not
configure one, so a downloaded installer needs **More info → Run anyway** on
first launch.

## Development

```sh
npm run desktop:dev
```

Development mode uses a temporary Vite development address for hot reload. The
installed production app never uses localhost.

## Keyboard shortcuts

Folio's default shortcuts follow the platform it is running on: the ones written
with Command on macOS use Ctrl on Windows, since Windows reserves its own Meta
key for the operating system. The built-in text snippets take a second chord —
Ctrl+Shift on macOS, where Command carries the app shortcuts, and Alt+Shift on
Windows, where Ctrl+Shift is already taken.

Shortcuts you record yourself are stored as the keys you actually pressed, so
they are not translated.

## Folder access and saving

The first folder selection uses the platform's own folder picker. Folio remembers
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

Deleting a page moves it to the system trash rather than unlinking it, so it stays
recoverable: the Finder's Trash on macOS, the Recycle Bin on Windows.

macOS itself can still show a one-time privacy request for protected locations
such as Documents, Desktop, removable drives, or network volumes. That operating
system request cannot be bypassed safely. macOS normally remembers the choice for
the installed build. Windows has no equivalent prompt for a folder you picked
yourself.

### Naming pages on Windows

Windows refuses file names that macOS accepts: names holding `< > : " | ? *`,
names ending in a dot or a space, and the device names it reserves (`CON`,
`PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), with or without an
extension. The Windows build reports those as Folio's own message when you type
one. The macOS build still accepts them, so a library authored on a Mac can hold
a page that could not be copied to Windows under the same name.
