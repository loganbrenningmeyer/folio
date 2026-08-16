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
  assert.match(html, /Find a page/);
  assert.match(html, /class="katex"/);
  assert.match(html, /<math/);
  assert.doesNotMatch(html, /\$E = mc\^2\$/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("ships the requested reading and editing capabilities", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
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
  assert.match(layout, /\/og\.png/);
  assert.match(packageJson, /"name": "folio-markdown-reader"/);
  assert.match(packageJson, /"rehype-highlight": "\^7\.0\.2"/);
  assert.match(packageJson, /"remark-math": "\^6\.0\.0"/);
  assert.match(packageJson, /"rehype-katex": "\^7\.0\.1"/);

  await access(new URL("../public/og.png", import.meta.url));
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
