import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import { codeFenceFromPre } from "../app/code-fence.js";

function readFences(markdown) {
  const fences = [];
  renderToStaticMarkup(React.createElement(ReactMarkdown, {
    rehypePlugins: [rehypeSanitize, rehypeHighlight],
    components: { pre: ({ node }) => { fences.push(codeFenceFromPre(node)); return null; } },
  }, markdown));
  return fences;
}

test("Mermaid fences survive the reader's sanitizer and highlighter unchanged", () => {
  const code = 'flowchart LR\n  A["A & B"] --> C["<hello>"]\n';
  assert.deepEqual(readFences(`~~~mermaid\n${code}~~~`), [
    { language: "mermaid", code: code.trimEnd(), meta: "" },
  ]);
});

test("highlighted Python retains indentation and the opt-in run metadata", () => {
  const code = 'import plotly.express as px\nif True:\n    px.line(x=[1, 2], y=[3, 4]).show()';
  assert.deepEqual(readFences(`\`\`\`python run title=demo\n${code}\n\`\`\``), [
    { language: "python", code, meta: "run title=demo" },
  ]);
});

test("ordinary Python stays inert and unlabeled fences have no special renderer", () => {
  assert.deepEqual(readFences('```python\nprint(1)\n```\n\n```\nplain\n```'), [
    { language: "python", code: "print(1)", meta: "" }, undefined,
  ]);
  assert.equal(codeFenceFromPre(undefined), undefined);
});
