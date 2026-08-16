// Write view's image widgets. A line that is exactly one Markdown image is
// replaced by the image itself: drag its corner handle to resize, use the
// hover toolbar to align it, add a caption, or reveal the underlying Markdown
// line for manual editing. Every control edits the document text, so the file
// stays the single source of truth.

import {
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import type { Line } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { imageLineText, parseImageLine } from "@/app/editor-utils.js";

type ImageAlign = "left" | "center" | "right";

type ParsedImageLine = {
  indent: string;
  alt: string;
  src: string;
  width?: number;
  align?: ImageAlign;
  caption: string;
};

export type ImageWidgetContext = {
  /** Resolves a Markdown src to a displayable URL (sync for direct sources). */
  resolveSrc: (src: string) => string | Promise<string>;
};

function parseImage(text: string): ParsedImageLine | undefined {
  return parseImageLine(text) as ParsedImageLine | undefined;
}

/**
 * A set of line-start positions, toggled by an effect and remapped across
 * edits. Stale positions are harmless: they are only consulted for lines that
 * still parse as images.
 */
function lineFlagField() {
  const toggle = StateEffect.define<{ pos: number; on: boolean }>({
    map: (value, changes) => ({ ...value, pos: changes.mapPos(value.pos) }),
  });
  const field = StateField.define<readonly number[]>({
    create: () => [],
    update(value, transaction) {
      let next = transaction.docChanged
        ? value.map((pos) => transaction.changes.mapPos(pos))
        : value;
      for (const effect of transaction.effects) {
        if (!effect.is(toggle)) continue;
        next = next.filter((pos) => pos !== effect.value.pos);
        if (effect.value.on) next = [...next, effect.value.pos];
      }
      return next;
    },
  });
  return { toggle, field };
}

/** Image lines whose Markdown is shown for manual editing. */
const codeShown = lineFlagField();
/** Image lines showing an empty caption box that has not been committed yet. */
const captionOpen = lineFlagField();

/**
 * The line start of the image the user last clicked, or null. Tracked
 * explicitly rather than derived from the cursor: the widget covers an atomic
 * range, so the cursor cannot reliably rest on the line it belongs to.
 */
const selectImage = StateEffect.define<number | null>();
const selectedImage = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(selectImage)) return effect.value;
    }
    if (value === null || transaction.docChanged) return null;
    // Only a deliberate cursor move deselects. Focusing the editor also
    // dispatches a selection transaction, but an incidental DOM sync like
    // that carries no user event and must not clear the selection.
    if (
      transaction.selection &&
      (transaction.isUserEvent("select") || transaction.isUserEvent("input"))
    ) {
      return null;
    }
    return value;
  },
});

const ALIGN_ICONS: Record<ImageAlign, string> = {
  left: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="8" height="7" rx="1"/><rect x="2" y="12" width="12" height="1.6" rx="0.8"/></svg>',
  center:
    '<svg viewBox="0 0 16 16"><rect x="4" y="3" width="8" height="7" rx="1"/><rect x="2" y="12" width="12" height="1.6" rx="0.8"/></svg>',
  right:
    '<svg viewBox="0 0 16 16"><rect x="6" y="3" width="8" height="7" rx="1"/><rect x="2" y="12" width="12" height="1.6" rx="0.8"/></svg>',
};

const CAPTION_ICON =
  '<svg viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="6.6" width="8" height="1.4" rx="0.7"/><rect x="4" y="9.4" width="5" height="1.4" rx="0.7"/></svg>';

const CODE_ICON =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4.5 2 8l3.5 3.5"/><path d="M10.5 4.5 14 8l-3.5 3.5"/></svg>';

type WidgetFlags = {
  expanded: boolean;
  captioning: boolean;
  selected: boolean;
};

class ImageWidget extends WidgetType {
  constructor(
    private readonly image: ParsedImageLine,
    private readonly flags: WidgetFlags,
    private readonly context: ImageWidgetContext,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      other.image.src === this.image.src &&
      other.image.alt === this.image.alt &&
      other.image.width === this.image.width &&
      other.image.align === this.image.align &&
      other.image.caption === this.image.caption &&
      other.flags.expanded === this.flags.expanded &&
      other.flags.captioning === this.flags.captioning &&
      other.flags.selected === this.flags.selected
    );
  }

  ignoreEvent(): boolean {
    return true;
  }

  /** The document line this widget currently renders. */
  private lineAt(view: EditorView, dom: HTMLElement): Line | undefined {
    try {
      return view.state.doc.lineAt(view.posAtDOM(dom));
    } catch {
      return undefined;
    }
  }

  /**
   * Rewrites this widget's image line. The line is located through the DOM at
   * interaction time because CodeMirror reuses widget DOM across rebuilds,
   * which would leave a position captured at build time stale.
   */
  private editLine(
    view: EditorView,
    dom: HTMLElement,
    change: (image: ParsedImageLine) => ParsedImageLine,
  ) {
    const line = this.lineAt(view, dom);
    if (!line) return;
    const parsed = parseImage(line.text);
    if (!parsed) return;
    const nextText = imageLineText(change(parsed));
    // One transaction, and it always selects: using a control keeps the image
    // selected even when the edit is a no-op, such as re-picking the alignment
    // it already has. The line start does not move when only the line's own
    // text is replaced.
    view.dispatch({
      changes:
        nextText === line.text
          ? undefined
          : { from: line.from, to: line.to, insert: nextText },
      effects: selectImage.of(line.from),
    });
  }

  private buildCaption(view: EditorView, widget: HTMLElement): HTMLElement {
    const input = document.createElement("input");
    input.className = "cm-image-caption";
    input.type = "text";
    input.value = this.image.caption;
    input.placeholder = "Write a caption…";
    input.setAttribute("aria-label", "Image caption");

    const commit = () => {
      const value = input.value.trim();
      if (value === this.image.caption) return;
      this.editLine(view, widget, (image) => ({ ...image, caption: value }));
    };

    // Committing only on blur or Enter keeps the widget from being rebuilt
    // mid-word, which would drop focus on every keystroke.
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        input.value = this.image.caption;
        input.blur();
      }
    });
    input.addEventListener("blur", () => {
      commit();
      if (!input.value.trim()) {
        const line = this.lineAt(view, widget);
        if (line) {
          view.dispatch({
            effects: captionOpen.toggle.of({ pos: line.from, on: false }),
          });
        }
      }
    });

    // A caption box opened with no text is waiting to be typed into. Focus
    // has to wait for this DOM to be mounted, and must happen here rather
    // than at the click site, whose widget element is already discarded.
    if (this.flags.captioning && !this.image.caption) {
      window.requestAnimationFrame(() => {
        if (input.isConnected) input.focus();
      });
    }
    return input;
  }

  toDOM(view: EditorView): HTMLElement {
    const widget = document.createElement("div");
    widget.className = "cm-image-widget";
    if (this.flags.expanded) widget.classList.add("cm-image-widget-expanded");
    if (this.flags.selected) widget.classList.add("cm-image-selected");
    widget.dataset.align = this.image.align ?? "left";
    widget.contentEditable = "false";

    const frame = document.createElement("div");
    frame.className = "cm-image-frame";
    if (this.image.width) frame.style.width = `${this.image.width}px`;
    widget.appendChild(frame);

    const shell = document.createElement("div");
    shell.className = "cm-image-shell";
    frame.appendChild(shell);

    const img = document.createElement("img");
    img.alt = this.image.alt;
    img.draggable = false;
    shell.appendChild(img);

    const resolved = this.context.resolveSrc(this.image.src);
    if (typeof resolved === "string") {
      img.src = resolved;
    } else {
      shell.classList.add("cm-image-loading");
      resolved
        .then((url) => {
          img.src = url;
          shell.classList.remove("cm-image-loading");
        })
        .catch(() => {
          shell.classList.remove("cm-image-loading");
          shell.classList.add("cm-image-missing");
          const missing = document.createElement("span");
          missing.textContent = `Missing image: ${this.image.src}`;
          shell.appendChild(missing);
        });
    }

    // Clicking the image puts the cursor on its line, which both shows the
    // selection outline and lets Backspace remove the whole image.
    shell.addEventListener("mousedown", (event) => {
      if ((event.target as HTMLElement).closest("button, .cm-image-resize")) {
        return;
      }
      const line = this.lineAt(view, widget);
      if (!line) return;
      // Selecting without moving the cursor: the widget's range is atomic, so
      // a cursor placed here would be pushed off the line anyway.
      event.preventDefault();
      view.dispatch({ effects: selectImage.of(line.from) });
      view.focus();
    });

    const actions = document.createElement("div");
    actions.className = "cm-image-actions";
    shell.appendChild(actions);

    for (const align of ["left", "center", "right"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.innerHTML = ALIGN_ICONS[align];
      button.title = `Align ${align}`;
      button.setAttribute("aria-label", `Align ${align}`);
      button.setAttribute(
        "aria-pressed",
        String((this.image.align ?? "left") === align),
      );
      button.addEventListener("click", () => {
        this.editLine(view, widget, (image) => ({
          ...image,
          align: align === "left" ? undefined : align,
        }));
      });
      actions.appendChild(button);
    }

    const captionButton = document.createElement("button");
    captionButton.type = "button";
    captionButton.className = "cm-image-caption-toggle";
    captionButton.innerHTML = CAPTION_ICON;
    const hasCaption = Boolean(this.image.caption) || this.flags.captioning;
    captionButton.title = hasCaption ? "Remove caption" : "Add a caption";
    captionButton.setAttribute("aria-label", captionButton.title);
    captionButton.setAttribute("aria-pressed", String(hasCaption));
    captionButton.addEventListener("click", () => {
      const line = this.lineAt(view, widget);
      if (!line) return;
      if (hasCaption) {
        view.dispatch({
          effects: [
            captionOpen.toggle.of({ pos: line.from, on: false }),
            selectImage.of(line.from),
          ],
        });
        this.editLine(view, widget, (image) => ({ ...image, caption: "" }));
        return;
      }
      // The rebuilt widget focuses its own input once mounted.
      view.dispatch({
        effects: [
          captionOpen.toggle.of({ pos: line.from, on: true }),
          selectImage.of(line.from),
        ],
      });
    });
    actions.appendChild(captionButton);

    const code = document.createElement("button");
    code.type = "button";
    code.className = "cm-image-code-toggle";
    code.innerHTML = CODE_ICON;
    code.title = this.flags.expanded ? "Hide Markdown" : "Edit Markdown";
    code.setAttribute("aria-label", code.title);
    code.setAttribute("aria-pressed", String(this.flags.expanded));
    code.addEventListener("click", () => {
      const line = this.lineAt(view, widget);
      if (!line) return;
      view.dispatch({
        effects: codeShown.toggle.of({
          pos: line.from,
          on: !this.flags.expanded,
        }),
        // Put the cursor on the revealed Markdown so typing edits it.
        selection: this.flags.expanded ? undefined : { anchor: line.to },
      });
    });
    actions.appendChild(code);

    const handle = document.createElement("div");
    handle.className = "cm-image-resize";
    handle.title = "Drag to resize · double-click for natural size";
    shell.appendChild(handle);

    handle.addEventListener("dblclick", () => {
      this.editLine(view, widget, (image) => ({ ...image, width: undefined }));
    });

    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = frame.getBoundingClientRect().width;
      const maxWidth = widget.getBoundingClientRect().width;
      // The handle sits on the image's free corner, so cursor travel maps to
      // edge travel: 1:1 when one edge is pinned, doubled when centered
      // (both edges move), mirrored when the right edge is the pinned one.
      const factor =
        this.image.align === "center" ? 2 : this.image.align === "right" ? -1 : 1;
      let width = startWidth;
      widget.classList.add("cm-image-resizing");
      const move = (moveEvent: PointerEvent) => {
        width = Math.round(
          Math.min(
            maxWidth,
            Math.max(48, startWidth + (moveEvent.clientX - startX) * factor),
          ),
        );
        frame.style.width = `${width}px`;
      };
      const finish = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        widget.classList.remove("cm-image-resizing");
        this.editLine(view, widget, (image) => ({ ...image, width }));
      };
      handle.setPointerCapture(event.pointerId);
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    });

    if (hasCaption) frame.appendChild(this.buildCaption(view, widget));

    return widget;
  }
}

function imageDecorations(
  state: EditorState,
  context: ImageWidgetContext,
): DecorationSet {
  const expandedLines = state.field(codeShown.field);
  const captioningLines = state.field(captionOpen.field);
  const selected = state.field(selectedImage);
  const builder = new RangeSetBuilder<Decoration>();

  for (let number = 1; number <= state.doc.lines; number += 1) {
    const line = state.doc.line(number);
    if (!line.text.includes("![")) continue;
    const parsed = parseImage(line.text);
    if (!parsed) continue;

    const expanded = expandedLines.includes(line.from);
    const flags: WidgetFlags = {
      expanded,
      captioning: captioningLines.includes(line.from),
      selected: !expanded && selected === line.from,
    };

    if (expanded) {
      // Preview above the line; the Markdown itself stays editable text.
      builder.add(
        line.from,
        line.from,
        Decoration.widget({
          widget: new ImageWidget(parsed, flags, context),
          block: true,
          side: -1,
        }),
      );
    } else {
      builder.add(
        line.from,
        line.to,
        Decoration.replace({
          widget: new ImageWidget(parsed, flags, context),
          block: true,
        }),
      );
    }
  }
  return builder.finish();
}

/** The range to remove so a line disappears along with its line break. */
function lineRemoval(state: EditorState, line: Line) {
  if (line.to < state.doc.length) return { from: line.from, to: line.to + 1 };
  if (line.from > 0) return { from: line.from - 1, to: line.to };
  return { from: line.from, to: line.to };
}

/**
 * Backspace and Delete remove a collapsed image outright. Without this the
 * keypress would eat one character of the hidden Markdown, breaking the image
 * syntax and leaving the raw text behind.
 */
function deleteImageLine(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  const expandedLines = state.field(codeShown.field);
  const isCollapsedImage = (line: Line) =>
    !expandedLines.includes(line.from) && Boolean(parseImage(line.text));

  const remove = (line: Line) => {
    view.dispatch({
      changes: lineRemoval(state, line),
      scrollIntoView: true,
      userEvent: "delete.image",
    });
    return true;
  };

  // A clicked image is deleted outright, wherever the text cursor happens to
  // be — this is the path the resize/align controls leave the user on.
  const selected = state.field(selectedImage);
  if (selected !== null && selected <= state.doc.length) {
    const line = state.doc.lineAt(selected);
    if (line.from === selected && isCollapsedImage(line)) return remove(line);
  }

  const selection = state.selection.main;
  if (!selection.empty) {
    const line = state.doc.lineAt(selection.from);
    if (
      selection.from <= line.from &&
      selection.to >= line.to &&
      selection.to <= line.to &&
      isCollapsedImage(line)
    ) {
      return remove(line);
    }
    return false;
  }

  const line = state.doc.lineAt(selection.head);
  if (isCollapsedImage(line)) return remove(line);

  // The cursor usually rests just outside the widget, so also look across the
  // boundary in the direction of travel.
  if (!forward && selection.head === line.from && line.number > 1) {
    const previous = state.doc.line(line.number - 1);
    if (isCollapsedImage(previous)) return remove(previous);
  }
  if (forward && selection.head === line.to && line.number < state.doc.lines) {
    const next = state.doc.line(line.number + 1);
    if (isCollapsedImage(next)) return remove(next);
  }
  return false;
}

/** The Write view extension bundle for inline image widgets. */
export function editorImages(context: ImageWidgetContext) {
  const decorations = StateField.define<DecorationSet>({
    create: (state) => imageDecorations(state, context),
    update: (value, transaction) =>
      transaction.docChanged ||
      transaction.selection ||
      transaction.effects.some(
        (effect) =>
          effect.is(codeShown.toggle) ||
          effect.is(captionOpen.toggle) ||
          effect.is(selectImage),
      )
        ? imageDecorations(transaction.state, context)
        : value,
    provide: (field) => [
      EditorView.decorations.from(field),
      // Keeps the cursor from landing inside the hidden Markdown.
      EditorView.atomicRanges.of((view) => view.state.field(field)),
    ],
  });

  return [
    codeShown.field,
    captionOpen.field,
    selectedImage,
    decorations,
    Prec.high(
      keymap.of([
        { key: "Backspace", run: (view) => deleteImageLine(view, false) },
        { key: "Delete", run: (view) => deleteImageLine(view, true) },
      ]),
    ),
  ];
}
