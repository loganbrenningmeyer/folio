// Used in the reading pane and inside the sandboxed HTML page bridge.
const selectedMatches = new WeakMap();

export function findReaderMatch(root, query, index) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const highlights = win.CSS?.highlights;
  const name = "folio-reader-match";
  highlights?.delete(name);
  if (!highlights && selectedMatches.has(doc)) {
    const selection = win.getSelection();
    if (selection?.rangeCount && selection.getRangeAt(0) === selectedMatches.get(doc)) {
      selection.removeAllRanges();
    }
    selectedMatches.delete(doc);
  }
  if (!query) return { count: 0, current: 0 };

  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const matches = [];
  let text = "";
  let spans = [];
  // Join inline text (including emphasized words), but keep paragraphs apart.
  function flush() {
    let span = 0;
    for (const match of text.matchAll(pattern)) {
      const begin = match.index;
      const end = begin + match[0].length;
      while (spans[span].end <= begin) span++;
      const range = doc.createRange();
      range.setStart(spans[span].node, begin - spans[span].start);
      while (spans[span].end < end) span++;
      range.setEnd(spans[span].node, end - spans[span].start);
      matches.push(range);
    }
    text = "";
    spans = [];
  }
  function visit(node) {
    if (node.nodeType === 3) {
      if (node.length) {
        spans.push({ node, start: text.length, end: text.length + node.length });
        text += node.data;
      }
      return;
    }
    if (node.nodeType !== 1 || node.matches("script, style, template, noscript, [aria-hidden=true]")) return;
    const style = win.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return;
    const boundary = node.tagName === "BR" || !["contents", "inline"].includes(style.display);
    if (boundary) flush();
    for (const child of node.childNodes) visit(child);
    if (boundary) flush();
  }
  visit(root);
  flush();
  const count = matches.length;
  if (!count) return { count, current: 0 };
  const position = ((index % count) + count) % count;
  const range = matches[position];
  if (highlights) {
    if (!doc.querySelector("style[data-folio-find]")) {
      const sheet = doc.createElement("style");
      sheet.dataset.folioFind = "";
      sheet.textContent = "::highlight(folio-reader-match){background:#ffcf57;color:#201800}";
      doc.head.append(sheet);
    }
    highlights.set(name, new win.Highlight(range));
  } else {
    const selection = win.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    selectedMatches.set(doc, range);
  }
  const element = range.startContainer.parentElement;
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  // A paragraph or code block may itself be taller than the viewport.
  for (let parent = element; parent; parent = parent.parentElement) {
    if (parent !== doc.scrollingElement && !/auto|scroll/.test(win.getComputedStyle(parent).overflowY)) continue;
    const rect = range.getBoundingClientRect();
    const top = parent === doc.scrollingElement ? 0 : parent.getBoundingClientRect().top;
    if (rect.top < top || rect.bottom > top + parent.clientHeight) {
      parent.scrollTop += rect.top - top - parent.clientHeight / 2;
    }
  }
  return { count, current: position + 1 };
}
