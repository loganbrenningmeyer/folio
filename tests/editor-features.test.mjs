import assert from "node:assert/strict";
import test from "node:test";
import { snippet, hasNextSnippetField, nextSnippetField } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import {
  alignScrollAnchors,
  extractSearchExcerpts,
  formatShortcutForPlatform,
  resolveShortcutForPlatform,
  isCommandShortcut,
  isRecordedShortcut,
  markdownBlockCompletion,
  imageLineText,
  decodeImageSrc,
  noteImageAttachments,
  renamedImageSrc,
  renameImageInContent,
  imageTitleText,
  mapScrollOffset,
  parseImageLine,
  parseImageTitle,
  resolveNoteLink,
  setPythonFenceRunnable,
  shortcutFromEvent,
  mathSpanEnd,
  shortcutMatches,
  tableSnippetTemplate,
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
  assert.equal(formatShortcutForPlatform(shortcut, true), "⌃⇧\\");
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
  assert.equal(formatShortcutForPlatform(metaArrow, true), "⌘←");
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

test("a table's cells are tab stops, read across each row and then down", () => {
  assert.equal(
    tableSnippetTemplate(3, 3),
    [
      "| ${1:Column 1} | ${2:Column 2} | ${3:Column 3} |",
      "| --- | --- | --- |",
      "| ${4} | ${5} | ${6} |",
      "| ${7} | ${8} | ${9} |${0}",
    ].join("\n"),
  );

  // A heading row on its own still ends at a stop past the table.
  assert.equal(
    tableSnippetTemplate(2, 1),
    ["| ${1:Column 1} | ${2:Column 2} |", "| --- | --- |${0}"].join("\n"),
  );
});

test("tabbing a table runs top left to bottom right and then leaves it", () => {
  let state = EditorState.create({ doc: "" });
  const editor = {
    get state() {
      return state;
    },
    dispatch(transaction) {
      state = transaction.state;
    },
  };

  snippet(tableSnippetTemplate(2, 3))(editor, null, 0, 0);

  const rows = ["| Column 1 | Column 2 |", "| --- | --- |", "|  |  |", "|  |  |"];
  assert.equal(state.doc.toString(), rows.join("\n"));

  // The first heading arrives selected, ready to be typed over.
  const headingAt = rows[0].indexOf("Column 1");
  assert.equal(state.selection.main.from, headingAt);
  assert.equal(state.selection.main.to, headingAt + "Column 1".length);

  // Every cell in reading order, the alignment row skipped, and one last stop
  // that parks the cursor past the table rather than back inside it.
  const visited = [state.selection.main.from];
  while (hasNextSnippetField(state)) {
    assert.equal(nextSnippetField(editor), true);
    visited.push(state.selection.main.from);
  }
  // Six cells, then the stop that ends the run past the table.
  assert.equal(visited.length, 7);

  const lineOf = (position) => state.doc.lineAt(position).number;
  assert.deepEqual(visited.map(lineOf), [1, 1, 3, 3, 4, 4, 4]);
  // Reading order: each stop is further into the document than the last.
  for (let index = 1; index < visited.length; index += 1) {
    assert.ok(visited[index] > visited[index - 1]);
  }
  // The run ends where the table does.
  assert.equal(visited.at(-1), state.doc.length);
});

/** The Markdown parser Folio writes with, math extension and all. */
function markdownLanguage() {
  return markdown({
    extensions: [
      {
        defineNodes: ["FolioMath"],
        parseInline: [
          {
            name: "FolioMath",
            before: "Escape",
            parse(cx, _next, pos) {
              const end = mathSpanEnd((at) => cx.char(at), pos, cx.end);
              if (end < 0) return -1;
              return cx.addElement(cx.elt("FolioMath", pos, end));
            },
          },
        ],
      },
    ],
  });
}

/** Every node of the given kinds, as `name:text` pairs, in document order. */
function nodesMatching(doc, pattern) {
  const state = EditorState.create({ doc, extensions: [markdownLanguage()] });
  const found = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (pattern.test(node.name)) {
        found.push(`${node.name}:${state.doc.sliceString(node.from, node.to)}`);
      }
    },
  });
  return found;
}

test("math spans end where the delimiter that opened them closes", () => {
  const at = (text) => (position) => text.charCodeAt(position);
  const spanOf = (text) => {
    const end = mathSpanEnd(at(text), 0, text.length);
    return end < 0 ? undefined : text.slice(0, end);
  };

  assert.equal(spanOf("$x + y$ and more"), "$x + y$");
  assert.equal(spanOf("$$\na**b**\n$$ after"), "$$\na**b**\n$$");
  assert.equal(spanOf("\\[ p \\] rest"), "\\[ p \\]");
  assert.equal(spanOf("\\( q \\) rest"), "\\( q \\)");

  // A run that never closes is not math, and neither is an empty one.
  assert.equal(spanOf("$ nothing closes this"), undefined);
  assert.equal(spanOf("$$ nor does this"), undefined);
  assert.equal(spanOf("$$"), undefined);
  // Inline math holds no dollar of its own and stays on its line.
  assert.equal(spanOf("$\nx$"), undefined);
  assert.equal(spanOf("$$x$"), undefined);
  // Text that merely starts with a backslash is not a delimiter.
  assert.equal(spanOf("\\alpha $x$"), undefined);
});

test("stars inside math are formula, not emphasis", () => {
  // Display and inline math alike keep their stars and underscores.
  assert.deepEqual(nodesMatching("$$\na **b** c *d* _e_\n$$", /Emphasis|FolioMath/), [
    "FolioMath:$$\na **b** c *d* _e_\n$$",
  ]);
  assert.deepEqual(nodesMatching("Inline $x **y** z$ here.", /Emphasis|FolioMath/), [
    "FolioMath:$x **y** z$",
  ]);
  assert.deepEqual(nodesMatching("Also \\[ p **q** \\] and \\( r *s* \\).", /Emphasis|FolioMath/), [
    "FolioMath:\\[ p **q** \\]",
    "FolioMath:\\( r *s* \\)",
  ]);

  // Fenced code was already safe, and stays so.
  assert.deepEqual(nodesMatching("```\nfence **bold**\n```", /Emphasis/), []);

  // Prose still reads as prose, and an escaped dollar is not an opener.
  assert.deepEqual(
    nodesMatching("Normal **bold** and *italic*.", /StrongEmphasis|^Emphasis$/),
    ["StrongEmphasis:**bold**", "Emphasis:*italic*"],
  );
  assert.deepEqual(nodesMatching("Costs \\$5 and **bold**.", /StrongEmphasis|FolioMath/), [
    "StrongEmphasis:**bold**",
  ]);
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

test("attachments list the library images a page references, once each", () => {
  const content = [
    "# Diffusion",
    "",
    '![Noise](bad_noise.png "Variance grows | width=480 center")',
    "",
    "Inline ![again](bad_noise.png) and ![second](figs/schedule.svg).",
    "",
    "![spaced](<my figures/beta%20plot.jpg>)",
  ].join("\n");
  assert.deepEqual(noteImageAttachments(content), [
    { src: "bad_noise.png", name: "bad_noise.png" },
    { src: "figs/schedule.svg", name: "schedule.svg" },
    { src: "my figures/beta%20plot.jpg", name: "beta plot.jpg" },
  ]);
});

test("attachments ignore images that are not files in the library", () => {
  const content = [
    "![data](data:image/png;base64,AAAA)",
    "![remote](https://example.com/plot.png)",
    "![absolute](/tmp/plot.png)",
    "![document](notes.md)",
    "[not an image](plot.png)",
    "",
    "```markdown",
    "![sample](inside-a-fence.png)",
    "```",
    "",
    "~~~",
    "![tilde](tilde-fence.png)",
    "~~~",
  ].join("\n");
  assert.deepEqual(noteImageAttachments(content), []);
});

test("attachments follow the page text as images are added and removed", () => {
  const withImage = "Body\n\n![Noise](bad_noise.png)\n";
  const withoutImage = "Body\n\nThe image reference is gone.\n";
  assert.deepEqual(noteImageAttachments(withImage), [
    { src: "bad_noise.png", name: "bad_noise.png" },
  ]);
  assert.deepEqual(noteImageAttachments(withoutImage), []);
});

test("renaming an image rewrites every reference and nothing else", () => {
  const content = [
    "# Diffusion",
    "",
    '![Noise](bad_noise.png "Variance grows | width=480 center")',
    "",
    "Shown again as ![noise](bad_noise.png) and beside ![other](good_noise.png).",
    "",
    "```markdown",
    "![sample](bad_noise.png)",
    "```",
    "",
    "The text bad_noise.png is prose, and [a link](bad_noise.png) is not an image.",
  ].join("\n");
  const renamed = renameImageInContent(
    content,
    "bad_noise.png",
    "variance-drift.png",
  );
  assert.equal(
    renamed,
    [
      "# Diffusion",
      "",
      '![Noise](variance-drift.png "Variance grows | width=480 center")',
      "",
      "Shown again as ![noise](variance-drift.png) and beside ![other](good_noise.png).",
      "",
      "```markdown",
      "![sample](bad_noise.png)",
      "```",
      "",
      "The text bad_noise.png is prose, and [a link](bad_noise.png) is not an image.",
    ].join("\n"),
  );
});

test("renaming an image matches the src as written, encoding and all", () => {
  const content = [
    "![a](figs/beta%20plot.jpg)",
    "![b](<figs/beta plot.jpg>)",
    "![c](../figs/beta%20plot.jpg)",
  ].join("\n");
  const renamed = renameImageInContent(
    content,
    "figs/beta%20plot.jpg",
    "figs/gamma.jpg",
  );
  assert.equal(
    renamed,
    [
      "![a](figs/gamma.jpg)",
      "![b](<figs/beta plot.jpg>)",
      "![c](../figs/beta%20plot.jpg)",
    ].join("\n"),
  );
  // A renamed page still parses as one image line, so the widget survives.
  assert.equal(parseImageLine("![a](figs/gamma.jpg)")?.src, "figs/gamma.jpg");
});

test("a renamed image keeps the folder its reference already pointed through", () => {
  assert.equal(renamedImageSrc("bad_noise.png", "drift.png"), "drift.png");
  assert.equal(
    renamedImageSrc("figs/bad_noise.png", "variance drift.png"),
    "figs/variance%20drift.png",
  );
  assert.equal(
    renamedImageSrc("../figs/beta%20plot.jpg", "gamma (2).jpg"),
    "../figs/gamma%20%282%29.jpg",
  );
  // Encoded names survive the round trip back to a readable file name.
  assert.equal(decodeImageSrc("figs/variance%20drift.png"), "figs/variance drift.png");
});

test("references from different folders resolve to the same library file", () => {
  // This is what lets a rename fix up every page that shows the image, not
  // just the one it was renamed from.
  assert.equal(
    resolveNoteLink("02 Research/Idea.md", "../figs/plot.png").path,
    "figs/plot.png",
  );
  assert.equal(resolveNoteLink("figs/Gallery.md", "plot.png").path, "figs/plot.png");
  assert.equal(resolveNoteLink("figs/Gallery.md", "./plot.png").path, "figs/plot.png");
  // An image outside the library is left alone.
  assert.equal(resolveNoteLink("Idea.md", "../outside.png").escapes, true);
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
  const mac = (shortcut) => formatShortcutForPlatform(shortcut, true);
  // Recorded in a different order than macOS displays them.
  assert.equal(mac("Meta-Shift-Ctrl-Alt-k"), "⌃⌥⇧⌘K");
  assert.equal(mac("Ctrl-Shift-e"), "⌃⇧E");
  assert.equal(mac("Meta-ArrowRight"), "⌘→");
  assert.equal(mac("Meta-Backspace"), "⌘⌫");
  assert.equal(mac("Shift-F2"), "⇧F2");
  assert.equal(mac("Meta-Space"), "⌘␣");
  assert.equal(mac(""), "Press shortcut");
});

test("shortcuts render as Windows key names in the same order", () => {
  const windows = (shortcut) => formatShortcutForPlatform(shortcut, false);
  assert.equal(windows("Meta-Shift-Ctrl-Alt-k"), "Ctrl+Alt+Shift+Win+K");
  assert.equal(windows("Ctrl-Shift-e"), "Ctrl+Shift+E");
  assert.equal(windows("Alt-Shift-\\"), "Alt+Shift+\\");
  assert.equal(windows("Ctrl-ArrowRight"), "Ctrl+Right");
  assert.equal(windows("Ctrl-Backspace"), "Ctrl+Backspace");
  assert.equal(windows("Shift-F2"), "Shift+F2");
  assert.equal(windows("Ctrl-Space"), "Ctrl+Space");
  assert.equal(windows(""), "Press shortcut");
});

test("default shortcuts land on each platform's own modifier", () => {
  // The app commands. Command on macOS; Ctrl on Windows, where the Meta key
  // belongs to the operating system.
  assert.equal(resolveShortcutForPlatform("Mod-k", true), "Meta-k");
  assert.equal(resolveShortcutForPlatform("Mod-k", false), "Ctrl-k");
  assert.equal(
    resolveShortcutForPlatform("Mod-Shift-e", false),
    "Ctrl-Shift-e",
  );

  // Snippets take a second chord, which must not collide with the app command
  // one. Ctrl is free on macOS; on Windows it is not, so snippets use Alt.
  assert.equal(resolveShortcutForPlatform("Snippet-e", true), "Ctrl-Shift-e");
  assert.equal(resolveShortcutForPlatform("Snippet-e", false), "Alt-Shift-e");
  assert.notEqual(
    resolveShortcutForPlatform("Snippet-e", false),
    resolveShortcutForPlatform("Mod-Shift-e", false),
  );

  // A shortcut a reader recorded already names its modifiers.
  assert.equal(resolveShortcutForPlatform("Ctrl-Shift-p", false), "Ctrl-Shift-p");
  assert.equal(resolveShortcutForPlatform("", false), "");

  // Every resolved default has to be a shortcut the recorder would accept.
  for (const platform of [true, false]) {
    for (const placeholder of ["Mod-k", "Mod-ArrowLeft", "Snippet-\\"]) {
      assert.equal(
        isCommandShortcut(resolveShortcutForPlatform(placeholder, platform)),
        true,
        `${placeholder} on ${platform ? "macOS" : "Windows"}`,
      );
    }
  }
});
