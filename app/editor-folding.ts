// Collapsible code fences in Write view, mirroring the Code toggle a runnable
// block gets in Read view. Folding is deliberately limited to fenced code:
// Markdown's own fold ranges also cover headings, and collapsing whole
// sections of prose is not what a writing pane wants.

import {
  codeFolding,
  foldEffect,
  foldedRanges,
  syntaxTree,
  unfoldEffect,
} from "@codemirror/language";
import type { EditorState, Line } from "@codemirror/state";
import { EditorView, gutter, GutterMarker } from "@codemirror/view";

type FoldRange = { from: number; to: number };

/**
 * The range a fence opening on this line would collapse: everything after the
 * opening line through the closing fence, so one summary line is left behind.
 * Returns undefined for any other line, or a fence with nothing inside it.
 */
function fenceFoldRange(state: EditorState, line: Line): FoldRange | undefined {
  let node = syntaxTree(state).resolveInner(line.from, 1);
  while (node && node.name !== "FencedCode") {
    if (!node.parent) return undefined;
    node = node.parent;
  }
  if (!node || node.from !== line.from) return undefined;
  // An unterminated fence runs to the end of the document; still foldable, as
  // long as it spans more than the opening line.
  if (state.doc.lineAt(node.to).number <= line.number) return undefined;
  return { from: line.to, to: node.to };
}

/** The folded range starting at `from`, if this fence is currently collapsed. */
function foldedAt(state: EditorState, from: number): FoldRange | undefined {
  let found: FoldRange | undefined;
  foldedRanges(state).between(from, from, (rangeFrom, rangeTo) => {
    if (rangeFrom === from) {
      found = { from: rangeFrom, to: rangeTo };
      return false;
    }
    return undefined;
  });
  return found;
}

function toggleFence(view: EditorView, line: Line) {
  const range = fenceFoldRange(view.state, line);
  if (!range) return false;
  const folded = foldedAt(view.state, range.from);
  view.dispatch({
    effects: folded ? unfoldEffect.of(folded) : foldEffect.of(range),
  });
  return true;
}

class FenceFoldMarker extends GutterMarker {
  constructor(private readonly folded: boolean) {
    super();
  }

  eq(other: FenceFoldMarker) {
    return other.folded === this.folded;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = `cm-fence-fold${this.folded ? " folded" : ""}`;
    marker.title = this.folded ? "Expand code block" : "Collapse code block";
    marker.setAttribute("aria-hidden", "true");
    // A caret that points down when open and right when collapsed.
    marker.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5 8 10.5 12 6.5"/></svg>';
    return marker;
  }
}

/**
 * Which fences are collapsed, per page. Kept outside React: it is ephemeral
 * view state that must outlive the editor being unmounted, and threading it
 * through a ref would mean handing ref-reading closures to a memo.
 */
const foldMemory = new Map<string, FoldRange[]>();

export function rememberedFolds(key: string): FoldRange[] {
  return foldMemory.get(key) ?? [];
}

export function rememberFolds(key: string) {
  return (ranges: FoldRange[]) => {
    foldMemory.set(key, ranges);
  };
}

/**
 * Re-applies remembered folds to a freshly created editor. Ranges that no
 * longer fit the document (edited elsewhere, or changed on disk) are dropped.
 */
export function restoreFolds(view: EditorView, ranges: FoldRange[]) {
  const length = view.state.doc.length;
  const usable = ranges.filter(
    (range) => range.from < range.to && range.to <= length,
  );
  if (usable.length) {
    view.dispatch({ effects: usable.map((range) => foldEffect.of(range)) });
  }
}

/** Write view's fence folding: a gutter caret plus a collapsed summary. */
export function editorFolding(remember?: (ranges: FoldRange[]) => void) {
  return [
    // Switching to Read view unmounts the editor, so folds are remembered per
    // page and restored on the way back rather than springing open.
    EditorView.updateListener.of((update) => {
      if (!remember) return;
      const changed = update.transactions.some((transaction) =>
        transaction.effects.some(
          (effect) => effect.is(foldEffect) || effect.is(unfoldEffect),
        ),
      );
      if (!changed && !update.docChanged) return;
      const ranges: FoldRange[] = [];
      foldedRanges(update.state).between(
        0,
        update.state.doc.length,
        (from, to) => {
          ranges.push({ from, to });
        },
      );
      remember(ranges);
    }),
    codeFolding({
      preparePlaceholder: (state, range) => {
        const first = state.doc.lineAt(range.from).number;
        const last = state.doc.lineAt(range.to).number;
        // The opening fence line stays visible, so it is not part of the count.
        return Math.max(1, last - first);
      },
      placeholderDOM: (view, onclick, prepared: number) => {
        const placeholder = document.createElement("span");
        placeholder.className = "cm-fence-placeholder";
        placeholder.textContent = `⋯ ${prepared} line${prepared === 1 ? "" : "s"}`;
        placeholder.title = "Expand code block";
        placeholder.setAttribute("role", "button");
        placeholder.setAttribute("tabindex", "0");
        placeholder.setAttribute("aria-label", `Expand ${prepared} hidden lines`);
        placeholder.addEventListener("click", onclick);
        placeholder.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onclick(event);
          }
        });
        return placeholder;
      },
    }),
    gutter({
      class: "cm-fence-fold-gutter",
      lineMarker: (view, blockInfo) => {
        const line = view.state.doc.lineAt(blockInfo.from);
        // Only the line that opens a fence carries a caret.
        if (line.from !== blockInfo.from) return null;
        const range = fenceFoldRange(view.state, line);
        if (!range) return null;
        return new FenceFoldMarker(Boolean(foldedAt(view.state, range.from)));
      },
      // The tree changes what is foldable, so markers follow the viewport.
      lineMarkerChange: (update) => update.docChanged || update.viewportChanged,
      // No initialSpacer: the gutter has a fixed width, and a spacer would
      // leave a permanently hidden copy of the marker in the DOM.
      domEventHandlers: {
        mousedown: (view, blockInfo, event) => {
          event.preventDefault();
          return toggleFence(view, view.state.doc.lineAt(blockInfo.from));
        },
      },
    }),
    EditorView.baseTheme({
      ".cm-fence-fold-gutter": { width: "14px" },
    }),
  ];
}
