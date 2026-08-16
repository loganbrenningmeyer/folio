"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Square,
  ZapOff,
} from "lucide-react";
import {
  resetPythonSession,
  runPythonBlock,
  setPythonWidget,
  stepPythonAnimation,
  stopPython,
  PythonStoppedError,
  type PythonAnimation,
  type PythonControl,
  type PythonControlValue,
  type PythonRunOutput,
  type PythonRunPhase,
  type PythonWidget,
  type PythonWidgetAction,
} from "@/app/python-runtime";

type HastNode = {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  // `mdast-util-to-hast` parks the fence info string here, and
  // `hast-util-sanitize` clones `data` through untouched.
  data?: { meta?: string };
  children?: HastNode[];
};

function hastText(node: HastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(hastText).join("");
}

function hastClassNames(node: HastNode): string[] {
  const className = node.properties?.className;
  if (Array.isArray(className)) return className.map(String);
  if (typeof className === "string") return className.split(/\s+/);
  return [];
}

export type PythonFence = { code: string; runnable: boolean };

// A python fence stays inert unless its info string opts in — ```python run.
// Other renderers read only the first word, so a shared file still highlights
// as Python everywhere else. Returns undefined for any other <pre>.
export function pythonFenceFromPre(node: unknown): PythonFence | undefined {
  const pre = node as HastNode | undefined;
  const code = pre?.children?.find((child) => child.tagName === "code");
  if (!code || !hastClassNames(code).includes("language-python")) {
    return undefined;
  }
  const meta = typeof code.data?.meta === "string" ? code.data.meta : "";
  return {
    code: hastText(code).replace(/\n$/, ""),
    runnable: /(^|\s)run(\s|$)/.test(meta),
  };
}

const PHASE_LABELS: Record<PythonRunPhase, string> = {
  runtime: "Loading Python…",
  packages: "Preparing packages…",
  running: "Running…",
};

// Printed output is capped so a runaway print loop cannot grow the page
// without bound; the run itself keeps going until stopped.
const MAX_STDOUT_LENGTH = 200_000;
const TRUNCATION_NOTICE = "\n… output truncated …";

// Animations self-pace to their matplotlib interval, but never faster than
// the worker can reasonably render frames.
const MIN_FRAME_INTERVAL = 33;

function formatControlNumber(value: number) {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

type SliderFieldProps = {
  label: string;
  detail?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
};

function SliderField({
  label,
  detail,
  min,
  max,
  step,
  value,
  disabled,
  onChange,
}: SliderFieldProps) {
  return (
    <label className="python-control" aria-label={label}>
      <span className="python-control-head">
        <span>{label}</span>
        <strong>{detail ?? formatControlNumber(value)}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

type ControlFieldProps = {
  control: PythonControl;
  value: PythonControlValue | undefined;
  onChange: (name: string, value: PythonControlValue) => void;
};

function PythonControlField({ control, value, onChange }: ControlFieldProps) {
  if (control.kind === "slider") {
    const current = typeof value === "number" ? value : control.value;
    return (
      <SliderField
        label={control.label}
        min={control.min}
        max={control.max}
        step={control.step}
        value={current}
        onChange={(next) => onChange(control.name, next)}
      />
    );
  }
  if (control.kind === "toggle") {
    const current = typeof value === "boolean" ? value : control.value;
    return (
      <label className="python-control python-control-toggle">
        <input
          type="checkbox"
          checked={current}
          onChange={(event) => onChange(control.name, event.target.checked)}
        />
        <span>{control.label}</span>
      </label>
    );
  }
  const current = typeof value === "string" ? value : control.value;
  return (
    <label className="python-control" aria-label={control.label}>
      <span className="python-control-head">
        <span>{control.label}</span>
      </span>
      <select
        value={current}
        onChange={(event) => onChange(control.name, event.target.value)}
      >
        {control.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

// The current UI value a live widget shows, taken from the block's optimistic
// value map when present and the widget's own spec otherwise.
function widgetSpecValue(widget: PythonWidget): unknown {
  switch (widget.kind) {
    case "slider":
    case "range-slider":
    case "radio-buttons":
    case "text-box":
      return widget.value;
    case "check-buttons":
      return widget.values;
    case "button":
      return undefined;
  }
}

type WidgetFieldProps = {
  widget: PythonWidget;
  value: unknown;
  disabled: boolean;
  onValue: (widgetId: string, value: unknown) => void;
  onAction: (widgetId: string, action: PythonWidgetAction, immediate?: boolean) => void;
};

function PythonWidgetField({
  widget,
  value,
  disabled,
  onValue,
  onAction,
}: WidgetFieldProps) {
  if (widget.kind === "slider") {
    const current = typeof value === "number" ? value : widget.value;
    return (
      <SliderField
        label={widget.label}
        min={widget.min}
        max={widget.max}
        step={widget.step}
        value={current}
        disabled={disabled}
        onChange={(next) => {
          onValue(widget.id, next);
          onAction(widget.id, { type: "set", value: next });
        }}
      />
    );
  }
  if (widget.kind === "range-slider") {
    const current = Array.isArray(value)
      ? (value as [number, number])
      : widget.value;
    const [low, high] = current;
    const change = (nextLow: number, nextHigh: number) => {
      const next: [number, number] = [
        Math.min(nextLow, nextHigh),
        Math.max(nextLow, nextHigh),
      ];
      onValue(widget.id, next);
      onAction(widget.id, { type: "set", value: next });
    };
    return (
      <div className="python-control python-control-range" aria-label={widget.label}>
        <span className="python-control-head">
          <span>{widget.label}</span>
          <strong>
            {formatControlNumber(low)} – {formatControlNumber(high)}
          </strong>
        </span>
        <input
          type="range"
          min={widget.min}
          max={widget.max}
          step={widget.step}
          value={low}
          disabled={disabled}
          aria-label={`${widget.label} lower bound`}
          onChange={(event) => change(Number(event.target.value), high)}
        />
        <input
          type="range"
          min={widget.min}
          max={widget.max}
          step={widget.step}
          value={high}
          disabled={disabled}
          aria-label={`${widget.label} upper bound`}
          onChange={(event) => change(low, Number(event.target.value))}
        />
      </div>
    );
  }
  if (widget.kind === "button") {
    return (
      <div className="python-control python-control-button">
        <button
          type="button"
          className="python-widget-button"
          disabled={disabled}
          onClick={() => onAction(widget.id, { type: "click" }, true)}
        >
          {widget.label}
        </button>
      </div>
    );
  }
  if (widget.kind === "check-buttons") {
    const current =
      Array.isArray(value) && value.length === widget.values.length
        ? (value as boolean[])
        : widget.values;
    return (
      <div className="python-control python-control-choices">
        {widget.labels.map((label, index) => (
          <label key={`${widget.id}-${label}`}>
            <input
              type="checkbox"
              checked={current[index]}
              disabled={disabled}
              onChange={() => {
                const next = [...current];
                next[index] = !next[index];
                onValue(widget.id, next);
                onAction(widget.id, { type: "toggle", index }, true);
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    );
  }
  if (widget.kind === "radio-buttons") {
    const current = typeof value === "number" ? value : widget.value;
    return (
      <div className="python-control python-control-choices">
        {widget.labels.map((label, index) => (
          <label key={`${widget.id}-${label}`}>
            <input
              type="radio"
              name={widget.id}
              checked={current === index}
              disabled={disabled}
              onChange={() => {
                onValue(widget.id, index);
                onAction(widget.id, { type: "select", index }, true);
              }}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    );
  }
  const current = typeof value === "string" ? value : widget.value;
  const commit = (next: string) =>
    onAction(widget.id, { type: "set", value: next }, true);
  return (
    <label className="python-control" aria-label={widget.label}>
      <span className="python-control-head">
        <span>{widget.label}</span>
      </span>
      <input
        type="text"
        className="python-control-textbox"
        value={current}
        disabled={disabled}
        onChange={(event) => onValue(widget.id, event.target.value)}
        onBlur={(event) => {
          if (event.target.value !== widget.value) commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget.value);
        }}
      />
    </label>
  );
}

type PendingWidgetAction = { widgetId: string; action: PythonWidgetAction };

type StaticPythonBlockProps = HTMLAttributes<HTMLPreElement> & {
  onEnableRun?: () => void;
  children: ReactNode;
};

// A plain python fence. The enable control rides along quietly until the
// block is hovered or focused, so reading is undisturbed.
export function StaticPythonBlock({
  onEnableRun,
  children,
  ...preProps
}: StaticPythonBlockProps) {
  return (
    <pre {...preProps} className="python-static">
      {onEnableRun && (
        <button
          type="button"
          className="python-static-enable"
          onClick={onEnableRun}
          title="Make this block runnable (adds `run` to the fence)"
        >
          <Play size={11} fill="currentColor" aria-hidden="true" />
          <span>Enable running</span>
        </button>
      )}
      {children}
    </pre>
  );
}

type PythonCodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  sessionId: string;
  onDisableRun?: () => void;
  children: ReactNode;
};

export function PythonCodeBlock({
  code,
  sessionId,
  onDisableRun,
  children,
  ...preProps
}: PythonCodeBlockProps) {
  const [output, setOutput] = useState<PythonRunOutput>();
  const [stdoutText, setStdoutText] = useState("");
  const [values, setValues] = useState<Record<string, PythonControlValue>>({});
  const [widgetValues, setWidgetValues] = useState<Record<string, unknown>>({});
  const [liveStale, setLiveStale] = useState(false);
  const [widgetError, setWidgetError] = useState<string>();
  const [animations, setAnimations] = useState<PythonAnimation[]>([]);
  const [animPlaying, setAnimPlaying] = useState(true);
  const [animDone, setAnimDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<PythonRunPhase>();
  const [lastRunCode, setLastRunCode] = useState<string>();
  const [codeVisible, setCodeVisible] = useState(false);

  const codeRef = useRef(code);
  const valuesRef = useRef(values);
  const busyRef = useRef(false);
  const queuedRef = useRef(false);
  const rerunTimerRef = useRef<number>(undefined);
  const widgetTimerRef = useRef<number>(undefined);
  const pendingActionsRef = useRef<PendingWidgetAction[]>([]);
  const widgetBusyRef = useRef(false);
  const sessionRef = useRef(sessionId);

  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  useEffect(
    () => () => {
      if (rerunTimerRef.current !== undefined) {
        window.clearTimeout(rerunTimerRef.current);
      }
      if (widgetTimerRef.current !== undefined) {
        window.clearTimeout(widgetTimerRef.current);
      }
    },
    [],
  );

  const clearOutputs = useCallback(() => {
    setOutput(undefined);
    setStdoutText("");
    setValues({});
    valuesRef.current = {};
    setWidgetValues({});
    setLiveStale(false);
    setWidgetError(undefined);
    setAnimations([]);
    setAnimPlaying(true);
    setAnimDone(false);
    pendingActionsRef.current = [];
    setLastRunCode(undefined);
  }, []);

  // Turning the page can leave this component mounted at the same tree
  // position, so outputs must not carry over to the next note's block.
  useEffect(() => {
    if (sessionRef.current === sessionId) return;
    sessionRef.current = sessionId;
    clearOutputs();
  }, [clearOutputs, sessionId]);

  const appendStdout = useCallback((text: string) => {
    setStdoutText((previous) => {
      if (previous.length > MAX_STDOUT_LENGTH) return previous;
      const next = `${previous}${text}\n`;
      return next.length > MAX_STDOUT_LENGTH
        ? next.slice(0, MAX_STDOUT_LENGTH) + TRUNCATION_NOTICE
        : next;
    });
  }, []);

  const applyFigureImage = useCallback((figure: number, image: string) => {
    setOutput((previous) => {
      if (!previous) return previous;
      const index = previous.figures.indexOf(figure);
      if (index < 0) return previous;
      const images = [...previous.images];
      images[index] = image;
      return { ...previous, images };
    });
  }, []);

  const run = useCallback(async () => {
    if (busyRef.current) {
      queuedRef.current = true;
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      do {
        queuedRef.current = false;
        const ranCode = codeRef.current;
        setStdoutText("");
        setWidgetError(undefined);
        setAnimations([]);
        const result = await runPythonBlock({
          sessionId,
          code: ranCode,
          values: valuesRef.current,
          onPhase: setPhase,
          onStdout: appendStdout,
        });
        // Adopt the controls' resolved values unless a knob moved mid-run;
        // the queued follow-up run will reconcile that newer input.
        if (!queuedRef.current) {
          const nextValues = Object.fromEntries(
            result.controls.map((control) => [control.name, control.value]),
          );
          valuesRef.current = nextValues;
          setValues(nextValues);
        }
        setOutput(result);
        setWidgetValues(
          Object.fromEntries(
            result.widgets.map((widget) => [widget.id, widgetSpecValue(widget)]),
          ),
        );
        setLiveStale(false);
        pendingActionsRef.current = [];
        setAnimations(result.animations);
        setAnimPlaying(true);
        setAnimDone(false);
        setLastRunCode(ranCode);
      } while (queuedRef.current);
    } catch (caught) {
      setOutput({
        images: [],
        figures: [],
        controls: [],
        widgets: [],
        animations: [],
        error: caught instanceof Error ? caught.message : String(caught),
      });
      setLastRunCode(codeRef.current);
    } finally {
      busyRef.current = false;
      setBusy(false);
      setPhase(undefined);
    }
  }, [appendStdout, sessionId]);

  const changeControl = useCallback(
    (name: string, value: PythonControlValue) => {
      const next = { ...valuesRef.current, [name]: value };
      valuesRef.current = next;
      setValues(next);
      if (rerunTimerRef.current !== undefined) {
        window.clearTimeout(rerunTimerRef.current);
      }
      rerunTimerRef.current = window.setTimeout(() => {
        rerunTimerRef.current = undefined;
        void run();
      }, 160);
    },
    [run],
  );

  // Live matplotlib widgets skip the re-run entirely: the worker drives the
  // widget's own callbacks on the still-open figure and only that figure's
  // image is refreshed.
  const flushWidgetActions = useCallback(async () => {
    if (widgetBusyRef.current) return;
    widgetBusyRef.current = true;
    try {
      while (pendingActionsRef.current.length > 0) {
        const { widgetId, action } = pendingActionsRef.current.shift() as PendingWidgetAction;
        const result = await setPythonWidget({
          widgetId,
          action,
          onStdout: appendStdout,
        });
        if (result.stale) {
          setLiveStale(true);
          pendingActionsRef.current = [];
          return;
        }
        setWidgetError(result.error ?? undefined);
        if (result.image !== undefined && result.figure !== undefined) {
          applyFigureImage(result.figure, result.image);
        }
        const spec = result.spec;
        if (spec) {
          setOutput((previous) =>
            previous
              ? {
                  ...previous,
                  widgets: previous.widgets.map((widget) =>
                    widget.id === spec.id ? spec : widget,
                  ),
                }
              : previous,
          );
          // Only resync the UI value once the reader is done interacting;
          // mid-drag the optimistic value is newer than the spec.
          if (!pendingActionsRef.current.some((entry) => entry.widgetId === spec.id)) {
            setWidgetValues((previous) => ({
              ...previous,
              [spec.id]: widgetSpecValue(spec),
            }));
          }
        }
      }
    } catch (caught) {
      if (caught instanceof PythonStoppedError) {
        setLiveStale(true);
      } else {
        setWidgetError(
          caught instanceof Error ? caught.message : String(caught),
        );
      }
      pendingActionsRef.current = [];
    } finally {
      widgetBusyRef.current = false;
    }
  }, [appendStdout, applyFigureImage]);

  const dispatchWidgetAction = useCallback(
    (widgetId: string, action: PythonWidgetAction, immediate = false) => {
      const pending = pendingActionsRef.current;
      if (action.type === "set") {
        // Coalesce drags: only the latest value per widget matters.
        pendingActionsRef.current = [
          ...pending.filter(
            (entry) =>
              !(entry.widgetId === widgetId && entry.action.type === "set"),
          ),
          { widgetId, action },
        ];
      } else {
        pending.push({ widgetId, action });
      }
      if (widgetTimerRef.current !== undefined) {
        window.clearTimeout(widgetTimerRef.current);
        widgetTimerRef.current = undefined;
      }
      if (immediate) {
        void flushWidgetActions();
        return;
      }
      widgetTimerRef.current = window.setTimeout(() => {
        widgetTimerRef.current = undefined;
        void flushWidgetActions();
      }, 60);
    },
    [flushWidgetActions],
  );

  const setWidgetValue = useCallback((widgetId: string, value: unknown) => {
    setWidgetValues((previous) => ({ ...previous, [widgetId]: value }));
  }, []);

  // Animation driver: pull one frame at a time from the worker, self-paced to
  // the animation's interval and paused while the tab is hidden. The loop
  // ends when the block re-runs, another run closes the figure (stale), the
  // animation finishes, or the reader pauses it.
  useEffect(() => {
    if (!animations.length || !animPlaying || animDone || liveStale) return;
    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    void (async () => {
      while (!cancelled) {
        const started = performance.now();
        for (const animation of animations) {
          if (cancelled) return;
          try {
            const frame = await stepPythonAnimation({
              animationId: animation.id,
              onStdout: appendStdout,
            });
            if (cancelled) return;
            if (frame.stale) {
              setLiveStale(true);
              return;
            }
            if (frame.image !== undefined && frame.figure !== undefined) {
              applyFigureImage(frame.figure, frame.image);
            }
            if (frame.error) {
              setWidgetError(frame.error);
              setAnimPlaying(false);
              return;
            }
            if (frame.done) {
              setAnimDone(true);
              return;
            }
          } catch (caught) {
            if (caught instanceof PythonStoppedError) setLiveStale(true);
            return;
          }
        }
        const interval = Math.max(
          MIN_FRAME_INTERVAL,
          Math.min(...animations.map((animation) => animation.interval)),
        );
        const elapsed = performance.now() - started;
        if (elapsed < interval) await sleep(interval - elapsed);
        while (!cancelled && document.hidden) await sleep(400);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [animations, animPlaying, animDone, liveStale, appendStdout, applyFigureImage]);

  const restart = useCallback(() => {
    resetPythonSession(sessionId);
    clearOutputs();
  }, [clearOutputs, sessionId]);

  const hasRun = lastRunCode !== undefined;
  const stale = hasRun && lastRunCode !== code;
  const controls = output?.controls ?? [];
  const widgets = output?.widgets ?? [];
  const hasConsole = Boolean(
    stdoutText ||
      widgetError ||
      (output &&
        (output.error ||
          output.resultRepr !== undefined ||
          output.images.length)),
  );

  return (
    <div {...preProps} className="python-block" aria-busy={busy}>
      <div className="python-block-bar">
        <button
          type="button"
          className="python-block-run"
          onClick={() => void run()}
          disabled={busy}
          aria-label="Run"
          title={busy ? "Running…" : hasRun ? "Run again" : "Run"}
        >
          {busy ? (
            <LoaderCircle
              size={13}
              className="python-block-spinner"
              aria-hidden="true"
            />
          ) : (
            <Play size={12} fill="currentColor" aria-hidden="true" />
          )}
        </button>
        {busy && (
          <button
            type="button"
            className="python-block-stop"
            onClick={stopPython}
            title="Stop execution"
            aria-label="Stop execution"
          >
            <Square size={10} fill="currentColor" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="python-block-toggle"
          onClick={() => setCodeVisible((visible) => !visible)}
          aria-expanded={codeVisible}
          aria-label={codeVisible ? "Hide code" : "Show code"}
          title={codeVisible ? "Hide code" : "Show code"}
        >
          {codeVisible ? (
            <ChevronDown size={13} aria-hidden="true" />
          ) : (
            <ChevronRight size={13} aria-hidden="true" />
          )}
          <span>Code</span>
        </button>
        {busy && phase ? (
          <span className="python-block-status" role="status">
            {PHASE_LABELS[phase]}
          </span>
        ) : (
          stale && <span className="python-block-stale">Edited — run again</span>
        )}
        <div className="python-block-bar-end">
          {hasRun && !busy && (
            <button
              type="button"
              className="python-block-restart"
              onClick={restart}
              title="Restart the Python session for this page"
              aria-label="Restart the Python session for this page"
            >
              <RotateCcw size={13} />
            </button>
          )}
          {onDisableRun && !busy && (
            <button
              type="button"
              className="python-block-disable"
              onClick={onDisableRun}
              title="Turn off running (removes `run` from the fence)"
              aria-label="Turn off running for this block"
            >
              <ZapOff size={13} />
            </button>
          )}
          <span className="python-block-lang">Python</span>
        </div>
      </div>
      {codeVisible && <pre className="python-block-code">{children}</pre>}
      {controls.length > 0 && (
        <div className="python-block-controls">
          {controls.map((control) => (
            <PythonControlField
              key={control.name}
              control={control}
              value={values[control.name]}
              onChange={changeControl}
            />
          ))}
        </div>
      )}
      {hasConsole && (
        <div className="python-block-output">
          {stdoutText && (
            <pre className="python-block-stdout">{stdoutText}</pre>
          )}
          {output?.images.map((image, index) => (
            <figure className="python-block-figure" key={index}>
              {/* Figures arrive as data URIs from the local interpreter, so
                  next/image optimization has nothing to fetch or cache. */}
              <img
                src={`data:image/png;base64,${image}`}
                alt={`Python figure ${index + 1}`}
              />
            </figure>
          ))}
          {animations.length > 0 && !animDone && (
            <div className="python-block-animbar">
              {liveStale ? (
                <span className="python-widgets-stale">
                  Animation disconnected — run again to restart it.
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setAnimPlaying((playing) => !playing)}
                  aria-label={animPlaying ? "Pause animation" : "Play animation"}
                  title={animPlaying ? "Pause animation" : "Play animation"}
                >
                  {animPlaying ? (
                    <Pause size={11} fill="currentColor" aria-hidden="true" />
                  ) : (
                    <Play size={11} fill="currentColor" aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
          )}
          {widgets.length > 0 && (
            <div className="python-block-controls python-block-widgets">
              {liveStale && (
                <span className="python-widgets-stale">
                  Controls disconnected — run again to reactivate them.
                </span>
              )}
              {widgets.map((widget) => (
                <PythonWidgetField
                  key={widget.id}
                  widget={widget}
                  value={widgetValues[widget.id]}
                  disabled={liveStale}
                  onValue={setWidgetValue}
                  onAction={dispatchWidgetAction}
                />
              ))}
            </div>
          )}
          {output?.resultRepr !== undefined && (
            <pre className="python-block-result">{output.resultRepr}</pre>
          )}
          {(output?.error || widgetError) && (
            <pre className="python-block-error">
              {output?.error ?? widgetError}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
