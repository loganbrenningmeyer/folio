const SHORTCUT_CODE_KEYS = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

const NAMED_SHORTCUT_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "Space",
]);

/**
 * @param {{ key: string; code: string }} event
 */
function shortcutKeyFromEvent(event) {
  if (/^(?:Alt|Control|Meta|Shift)$/.test(event.key)) return;
  if (event.code.startsWith("Key")) return event.code.slice(3).toLowerCase();
  if (event.code.startsWith("Digit")) return event.code.slice(5);
  if (event.code.startsWith("Numpad") && /^Numpad\d$/.test(event.code)) {
    return event.code.slice(-1);
  }
  if (SHORTCUT_CODE_KEYS[event.code]) return SHORTCUT_CODE_KEYS[event.code];
  if (event.key === " ") return "Space";
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) return event.key;
  if (NAMED_SHORTCUT_KEYS.has(event.key)) return event.key;
  if (event.key.length === 1) return event.key.toLowerCase();
}

/**
 * Use the physical key code for punctuation so Ctrl+Shift+Backslash records
 * `\\`, rather than the shifted `|` reported by KeyboardEvent.key.
 *
 * @param {{ key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }} event
 * @param {{ allowUnmodified?: boolean }} [options]
 */
export function shortcutFromEvent(event, options = {}) {
  const key = shortcutKeyFromEvent(event);
  const hasPrimaryModifier = event.ctrlKey || event.metaKey || event.altKey;
  const isCommandKey =
    NAMED_SHORTCUT_KEYS.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/.test(key ?? "");
  if (
    !key ||
    (!hasPrimaryModifier && (!options.allowUnmodified || !isCommandKey))
  ) {
    return;
  }
  return [
    event.ctrlKey && "Ctrl",
    event.metaKey && "Meta",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("-");
}

/** @param {string} shortcut */
function shortcutParts(shortcut) {
  /** @type {string[]} */
  const modifiers = [];
  let key = shortcut;
  while (true) {
    const match = key.match(/^(Ctrl|Meta|Alt|Shift)-/);
    if (!match) break;
    modifiers.push(match[1]);
    key = key.slice(match[0].length);
  }
  return { modifiers, key };
}

/** @param {string} shortcut */
export function isRecordedShortcut(shortcut) {
  const { modifiers, key } = shortcutParts(shortcut);
  const hasPrimaryModifier = modifiers.some((modifier) =>
    ["Ctrl", "Meta", "Alt"].includes(modifier),
  );
  const uniqueModifiers = new Set(modifiers).size === modifiers.length;
  const validKey =
    (key.length === 1 && key !== " ") ||
    NAMED_SHORTCUT_KEYS.has(key) ||
    /^F(?:[1-9]|1\d|2[0-4])$/.test(key);
  return hasPrimaryModifier && uniqueModifiers && validKey;
}

/**
 * App commands may also use bare or Shift-modified non-typing keys, such as
 * ArrowLeft or Shift-F2. Printable keys still require Ctrl, Command, or Alt.
 *
 * @param {string} shortcut
 */
export function isCommandShortcut(shortcut) {
  if (isRecordedShortcut(shortcut)) return true;
  const { modifiers, key } = shortcutParts(shortcut);
  const onlyShift = modifiers.every((modifier) => modifier === "Shift");
  const uniqueModifiers = new Set(modifiers).size === modifiers.length;
  const isCommandKey =
    NAMED_SHORTCUT_KEYS.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/.test(key);
  return onlyShift && uniqueModifiers && isCommandKey;
}

/**
 * Match recorded shortcuts exactly. In particular, Meta-ArrowLeft must never
 * fall through to a bare ArrowLeft binding (or vice versa).
 *
 * @param {string} binding
 * @param {string | undefined} pressedShortcut
 */
export function shortcutMatches(binding, pressedShortcut) {
  return Boolean(
    binding &&
      pressedShortcut &&
      binding.toLowerCase() === pressedShortcut.toLowerCase(),
  );
}

/**
 * Map a scroll position between two panes that share the same ordered source
 * anchors. Interpolating each interval independently keeps headings, lists,
 * code, and other differently-sized Markdown blocks aligned more accurately
 * than a single scroll-height percentage.
 *
 * @param {number} offset
 * @param {number[]} sourceOffsets
 * @param {number[]} targetOffsets
 */
export function mapScrollOffset(offset, sourceOffsets, targetOffsets) {
  const length = Math.min(sourceOffsets.length, targetOffsets.length);
  if (length === 0 || !Number.isFinite(offset)) return 0;
  if (length === 1) return Math.max(0, targetOffsets[0] ?? 0);

  const firstSource = sourceOffsets[0];
  const firstTarget = targetOffsets[0];
  if (offset <= firstSource) return Math.max(0, firstTarget);

  for (let index = 1; index < length; index += 1) {
    const sourceStart = sourceOffsets[index - 1];
    const sourceEnd = sourceOffsets[index];
    const targetStart = targetOffsets[index - 1];
    const targetEnd = targetOffsets[index];
    if (offset > sourceEnd && index < length - 1) continue;

    const sourceSpan = sourceEnd - sourceStart;
    if (sourceSpan <= 0) {
      if (offset <= sourceEnd) return Math.max(0, targetEnd);
      continue;
    }
    const progress = Math.min(1, Math.max(0, (offset - sourceStart) / sourceSpan));
    return Math.max(0, targetStart + (targetEnd - targetStart) * progress);
  }

  return Math.max(0, targetOffsets[length - 1]);
}

/**
 * How far the target pane's pace may be bent while absorbing the endpoint
 * disparity: spreading the drift over twice its own size keeps the pace
 * within half to one-and-a-half times natural, so the pane can never stall.
 */
const SCROLL_RAMP_HEADROOM = 2;

/**
 * Convert raw top-aligned anchor pairs into the map used for locked split
 * scrolling. Interior anchors keep exact top-edge alignment.
 *
 * Each pane's scroll range ends one viewport before its content does, and
 * those two final viewports rarely cover the same span of source lines, so
 * exact top alignment cannot also put both panes at their bottoms together.
 * The leftover disparity is absorbed by *scaling* the target pane's travel
 * across a trailing ramp rather than subtracting a fixed amount from it:
 * scaling by a positive factor can never flatten or reverse the pane's
 * motion, whereas subtracting can, which strands the reader against its
 * bottom while the source pane keeps moving. The ramp is widened until it
 * holds `SCROLL_RAMP_HEADROOM` times the drift, bounding the pace change.
 *
 * @param {{
 *   editorOffsets: number[];
 *   previewOffsets: number[];
 *   editorLimit: number;
 *   previewLimit: number;
 *   rampSpan: number;
 * }} anchors — `editorOffsets`/`previewOffsets` are strictly increasing
 * top-aligned pairs from (0, 0) to the content ends, which may lie beyond
 * the scroll limits.
 * @returns {{ editorOffsets: number[]; previewOffsets: number[] }}
 */
export function alignScrollAnchors({
  editorOffsets,
  previewOffsets,
  editorLimit,
  previewLimit,
  rampSpan,
}) {
  const editorMax = Math.max(0, editorLimit);
  const previewMax = Math.max(0, previewLimit);
  if (editorMax === 0 || previewMax === 0) {
    // One pane cannot scroll at all, so there is nothing to keep in step.
    return { editorOffsets: [0], previewOffsets: [0] };
  }

  const topAligned = (offset) =>
    mapScrollOffset(offset, editorOffsets, previewOffsets);
  const endPreview = topAligned(editorMax);
  const needed = Math.abs(previewMax - endPreview) * SCROLL_RAMP_HEADROOM;

  let rampStart = Math.max(0, editorMax - Math.max(1, rampSpan));
  if (endPreview - topAligned(rampStart) < needed) {
    // Widen the ramp (the mapping is monotonic, so bisect) until it spans
    // enough natural travel to absorb the drift gently.
    let low = 0;
    let high = rampStart;
    for (let step = 0; step < 32; step += 1) {
      const mid = (low + high) / 2;
      if (endPreview - topAligned(mid) >= needed) low = mid;
      else high = mid;
    }
    rampStart = low;
  }

  const startPreview = topAligned(rampStart);
  const naturalSpan = endPreview - startPreview;
  const targetSpan = previewMax - startPreview;
  const scale = naturalSpan > 0 && targetSpan > 0 ? targetSpan / naturalSpan : 0;

  const alignedEditor = [];
  const alignedPreview = [];
  const push = (editorOffset, previewOffset) => {
    const editorValue = Math.max(0, Math.min(editorOffset, editorMax));
    const previewValue = Math.max(0, Math.min(previewOffset, previewMax));
    const last = alignedEditor.length - 1;
    if (
      last >= 0 &&
      (editorValue <= alignedEditor[last] || previewValue <= alignedPreview[last])
    ) {
      return;
    }
    alignedEditor.push(editorValue);
    alignedPreview.push(previewValue);
  };

  push(0, 0);
  let rampStartInserted = rampStart <= 0;
  const length = Math.min(editorOffsets.length, previewOffsets.length);
  for (let index = 0; index < length; index += 1) {
    const editorOffset = editorOffsets[index];
    if (!rampStartInserted && editorOffset >= rampStart) {
      push(rampStart, startPreview);
      rampStartInserted = true;
    }
    if (editorOffset >= editorMax) break;
    push(
      editorOffset,
      editorOffset <= rampStart
        ? previewOffsets[index]
        : startPreview + (previewOffsets[index] - startPreview) * scale,
    );
  }
  if (!rampStartInserted) push(rampStart, startPreview);

  // Both panes bottom out on exactly the same scroll step.
  while (
    alignedEditor.length &&
    (alignedEditor[alignedEditor.length - 1] >= editorMax ||
      alignedPreview[alignedPreview.length - 1] >= previewMax)
  ) {
    alignedEditor.pop();
    alignedPreview.pop();
  }
  alignedEditor.push(editorMax);
  alignedPreview.push(previewMax);

  return { editorOffsets: alignedEditor, previewOffsets: alignedPreview };
}

/**
 * Report whether the start of the current line is already inside a fenced
 * code or display-math block. This prevents a hand-typed closing delimiter
 * from opening another pair.
 *
 * @param {string} text
 */
function hasOpenMarkdownBlock(text) {
  /** @type {{ character: string; length: number } | undefined} */
  let fence;
  /** @type {"$$" | "\\]" | undefined} */
  let mathCloser;

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (fence) {
      const closingFence = rawLine.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
      if (
        closingFence &&
        closingFence[1][0] === fence.character &&
        closingFence[1].length >= fence.length
      ) {
        fence = undefined;
      }
      continue;
    }

    if (mathCloser) {
      if (trimmed === mathCloser) mathCloser = undefined;
      continue;
    }

    const openingFence = rawLine.match(/^[ \t]*(`{3,}|~{3,})/);
    if (openingFence) {
      fence = {
        character: openingFence[1][0],
        length: openingFence[1].length,
      };
    } else if (trimmed === "$$") {
      mathCloser = "$$";
    } else if (trimmed === "\\[") {
      mathCloser = "\\]";
    }
  }

  return Boolean(fence || mathCloser);
}

/**
 * Find a standalone matching closer below the current line when every line
 * before it is blank. The returned offset excludes the closer's line break so
 * replacing through it preserves whatever follows the block.
 *
 * @param {string} documentText
 * @param {number} lineBreak
 * @param {"$" | "`"} character
 */
function matchingCloserEnd(documentText, lineBreak, character) {
  if (lineBreak < 0) return;
  let lineStart = lineBreak + 1;

  while (lineStart <= documentText.length) {
    const nextLineBreak = documentText.indexOf("\n", lineStart);
    const rawLineEnd =
      nextLineBreak < 0 ? documentText.length : nextLineBreak;
    const lineEnd =
      rawLineEnd > lineStart && documentText[rawLineEnd - 1] === "\r"
        ? rawLineEnd - 1
        : rawLineEnd;
    const line = documentText.slice(lineStart, lineEnd);

    if (line.trim()) {
      const matches =
        character === "$"
          ? /^[ \t]*\$\$[ \t]*$/.test(line)
          : /^[ \t]*`{3,}[ \t]*$/.test(line);
      return matches ? lineEnd : undefined;
    }
    if (nextLineBreak < 0) return;
    lineStart = nextLineBreak + 1;
  }
}

/**
 * Pair inline Markdown delimiters and promote standalone paired runs into
 * display blocks. `anchor` is the cursor position after the edit; `from` and
 * `to` may consume generated pairs or normalize a closer that already exists.
 *
 * @param {string} documentText
 * @param {number} from
 * @param {number} to
 * @param {string} text
 * @returns {{ from: number; to: number; insert: string; anchor: number } | undefined}
 */
export function markdownBlockCompletion(documentText, from, to, text) {
  if (
    from !== to ||
    from < 0 ||
    to > documentText.length ||
    (text !== "$" && text !== "`")
  ) {
    return;
  }

  const lineStart =
    from === 0 ? 0 : documentText.lastIndexOf("\n", from - 1) + 1;
  const nextLineBreak = documentText.indexOf("\n", to);
  const rawLineEnd =
    nextLineBreak < 0 ? documentText.length : nextLineBreak;
  const lineEnd =
    rawLineEnd > lineStart && documentText[rawLineEnd - 1] === "\r"
      ? rawLineEnd - 1
      : rawLineEnd;

  let escapeCount = 0;
  for (
    let index = from - 1;
    index >= lineStart && documentText[index] === "\\";
    index -= 1
  ) {
    escapeCount += 1;
  }
  if (
    escapeCount % 2 === 1 ||
    hasOpenMarkdownBlock(documentText.slice(0, lineStart))
  ) {
    return;
  }

  let leftRun = 0;
  while (
    from - leftRun - 1 >= lineStart &&
    documentText[from - leftRun - 1] === text
  ) {
    leftRun += 1;
  }
  let rightRun = 0;
  while (to + rightRun < lineEnd && documentText[to + rightRun] === text) {
    rightRun += 1;
  }

  const leftPrefix = documentText.slice(lineStart, from - leftRun);
  const rightSuffix = documentText.slice(to + rightRun, lineEnd);
  const standalone =
    /^[ \t]*$/.test(leftPrefix) && /^[ \t]*$/.test(rightSuffix);
  const promotionRun = text === "$" ? 1 : 2;
  const promoteGeneratedPair =
    standalone && leftRun === promotionRun && rightRun === promotionRun;
  const promoteLegacyRun =
    standalone && leftRun === promotionRun && rightRun === 0;

  if (promoteGeneratedPair || promoteLegacyRun) {
    const marker = text === "$" ? "$$" : "```";
    const indent = leftPrefix;
    const eol =
      nextLineBreak >= 1 && documentText[nextLineBreak - 1] === "\r"
        ? "\r\n"
        : documentText.includes("\r\n")
          ? "\r\n"
          : "\n";
    const changeFrom = from - leftRun;
    const existingCloserEnd = matchingCloserEnd(
      documentText,
      nextLineBreak,
      text,
    );
    const insert = `${marker}${eol}${indent}${eol}${indent}${marker}`;

    return {
      from: changeFrom,
      to: existingCloserEnd ?? lineEnd,
      insert,
      anchor: changeFrom + marker.length + eol.length + indent.length,
    };
  }

  // A second backtick inside the first empty generated pair builds the two
  // centered pairs that the third keypress promotes into a fenced block.
  if (text === "`" && standalone && leftRun === 1 && rightRun === 1) {
    return { from, to, insert: "``", anchor: from + 1 };
  }

  // Overtype generated inline closers once content has been entered.
  if (rightRun > 0) {
    return { from, to, insert: "", anchor: from + 1 };
  }

  // Adjacent raw runs are left to CodeMirror so pasted or manually entered
  // delimiter sequences remain editable without surprising extra pairs.
  if (leftRun > 0) return;

  return { from, to, insert: `${text}${text}`, anchor: from + 1 };
}

/** @param {string} shortcut */
export function formatShortcut(shortcut) {
  if (!shortcut) return "Press shortcut";
  const { modifiers, key } = shortcutParts(shortcut);
  return [...modifiers.map((modifier) => (modifier === "Meta" ? "⌘" : modifier)), key]
    .join(" + ");
}

/**
 * Convert the compact `$1`/`$0` syntax shown in Folio's preferences to
 * CodeMirror's `${1}`/`${0}` syntax. An omitted final stop is added at the end.
 *
 * @param {string} template
 */
export function toCodeMirrorSnippet(template) {
  let hasNumberedStop = false;
  let hasFinalStop = false;
  const converted = template.replace(
    /(\\)?\$(\d{1,2})(?!\d)/g,
    (_match, escaped, rawIndex) => {
      if (escaped) return `$${rawIndex}`;
      const index = Number(rawIndex);
      if (index === 0) hasFinalStop = true;
      else hasNumberedStop = true;
      return `\${${rawIndex}}`;
    },
  );

  if (/\$\{0(?::[^}]*)?\}/.test(converted)) hasFinalStop = true;
  if (/\$\{[1-9]\d*(?::[^}]*)?\}/.test(converted)) hasNumberedStop = true;
  return hasNumberedStop && !hasFinalStop ? `${converted}\${0}` : converted;
}

/**
 * @param {string} content
 * @param {string} query
 * @param {number} [limit]
 * @returns {{ line: number; text: string }[]}
 */
export function extractSearchExcerpts(content, query, limit = 3) {
  /** @type {{ line: number; text: string }[]} */
  const excerpts = [];
  const normalizedQuery = query.toLowerCase();
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length && excerpts.length < limit; index += 1) {
    const rawLine = lines[index].trim();
    const matchIndex = rawLine.toLowerCase().indexOf(normalizedQuery);
    if (matchIndex < 0) continue;

    const targetLength = Math.max(150, query.length + 24);
    let start = Math.max(0, matchIndex - Math.floor((targetLength - query.length) / 2));
    const end = Math.min(rawLine.length, start + targetLength);
    if (end === rawLine.length) start = Math.max(0, end - targetLength);
    const text = `${start > 0 ? "…" : ""}${rawLine.slice(start, end)}${
      end < rawLine.length ? "…" : ""
    }`;
    excerpts.push({ line: index + 1, text });
  }

  return excerpts;
}
