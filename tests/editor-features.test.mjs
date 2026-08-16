import assert from "node:assert/strict";
import test from "node:test";
import { snippet, hasNextSnippetField, nextSnippetField } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import {
  alignScrollAnchors,
  extractSearchExcerpts,
  formatShortcut,
  isCommandShortcut,
  isRecordedShortcut,
  markdownBlockCompletion,
  imageLineText,
  imageTitleText,
  mapScrollOffset,
  parseImageLine,
  parseImageTitle,
  resolveNoteLink,
  setPythonFenceRunnable,
  shortcutFromEvent,
  shortcutMatches,
  toCodeMirrorSnippet,
} from "../app/editor-utils.js";

function keyboardEvent(overrides = {}) {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function typeMarkdownDelimiter(state, text) {
  const { from, to } = state.selection.main;
  const edit = markdownBlockCompletion(state.doc.toString(), from, to, text);
  assert.ok(edit, `expected ${JSON.stringify(text)} to be handled`);
  return state.update({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.anchor },
  }).state;
}

test("records the unshifted physical key for snippet shortcuts", () => {
  const shortcut = shortcutFromEvent({
    key: "|",
    code: "Backslash",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: true,
  });

  assert.equal(shortcut, "Ctrl-Shift-\\");
  assert.equal(formatShortcut(shortcut), "⌃⇧\\");
  assert.equal(isRecordedShortcut(shortcut), true);
  assert.equal(
    shortcutFromEvent({
      key: "e",
      code: "KeyE",
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    }),
    undefined,
  );
});

test("records bare named app shortcuts without accepting bare printable keys", () => {
  const bareArrowEvent = keyboardEvent({ key: "ArrowLeft", code: "ArrowLeft" });
  const arrowShortcut = shortcutFromEvent(
    bareArrowEvent,
    { allowUnmodified: true },
  );

  assert.equal(shortcutFromEvent(bareArrowEvent), undefined);
  assert.equal(arrowShortcut, "ArrowLeft");
  assert.equal(isCommandShortcut(arrowShortcut), true);
  assert.equal(isRecordedShortcut(arrowShortcut), false);
  assert.equal(
    shortcutFromEvent(keyboardEvent({ key: "e", code: "KeyE" }), {
      allowUnmodified: true,
    }),
    undefined,
  );
  assert.equal(isCommandShortcut("e"), false);
  assert.equal(isCommandShortcut("Shift-e"), false);
});

test("records Meta plus Arrow exactly and formats the canonical shortcut", () => {
  const metaArrow = shortcutFromEvent(
    keyboardEvent({
      key: "ArrowLeft",
      code: "ArrowLeft",
      metaKey: true,
    }),
    { allowUnmodified: true },
  );
  const bareArrow = shortcutFromEvent(
    keyboardEvent({ key: "ArrowLeft", code: "ArrowLeft" }),
    { allowUnmodified: true },
  );

  assert.equal(metaArrow, "Meta-ArrowLeft");
  assert.equal(formatShortcut(metaArrow), "⌘←");
  assert.equal(isCommandShortcut(metaArrow), true);
  assert.notEqual(metaArrow, bareArrow);
  assert.equal(shortcutMatches("Meta-ArrowLeft", metaArrow), true);
  assert.equal(shortcutMatches("ArrowLeft", metaArrow), false);
  assert.equal(shortcutMatches("Meta-ArrowLeft", bareArrow), false);
});

test("command shortcuts accept modified typing keys and safe named keys", () => {
  assert.equal(isCommandShortcut("Ctrl-Shift-e"), true);
  assert.equal(isCommandShortcut("ArrowRight"), true);
  assert.equal(isCommandShortcut("Shift-F2"), true);
  assert.equal(isCommandShortcut("F12"), true);
  assert.equal(isCommandShortcut("Ctrl-Ctrl-e"), false);
  assert.equal(isCommandShortcut("Shift-Shift-F2"), false);
});

test("converts Folio placeholders and preserves escaped literal stops", () => {
  assert.equal(
    toCodeMirrorSnippet(["```$1", "$0", "```"].join("\n")),
    ["```${1}", "${0}", "```"].join("\n"),
  );
  assert.equal(toCodeMirrorSnippet("prefix $2 suffix"), "prefix ${2} suffix${0}");
  assert.equal(toCodeMirrorSnippet(String.raw`literal \$1`), "literal $1");
  assert.equal(toCodeMirrorSnippet("${1:language}\n${0}"), "${1:language}\n${0}");
});

test("CodeMirror inserts a snippet and tabs from $1 to $0", () => {
  let state = EditorState.create({ doc: "" });
  const editor = {
    get state() {
      return state;
    },
    dispatch(transaction) {
      state = transaction.state;
    },
  };

  const template = toCodeMirrorSnippet(["```$1", "$0", "```"].join("\n"));
  snippet(template)(editor, null, 0, 0);

  assert.equal(state.doc.toString(), "```\n\n```");
  assert.equal(state.selection.main.from, 3);
  assert.equal(hasNextSnippetField(state), true);
  assert.equal(nextSnippetField(editor), true);
  assert.equal(state.selection.main.from, 4);
  assert.equal(hasNextSnippetField(state), false);
});

test("pairs delimiters and promotes centered runs into three-line blocks", () => {
  let mathState = EditorState.create({ doc: "" });
  mathState = typeMarkdownDelimiter(mathState, "$");
  assert.equal(mathState.doc.toString(), "$$");
  assert.equal(mathState.selection.main.head, 1);
  mathState = typeMarkdownDelimiter(mathState, "$");
  assert.equal(mathState.doc.toString(), "$$\n\n$$");
  assert.equal(mathState.doc.lines, 3);
  assert.equal(mathState.selection.main.head, 3);

  let codeState = EditorState.create({ doc: "" });
  codeState = typeMarkdownDelimiter(codeState, "`");
  assert.equal(codeState.doc.toString(), "``");
  assert.equal(codeState.selection.main.head, 1);
  codeState = typeMarkdownDelimiter(codeState, "`");
  assert.equal(codeState.doc.toString(), "````");
  assert.equal(codeState.selection.main.head, 2);
  codeState = typeMarkdownDelimiter(codeState, "`");
  assert.equal(codeState.doc.toString(), "```\n\n```");
  assert.equal(codeState.doc.lines, 3);
  assert.equal(codeState.selection.main.head, 4);
});

test("block promotion preserves indentation and normalizes an existing closer", () => {
  let mathState = EditorState.create({ doc: "  ", selection: { anchor: 2 } });
  mathState = typeMarkdownDelimiter(mathState, "$");
  mathState = typeMarkdownDelimiter(mathState, "$");
  assert.equal(mathState.doc.toString(), "  $$\n  \n  $$");
  assert.equal(mathState.doc.lines, 3);
  assert.equal(mathState.selection.main.head, 7);

  const mathWithCloser = EditorState.create({
    doc: "$\n\n$$",
    selection: { anchor: 1 },
  });
  const normalizedMath = typeMarkdownDelimiter(mathWithCloser, "$");
  assert.equal(normalizedMath.doc.toString(), "$$\n\n$$");
  assert.equal(normalizedMath.doc.lines, 3);

  const codeWithCloser = EditorState.create({
    doc: "``\n\n```",
    selection: { anchor: 2 },
  });
  const normalizedCode = typeMarkdownDelimiter(codeWithCloser, "`");
  assert.equal(normalizedCode.doc.toString(), "```\n\n```");
  assert.equal(normalizedCode.doc.lines, 3);
  assert.equal(normalizedCode.selection.main.head, 4);
});

test("delimiter pairing overtypes inline closers and ignores unsafe contexts", () => {
  let inlineMath = EditorState.create({ doc: "text ", selection: { anchor: 5 } });
  inlineMath = typeMarkdownDelimiter(inlineMath, "$");
  inlineMath = inlineMath.update({
    changes: { from: 6, insert: "x" },
    selection: { anchor: 7 },
  }).state;
  inlineMath = typeMarkdownDelimiter(inlineMath, "$");
  assert.equal(inlineMath.doc.toString(), "text $x$");
  assert.equal(inlineMath.selection.main.head, 8);

  let inlineCode = EditorState.create({ doc: "", selection: { anchor: 0 } });
  inlineCode = typeMarkdownDelimiter(inlineCode, "`");
  inlineCode = inlineCode.update({
    changes: { from: 1, insert: "x" },
    selection: { anchor: 2 },
  }).state;
  inlineCode = typeMarkdownDelimiter(inlineCode, "`");
  assert.equal(inlineCode.doc.toString(), "`x`");
  assert.equal(inlineCode.selection.main.head, 3);

  assert.equal(markdownBlockCompletion("text $", 6, 6, "$"), undefined);
  assert.equal(markdownBlockCompletion("$tail", 1, 1, "$"), undefined);
  assert.equal(markdownBlockCompletion("\\", 1, 1, "$"), undefined);
  assert.equal(markdownBlockCompletion("$", 0, 1, "$"), undefined);
  assert.equal(markdownBlockCompletion("$", 1, 1, "$$"), undefined);
  assert.equal(markdownBlockCompletion("$$\nvalue\n$", 10, 10, "$"), undefined);
  assert.equal(markdownBlockCompletion("```\nvalue\n``", 12, 12, "`"), undefined);
  assert.equal(markdownBlockCompletion("```\n$", 5, 5, "$"), undefined);
  assert.equal(markdownBlockCompletion("$$\n``", 5, 5, "`"), undefined);
});

test("search excerpts return up to three distinct matching lines with line numbers", () => {
  const excerpts = extractSearchExcerpts(
    [
      "Heading",
      "First Shape match",
      "second shape match",
      "third SHAPE match",
      "fourth shape match",
    ].join("\r\n"),
    "shape",
  );

  assert.deepEqual(
    excerpts.map(({ line }) => line),
    [2, 3, 4],
  );
  assert.ok(excerpts.every(({ text }) => /shape/i.test(text)));
});

test("search excerpts clip long lines around the literal query", () => {
  const query = "$[literal]";
  const excerpt = extractSearchExcerpts(
    `${"before ".repeat(40)}${query}${" after".repeat(40)}`,
    query,
    1,
  )[0];

  assert.ok(excerpt.text.includes(query));
  assert.ok(excerpt.text.startsWith("…"));
  assert.ok(excerpt.text.endsWith("…"));
});

test("maps split scrolling through nonlinear source anchors in both directions", () => {
  const editorOffsets = [0, 100, 200, 300];
  const previewOffsets = [0, 300, 340, 500];

  assert.equal(mapScrollOffset(50, editorOffsets, previewOffsets), 150);
  assert.equal(mapScrollOffset(150, editorOffsets, previewOffsets), 320);
  assert.equal(mapScrollOffset(320, previewOffsets, editorOffsets), 150);
  assert.equal(mapScrollOffset(-20, editorOffsets, previewOffsets), 0);
  assert.equal(mapScrollOffset(800, editorOffsets, previewOffsets), 500);
});

test("maps scroll offsets safely with empty or duplicate anchors", () => {
  assert.equal(mapScrollOffset(20, [], []), 0);
  assert.equal(mapScrollOffset(20, [0], [12]), 12);
  assert.equal(mapScrollOffset(0, [0, 0, 100], [0, 20, 80]), 0);
  assert.equal(mapScrollOffset(50, [0, 0, 100], [0, 20, 80]), 50);
});

test("aligned anchors keep interior mapping exact and meet both limits", () => {
  // Reader denser than the editor toward the end (math-heavy tail): under
  // pure top alignment the reader bottoms out early and then stalls.
  const aligned = alignScrollAnchors({
    editorOffsets: [0, 500, 1000, 1500, 2000, 2500, 3000],
    previewOffsets: [0, 400, 800, 1150, 1450, 1700, 1900],
    editorLimit: 2200,
    previewLimit: 1500,
    rampSpan: 800,
  });

  for (let index = 1; index < aligned.editorOffsets.length; index += 1) {
    assert.ok(aligned.editorOffsets[index] > aligned.editorOffsets[index - 1]);
    assert.ok(aligned.previewOffsets[index] > aligned.previewOffsets[index - 1]);
  }
  // Interior anchors (before the ramp) are untouched.
  assert.equal(
    mapScrollOffset(1000, aligned.editorOffsets, aligned.previewOffsets),
    800,
  );
  // Endpoints meet exactly, in both directions.
  assert.equal(
    mapScrollOffset(2200, aligned.editorOffsets, aligned.previewOffsets),
    1500,
  );
  assert.equal(
    mapScrollOffset(1500, aligned.previewOffsets, aligned.editorOffsets),
    2200,
  );
  // No dead zone: backing the editor off its bottom moves the reader
  // immediately and substantially, not after a stalled stretch.
  const nearBottom = mapScrollOffset(
    1800,
    aligned.editorOffsets,
    aligned.previewOffsets,
  );
  assert.ok(
    1500 - nearBottom > 100,
    `reader should retreat with the editor, moved ${1500 - nearBottom}px`,
  );
});

test("aligned anchors keep the reader moving when the editor is far taller", () => {
  // A line-dense, word-sparse document: 20000px of editor content against
  // 10000px of reader content in a 1000px viewport. The reader's last
  // screenful spans far more source lines than the editor's, so top
  // alignment alone would pin the reader at its bottom while the editor
  // still has a screenful to travel.
  const editorOffsets = [];
  const previewOffsets = [];
  for (let offset = 0; offset <= 20000; offset += 500) {
    editorOffsets.push(offset);
    previewOffsets.push(offset / 2);
  }

  const aligned = alignScrollAnchors({
    editorOffsets,
    previewOffsets,
    editorLimit: 19000,
    previewLimit: 9000,
    rampSpan: 1000,
  });

  for (let index = 1; index < aligned.editorOffsets.length; index += 1) {
    assert.ok(
      aligned.editorOffsets[index] > aligned.editorOffsets[index - 1] &&
        aligned.previewOffsets[index] > aligned.previewOffsets[index - 1],
      "anchor pairs must stay strictly increasing",
    );
  }

  const atBottom = mapScrollOffset(
    19000,
    aligned.editorOffsets,
    aligned.previewOffsets,
  );
  const oneScreenUp = mapScrollOffset(
    18000,
    aligned.editorOffsets,
    aligned.previewOffsets,
  );
  assert.equal(atBottom, 9000);
  assert.ok(
    atBottom - oneScreenUp > 200,
    `backing off the bottom must move the reader, moved only ${atBottom - oneScreenUp}px`,
  );
});

test("aligned anchors spread a short pane's whole range when the ramp exceeds it", () => {
  const aligned = alignScrollAnchors({
    editorOffsets: [0, 100, 200, 300, 400],
    previewOffsets: [0, 300, 600, 900, 1200],
    editorLimit: 150,
    previewLimit: 900,
    rampSpan: 700,
  });

  assert.equal(
    mapScrollOffset(150, aligned.editorOffsets, aligned.previewOffsets),
    900,
  );
  assert.equal(
    mapScrollOffset(900, aligned.previewOffsets, aligned.editorOffsets),
    150,
  );
  assert.equal(mapScrollOffset(0, aligned.editorOffsets, aligned.previewOffsets), 0);

  // A pane with no scroll range disables syncing instead of dividing by zero.
  assert.deepEqual(
    alignScrollAnchors({
      editorOffsets: [0, 100],
      previewOffsets: [0, 700],
      editorLimit: 0,
      previewLimit: 600,
      rampSpan: 500,
    }),
    { editorOffsets: [0], previewOffsets: [0] },
  );
});

test("setPythonFenceRunnable adds and removes the run flag in place", () => {
  const doc = ["# Title", "", "```python", "print(1)", "```", ""].join("\n");
  const enabled = setPythonFenceRunnable(doc, 3, true);
  assert.equal(
    enabled,
    ["# Title", "", "```python run", "print(1)", "```", ""].join("\n"),
  );
  assert.equal(setPythonFenceRunnable(enabled, 3, false), doc);
  // Enabling twice stays idempotent.
  assert.equal(setPythonFenceRunnable(enabled, 3, true), enabled);
});

test("setPythonFenceRunnable preserves other info words and indentation", () => {
  const doc = ["  ~~~~python title=demo run extra", "pass", "  ~~~~"].join("\n");
  assert.equal(
    setPythonFenceRunnable(doc, 1, false),
    ["  ~~~~python title=demo extra", "pass", "  ~~~~"].join("\n"),
  );
  assert.equal(
    setPythonFenceRunnable(doc, 1, true),
    ["  ~~~~python run title=demo extra", "pass", "  ~~~~"].join("\n"),
  );
});

test("setPythonFenceRunnable refuses lines that are not python fence openers", () => {
  const doc = ["```js", "print(1)", "```", "plain text"].join("\n");
  assert.equal(setPythonFenceRunnable(doc, 1, true), doc);
  assert.equal(setPythonFenceRunnable(doc, 2, true), doc);
  assert.equal(setPythonFenceRunnable(doc, 4, true), doc);
  assert.equal(setPythonFenceRunnable(doc, 99, true), doc);
  assert.equal(setPythonFenceRunnable(doc, 0, true), doc);
});

test("image lines round-trip through parse and serialize", () => {
  assert.deepEqual(parseImageLine("![A cat](cat.png)"), {
    indent: "",
    alt: "A cat",
    src: "cat.png",
    caption: "",
  });
  assert.deepEqual(parseImageLine('  ![](img/plot.webp "My caption | width=420 center")'), {
    indent: "  ",
    alt: "",
    src: "img/plot.webp",
    width: 420,
    align: "center",
    caption: "My caption",
  });
  assert.equal(
    imageLineText(parseImageLine('![x](a.png "width=300 right")')),
    '![x](a.png "width=300 right")',
  );
  assert.equal(
    imageLineText({ alt: "x", src: "a.png", width: 300.4, align: "left" }),
    '![x](a.png "width=300")',
  );
  assert.equal(imageLineText({ src: "a.png" }), "![](a.png)");
});

test("image line parsing rejects non-image and inline-image lines", () => {
  assert.equal(parseImageLine("text ![x](a.png)"), undefined);
  assert.equal(parseImageLine("![x](a.png) trailing"), undefined);
  assert.equal(parseImageLine("[x](a.png)"), undefined);
  assert.equal(parseImageLine("![x](has space.png)"), undefined);
  assert.equal(parseImageLine("![x]()"), undefined);
});

test("titles with no separator keep parsing as directives plus caption", () => {
  assert.deepEqual(parseImageTitle("Portrait width=200"), {
    width: 200,
    caption: "Portrait",
  });
  assert.deepEqual(parseImageTitle("width=200"), { width: 200, caption: "" });
  assert.deepEqual(parseImageTitle(undefined), { caption: "" });
  assert.equal(
    imageTitleText({ width: 340, align: "center", caption: "Portrait" }),
    "Portrait | width=340 center",
  );
  assert.equal(imageTitleText({ align: "left", caption: "" }), "");
  assert.equal(imageTitleText({ caption: "Just a caption" }), "Just a caption");
});

test("captions survive round-tripping even when they read like directives", () => {
  // Without the separator these words would be parsed away as formatting.
  for (const caption of [
    "center",
    "shifted right",
    "left of the barn",
    "width=300 explained",
  ]) {
    const title = imageTitleText({ caption, width: 200 });
    assert.deepEqual(
      parseImageTitle(title),
      { width: 200, caption },
      `round trip with directives failed for ${JSON.stringify(caption)}`,
    );
    const bare = imageTitleText({ caption });
    assert.deepEqual(
      parseImageTitle(bare),
      { caption },
      `round trip without directives failed for ${JSON.stringify(caption)}`,
    );
  }
});

test("captions round-trip through a whole image line", () => {
  const line = imageLineText({
    alt: "Plot",
    src: "plot.png",
    caption: "Figure 1 — results centered on the mean",
    width: 480,
    align: "center",
  });
  assert.equal(
    line,
    '![Plot](plot.png "Figure 1 — results centered on the mean | width=480 center")',
  );
  assert.deepEqual(parseImageLine(line), {
    indent: "",
    alt: "Plot",
    src: "plot.png",
    caption: "Figure 1 — results centered on the mean",
    width: 480,
    align: "center",
  });
});

test("page links resolve against the page that holds them", () => {
  assert.deepEqual(resolveNoteLink("rust/Ownership.md", "Borrowing.md"), {
    kind: "page",
    target: "Borrowing.md",
    path: "rust/Borrowing.md",
    hash: "",
    escapes: false,
  });
  // A `..` that stays inside the library is an ordinary sibling link.
  assert.deepEqual(resolveNoteLink("rust/Ownership.md", "../math/Sets.md"), {
    kind: "page",
    target: "../math/Sets.md",
    path: "math/Sets.md",
    hash: "",
    escapes: false,
  });
  // The same link from a library rooted at rust/ leaves the library.
  assert.deepEqual(resolveNoteLink("Ownership.md", "../math/Sets.md"), {
    kind: "page",
    target: "../math/Sets.md",
    path: "math/Sets.md",
    hash: "",
    escapes: true,
  });
  // A leading slash reads from the library root and cannot escape it.
  assert.deepEqual(resolveNoteLink("rust/Ownership.md", "/math/Sets.md"), {
    kind: "page",
    target: "/math/Sets.md",
    path: "math/Sets.md",
    hash: "",
    escapes: false,
  });
});

test("link kinds separate pages from anchors and the outside world", () => {
  assert.deepEqual(resolveNoteLink("Ownership.md", "#borrowing"), {
    kind: "fragment",
    hash: "borrowing",
  });
  assert.deepEqual(resolveNoteLink("Ownership.md", "wiki:A%20small%20note"), {
    kind: "wiki",
    target: "A small note",
    hash: "",
  });
  assert.equal(
    resolveNoteLink("Ownership.md", "https://example.com/page.md").kind,
    "external",
  );
  assert.equal(resolveNoteLink("Ownership.md", "mailto:me@example.com").kind, "external");
  assert.equal(resolveNoteLink("Ownership.md", undefined).kind, "external");

  // Percent escapes are undone, fragments split off, and a malformed escape
  // is carried through rather than thrown on.
  assert.deepEqual(
    resolveNoteLink("rust/Ownership.md", "../math/Set%20theory.md#axioms"),
    {
      kind: "page",
      target: "../math/Set theory.md",
      path: "math/Set theory.md",
      hash: "axioms",
      escapes: false,
    },
  );
  assert.equal(
    resolveNoteLink("rust/Ownership.md", "100%.md").path,
    "rust/100%.md",
  );
});

test("shortcuts render as macOS symbols in canonical modifier order", () => {
  // Recorded in a different order than macOS displays them.
  assert.equal(formatShortcut("Meta-Shift-Ctrl-Alt-k"), "⌃⌥⇧⌘K");
  assert.equal(formatShortcut("Ctrl-Shift-e"), "⌃⇧E");
  assert.equal(formatShortcut("Meta-ArrowRight"), "⌘→");
  assert.equal(formatShortcut("Meta-Backspace"), "⌘⌫");
  assert.equal(formatShortcut("Shift-F2"), "⇧F2");
  assert.equal(formatShortcut("Meta-Space"), "⌘␣");
  assert.equal(formatShortcut(""), "Press shortcut");
});
