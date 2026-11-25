import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { IS_APPLE_PLATFORM } from "./editor-utils.js";
import { findReaderMatch } from "./reader-matches.js";

export function ReaderFind({ body, content, blocked }: {
  body: RefObject<HTMLDivElement | null>;
  content: string;
  blocked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [result, setResult] = useState({ current: 0, count: 0 });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (blocked || event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".cm-editor, .shortcut-recorder")) return;
      if (event.key === "Escape" && open) {
        setOpen(false);
        return;
      }
      if (event.key.toLowerCase() !== "f" || event.shiftKey || event.altKey ||
          !(IS_APPLE_PLATFORM ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      setOpen(true);
      input.current?.focus();
      input.current?.select();
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [open, blocked]);

  useEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open]);

  useEffect(() => {
    const root = body.current;
    if (!root || !open) return;
    const getFrame = () => root.querySelector<HTMLIFrameElement>("iframe.html-page-frame");
    function update(value: string, closing = false) {
      const frame = getFrame();
      if (frame?.sandbox.contains("allow-scripts")) {
        frame?.contentWindow?.postMessage({ folio: 1, type: "find", query: value, index }, "*");
      } else {
        const target = frame ? frame.contentDocument?.body : root;
        if (target) {
          const match = findReaderMatch(target, value, index);
          if (!closing) setResult(match);
        }
      }
    }
    function receive(event: MessageEvent) {
      const data = event.data;
      const frame = getFrame();
      if (frame?.sandbox.contains("allow-scripts") && event.source === frame?.contentWindow && data?.folio === 1 &&
          data.type === "findResult" && data.query === query && data.index === index &&
          Number.isSafeInteger(data.count) && Number.isSafeInteger(data.current)) {
        setResult({ count: data.count, current: data.current });
      }
    }
    const refresh = () => update(query);
    // The live frame initially renders a placeholder while the note is staged.
    const observer = new MutationObserver(refresh);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    window.addEventListener("message", receive);
    root.addEventListener("load", refresh, true);
    refresh();
    return () => {
      observer.disconnect();
      root.removeEventListener("load", refresh, true);
      window.removeEventListener("message", receive);
      update("", true);
    };
  }, [body, open, query, index, content]);

  if (!open) return null;
  const step = (delta: number) => setIndex((previous) => previous + delta);
  return (
    <div className="reader-find" role="search" aria-label="Find in page">
      <input ref={input} aria-label="Find in page" placeholder="Find in page"
        value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }} />
      <span role="status">{query && (result.count ? `${result.current} of ${result.count}` : "No matches")}</span>
      <button aria-label="Previous match" disabled={!result.count} onClick={() => step(-1)}><ChevronUp size={16} /></button>
      <button aria-label="Next match" disabled={!result.count} onClick={() => step(1)}><ChevronDown size={16} /></button>
      <button aria-label="Close find" onClick={() => setOpen(false)}><X size={16} /></button>
    </div>
  );
}
