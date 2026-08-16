import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Folio reader", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Folio — Your Markdown library, beautifully connected<\/title>/i);
  assert.match(html, /Welcome to Folio/);
  assert.match(html, /Open folder/);
  assert.match(html, /New Markdown file/);
  assert.match(html, /New folder/);
  assert.match(html, /Find a page/);
  assert.match(html, /Hide library panel/);
  assert.match(html, /Hide page outline panel/);
  assert.match(html, /class="katex"/);
  assert.match(html, /<math/);
  assert.match(html, /data-source-line="\d+"/);
  assert.match(
    html,
    /<div data-source-line="\d+"><span class="katex-display"/,
    "display math needs its own scroll-sync anchor, since KaTeX replaces the element it renders",
  );
  assert.doesNotMatch(html, /\$E = mc\^2\$/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("ships the requested reading, editing, and organization capabilities", async () => {
  const [page, layout, packageJson, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /showDirectoryPicker/);
  assert.match(page, /createWritable/);
  assert.match(page, /ReactMarkdown/);
  assert.match(page, /rehypeHighlight/);
  assert.match(page, /remarkMath/);
  assert.match(page, /rehypeKatex/);
  assert.match(page, /normalizeMathDelimiters/);
  assert.match(page, /remarkGfm/);
  assert.match(page, /withWikiLinks/);
  assert.match(page, /"preview" \| "editor" \| "split"/);
  assert.match(page, /prefers-color-scheme: dark/);
  assert.match(page, /getDirectoryHandle/);
  assert.match(page, /getFileHandle/);
  assert.match(page, /removeEntry/);
  assert.match(page, /createEntry/);
  assert.match(page, /draggable/);
  assert.match(page, /<CodeMirror/);
  assert.match(page, /markdown\(\{ codeLanguages: languages \}\)/);
  assert.match(page, /cm-folio-math-line/);
  assert.match(page, /cm-folio-code-line/);
  assert.match(page, /spellcheck: "false"/);
  assert.match(page, /drawSelection: true/);
  assert.match(page, /EditorView\.lineWrapping/);
  assert.match(page, /FONT_CHOICES/);
  assert.match(page, /COLOR_PALETTES/);
  assert.match(page, /document-position/);
  assert.match(page, /nativeLibrary\.write/);
  assert.match(page, /FOLIO_NOTE_DRAG_TYPE/);
  assert.match(page, /draggedNoteIdRef/);
  assert.doesNotMatch(page, /Auto-save on/);
  assert.match(page, /DEFAULT_TEXT_SNIPPETS/);
  assert.match(page, /createSnippetExtension/);
  assert.match(page, /const EDITOR_BASIC_SETUP/);
  assert.match(page, /basicSetup=\{EDITOR_BASIC_SETUP\}/);
  assert.match(page, /const updateContent = useCallback/);
  assert.match(page, /onChange=\{updateContent\}/);
  assert.doesNotMatch(page, /onChange=\{\(value\) => updateContent\(value\)\}/);
  assert.match(page, /markdownBlockAutoCloseExtension/);
  assert.match(page, /markdownBlockCompletion/);
  assert.match(page, /toCodeMirrorSnippet/);
  assert.match(page, /folio-snippet-shortcuts/);
  assert.match(page, /APP_SHORTCUT_COMMANDS/);
  assert.match(page, /parseStoredAppShortcuts/);
  assert.match(page, /folio-app-shortcuts/);
  assert.match(page, /StoredAppShortcutSettings/);
  assert.match(page, /appShortcutsLoaded/);
  assert.match(page, /Keyboard shortcuts/);
  for (const commandId of [
    "find",
    "save",
    "previous-page",
    "next-page",
    "new-file",
    "new-folder",
    "open-folder",
    "toggle-read-write",
    "toggle-split",
    "toggle-library",
    "toggle-outline",
  ]) {
    assert.match(page, new RegExp(`id: "${commandId}"`));
  }
  assert.match(page, /Ctrl-Shift-e/);
  assert.match(page, /Ctrl-Shift-\\\\/);
  assert.match(page, /extractSearchExcerpts/);
  assert.match(page, /result-excerpt/);
  assert.doesNotMatch(page, /searchResults\.slice/);
  assert.match(page, /libraryCollapsed/);
  assert.match(page, /outlineCollapsed/);
  assert.match(page, /mapScrollOffset/);
  assert.match(page, /alignScrollAnchors/);
  assert.match(page, /rehypeSourceLines/);
  assert.match(page, /isDisplayMath/);
  assert.match(css, /\.mode-split \.page-turner\s*\{[^}]*display:\s*none/);
  assert.match(page, /splitScrollLocked/);
  assert.match(page, /folio-split-scroll-locked/);
  assert.match(page, /restoreLibrary|nativeLibrary\.restore/);
  assert.equal(
    page.match(/nativeLibrary\.choose\(\)/g)?.length,
    1,
    "the native folder picker should only open from the Open folder action",
  );
  assert.match(page, /folio-reader-font/);
  assert.match(page, /folio-editor-font/);
  assert.match(page, /folio-color-palette/);
  assert.match(page, /Open preferences/);
  assert.doesNotMatch(page, /spellCheck="true"|syncEditorScroll|renderEditorSyntax/);
  assert.match(css, /\.markdown-body h3\s*\{[^}]*font-size:\s*20px/);
  assert.match(css, /\.markdown-body h4\s*\{[^}]*font-size:\s*17px[^}]*font-weight:\s*700/);
  assert.match(css, /\.folio-code-editor/);
  assert.match(page, /theme="none"/);
  assert.match(css, /cursor:\s*text !important/);
  assert.match(css, /\.cm-selectionLayer\s*\{[^}]*z-index:\s*3 !important/);
  assert.match(css, /\.cm-selectionBackground\s*\{[^}]*var\(--editor-selection\) !important/);
  assert.match(css, /\.cm-selectionBackground\s*\{[^}]*box-shadow:\s*none !important/);
  assert.match(css, /\.editor-pane\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/);
  assert.match(css, /\.cm-lineWrapping\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.font-popover/);
  assert.match(css, /\.palette-grid/);
  assert.match(css, /\.document-progress/);
  assert.match(css, /\.snippet-card/);
  assert.match(css, /\.result-excerpt/);
  assert.match(css, /\.workspace\.library-collapsed/);
  assert.match(css, /\.workspace\.outline-collapsed/);
  assert.match(
    css,
    /\.workspace\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/,
    "the workspace grid row must not grow with long documents",
  );
  assert.match(css, /@media \(max-width:\s*960px\)/);
  assert.match(css, /\.library-scrim/);
  assert.match(css, /\.outline-scrim/);
  assert.match(css, /\.page-title/);
  assert.match(css, /\.markdown-body ul\s*\{[^}]*list-style:\s*disc outside/);
  assert.match(css, /\.markdown-body ol\s*\{[^}]*list-style:\s*decimal outside/);
  assert.match(css, /\.markdown-body li\.task-list-item/);
  assert.match(css, /data-palette="slate"/);
  assert.match(css, /data-palette="graphite"/);
  assert.doesNotMatch(css, /user-select:\s*text !important/);
  assert.match(css, /--syntax-math:\s*#266fa9/);
  assert.match(layout, /\/og\.png/);
  assert.match(packageJson, /"name": "folio-markdown-reader"/);
  assert.match(packageJson, /"rehype-highlight": "\^7\.0\.2"/);
  assert.match(packageJson, /"remark-math": "\^6\.0\.0"/);
  assert.match(packageJson, /"rehype-katex": "\^7\.0\.1"/);
  assert.match(packageJson, /"@uiw\/react-codemirror": "\^4\.25\.11"/);
  assert.match(packageJson, /"@codemirror\/autocomplete": "\^6\.20\.3"/);

  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});

test("ships a native macOS target with direct and persistent file access", async () => {
  const [packageJson, nativeBridge, rustBackend, tauriConfig, desktopGuide] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../desktop/native.ts", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
      readFile(new URL("../DESKTOP.md", import.meta.url), "utf8"),
    ]);

  assert.match(packageJson, /"desktop:install"/);
  assert.match(packageJson, /"desktop:update"/);
  assert.match(nativeBridge, /restore_library/);
  assert.match(nativeBridge, /choose_library/);
  assert.match(nativeBridge, /write_note/);
  assert.match(nativeBridge, /move_note/);
  assert.match(rustBackend, /validate_relative_path/);
  assert.match(rustBackend, /atomic_write/);
  assert.match(rustBackend, /blocking_pick_folder/);
  assert.match(rustBackend, /async fn choose_library/);
  assert.match(tauriConfig, /"frontendDist": "\.\.\/dist-desktop"/);
  assert.match(tauriConfig, /com\.loganbrenningmeyer\.folio/);
  assert.match(
    tauriConfig,
    /"dragDropEnabled": false/,
    "Tauri's native file-drop interceptor must not consume internal note moves",
  );
  assert.match(
    await readFile(
      new URL("../src-tauri/capabilities/default.json", import.meta.url),
      "utf8",
    ),
    /core:window:allow-destroy/,
  );
  assert.match(desktopGuide, /npm run desktop:update/);

  await access(new URL("../desktop/index.html", import.meta.url));
  await access(new URL("../src-tauri/icons/icon.icns", import.meta.url));
});
