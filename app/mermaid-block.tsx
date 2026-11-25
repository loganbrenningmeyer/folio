import { useEffect, useState, type HTMLAttributes, type ReactNode } from "react";

let nextDiagramId = 0;
let renderQueue = Promise.resolve();

// Mermaid's configuration is global. Serialize configuration and rendering so
// multiple fences and theme changes cannot affect one another mid-render.
function renderDiagram(code: string, dark: boolean) {
  const result = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
    });
    return mermaid.render(`folio-mermaid-${++nextDiagramId}`, code);
  });
  renderQueue = result.then(() => undefined, () => undefined);
  return result;
}

type MermaidBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  children: ReactNode;
};

export function MermaidBlock({ code, children, ...props }: MermaidBlockProps) {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark",
  );
  const [rendered, setRendered] = useState<{
    code: string;
    dark: boolean;
    svg?: string;
    error?: string;
  }>();
  // Observe the theme locally so changing it doesn't replace the Markdown
  // component map and remount running Python blocks elsewhere on the page.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme === "dark");
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    const timer = window.setTimeout(() => {
      void renderDiagram(code, dark).then(
        ({ svg }) => {
          if (!disposed) setRendered({ code, dark, svg });
        },
        (error: unknown) => {
          if (!disposed) {
            setRendered({ code, dark, error: error instanceof Error ? error.message : String(error) });
          }
        },
      );
    }, 150);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [code, dark]);
  const current = rendered?.code === code && rendered.dark === dark ? rendered : undefined;
  return (
    <div {...props} className="mermaid-block">
      {!current && <span role="status">Rendering diagram…</span>}
      {current?.svg && (
        <div
          className="mermaid-diagram"
          role="img"
          aria-label="Mermaid diagram"
          dangerouslySetInnerHTML={{ __html: current.svg }}
        />
      )}
      {current?.error && (
        <pre className="mermaid-error" role="alert">Could not render diagram: {current.error}</pre>
      )}
      <details open={current?.error ? true : undefined}>
        <summary>Mermaid source</summary>
        <pre>{children}</pre>
      </details>
    </div>
  );
}
