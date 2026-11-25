import { useEffect, useRef, useState } from "react";
import type { PythonPlotlyFigure } from "@/app/python-runtime";

type PlotlyFigureProps = { figure: PythonPlotlyFigure; index: number };

export function PlotlyFigure({ figure, index }: PlotlyFigureProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ figure: PythonPlotlyFigure; error?: string }>();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Every render owns its node, including while a previous render finishes.
    const plot = document.createElement("div");
    container.appendChild(plot);
    let disposed = false;
    let ready = false;
    let frame = 0;
    let api: typeof import("plotly.js") | undefined;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (ready && !disposed && plot.clientWidth > 0) {
          void Promise.resolve(api?.Plots.resize(plot)).catch(() => undefined);
        }
      });
    });
    observer.observe(container);
    void (async () => {
      try {
        api = (await import("plotly.js-strict-dist-min")).default;
        if (disposed) return;
        // Plotly mutates its inputs; keep the worker result immutable.
        const spec = structuredClone(figure);
        await api.newPlot(plot, spec.data, spec.layout, {
          responsive: true,
          displaylogo: false,
          ...spec.config,
        });
        if (!disposed && spec.frames?.length) await api.addFrames(plot, spec.frames);
        ready = true;
        if (!disposed) setStatus({ figure });
      } catch (error) {
        if (!disposed) {
          setStatus({ figure, error: error instanceof Error ? error.message : String(error) });
        }
        api?.purge(plot);
      } finally {
        if (disposed) api?.purge(plot);
      }
    })();
    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (ready) api?.purge(plot);
      plot.remove();
    };
  }, [figure]);

  const current = status?.figure === figure ? status : undefined;
  return (
    <figure className="python-block-plotly" aria-label={`Interactive Python figure ${index + 1}`}>
      {!current && <span role="status">Loading chart…</span>}
      {current?.error && (
        <pre className="python-block-error">Could not render chart: {current.error}</pre>
      )}
      <div ref={containerRef} />
    </figure>
  );
}
