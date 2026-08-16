// Dedicated worker that hosts the Pyodide interpreter for Folio's runnable
// Python blocks. Execution lives here so a busy or runaway script never
// freezes the reader; the main thread can interrupt it (via a shared
// interrupt buffer when the page is cross-origin isolated) or simply
// terminate the worker. Messages are serialized by the main thread, so at
// most one operation runs at a time.

import type {
  PythonAnimation,
  PythonAnimationStep,
  PythonControl,
  PythonRunPhase,
  PythonWidget,
  PythonWidgetAction,
  PythonWidgetResult,
} from "@/app/python-runtime";

type RunMessage = {
  type: "run";
  id: number;
  sessionId: string;
  code: string;
  values: Record<string, unknown>;
};
type WidgetMessage = {
  type: "widget";
  id: number;
  widgetId: string;
  action: PythonWidgetAction;
};
type AnimateMessage = { type: "animate"; id: number; animationId: string };
type ResetMessage = { type: "reset"; sessionId: string };
type ConfigureMessage = { type: "configure"; interruptBuffer: Uint8Array };
type WorkerRequest =
  | RunMessage
  | WidgetMessage
  | AnimateMessage
  | ResetMessage
  | ConfigureMessage;

export type WorkerRunOutput = {
  error?: string;
  resultRepr?: string;
  images: string[];
  figures: number[];
  controls: PythonControl[];
  widgets: PythonWidget[];
  animations: PythonAnimation[];
};

export type WorkerResponse =
  | { type: "phase"; id: number; phase: PythonRunPhase }
  | { type: "stdout"; id: number; text: string }
  | { type: "result"; id: number; output: WorkerRunOutput }
  | { type: "widget-result"; id: number; output: PythonWidgetResult }
  | { type: "anim-result"; id: number; output: PythonAnimationStep }
  | { type: "error"; id: number; message: string };

type PyProxyLike = { destroy?: () => void };

type PyodideInterface = {
  runPython: (code: string, options?: { globals?: unknown }) => unknown;
  runPythonAsync: (
    code: string,
    options?: { globals?: unknown },
  ) => Promise<unknown>;
  loadPackagesFromImports: (
    code: string,
    options?: { messageCallback?: (message: string) => void },
  ) => Promise<unknown>;
  setStdout: (options?: { batched?: (text: string) => void }) => void;
  setStderr: (options?: { batched?: (text: string) => void }) => void;
  setInterruptBuffer?: (buffer: Uint8Array) => void;
};

const workerScope = self as unknown as {
  postMessage: (data: unknown) => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent) => void,
  ) => void;
};

const post = (message: WorkerResponse) => workerScope.postMessage(message);

const PYODIDE_VERSION = "314.0.3";
const PYODIDE_BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Interpreter-level setup, run once per Pyodide instance. Registers the
// `folio` module for interactive controls, patches matplotlib so figures stay
// headless while its widgets and animations become bridgeable, and defines
// the private helpers each run calls around user code. Blocks execute in
// their own per-page namespaces, so nothing here shadows what a reader
// writes.
const FOLIO_PYTHON_SETUP = String.raw`
import json
import os
import sys
import types
import warnings

# Matplotlib must never try to open a window; figures are captured as images
# after each run. Setting the environment first means even the reader's own
# "import matplotlib" lands on the headless backend.
os.environ["MPLBACKEND"] = "Agg"

# FuncAnimation warns that frames=None needs an explicit save_count before an
# animation can be *saved*; Folio streams live frames and never saves, so the
# advisory is pure noise in a block's console.
warnings.filterwarnings("ignore", message=".*save_count.*")

_folio = types.ModuleType("folio")
_folio.__doc__ = "Interactive controls for Folio's runnable Python blocks."
_folio._specs = []
_folio._values = {}


def _folio_slider(name, min=0.0, max=1.0, value=None, step=None, label=None):
    is_int = (
        isinstance(min, int)
        and isinstance(max, int)
        and isinstance(step, (int, type(None)))
        and isinstance(value, (int, type(None)))
    )
    low, high = float(min), float(max)
    if step is None:
        step_size = 1.0 if is_int else ((high - low) / 100.0 or 1.0)
    else:
        step_size = float(step)
    default = float(value) if value is not None else low
    current = _folio._values.get(str(name), default)
    try:
        current = float(current)
    except (TypeError, ValueError):
        current = default
    current = sorted((low, current, high))[1]
    if is_int:
        current = int(round(current))
    _folio._specs.append({
        "kind": "slider",
        "name": str(name),
        "label": str(label if label is not None else name),
        "min": low,
        "max": high,
        "step": step_size,
        "value": current,
    })
    return current


def _folio_toggle(name, value=False, label=None):
    current = bool(_folio._values.get(str(name), value))
    _folio._specs.append({
        "kind": "toggle",
        "name": str(name),
        "label": str(label if label is not None else name),
        "value": current,
    })
    return current


def _folio_select(name, options, value=None, label=None):
    choices = [str(option) for option in options]
    if not choices:
        raise ValueError("folio.select needs at least one option")
    default = str(value) if value is not None else choices[0]
    if default not in choices:
        default = choices[0]
    current = str(_folio._values.get(str(name), default))
    if current not in choices:
        current = default
    _folio._specs.append({
        "kind": "select",
        "name": str(name),
        "label": str(label if label is not None else name),
        "options": choices,
        "value": current,
    })
    return current


_folio.slider = _folio_slider
_folio.toggle = _folio_toggle
_folio.select = _folio_select
sys.modules["folio"] = _folio

_folio_widget_registry = {}
_folio_animation_registry = {}
_folio_id_counter = [0]


def _folio_begin(values_json):
    _folio._specs = []
    _folio._values = json.loads(values_json)


def _folio_specs_json():
    return json.dumps(_folio._specs)


def _folio_patch_class(cls, registry, prefix):
    if getattr(cls, "_folio_patched", False):
        return
    original_init = cls.__init__

    def patched_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        _folio_id_counter[0] += 1
        self._folio_id = "%s%d" % (prefix, _folio_id_counter[0])
        registry[self._folio_id] = self

    cls.__init__ = patched_init
    cls._folio_patched = True


def _folio_patch_matplotlib():
    from matplotlib import widgets
    from matplotlib.animation import Animation

    for name in (
        "Slider",
        "RangeSlider",
        "Button",
        "CheckButtons",
        "RadioButtons",
        "TextBox",
    ):
        cls = getattr(widgets, name, None)
        if cls is not None:
            _folio_patch_class(cls, _folio_widget_registry, "w")
    _folio_patch_class(Animation, _folio_animation_registry, "a")


def _folio_prepare():
    import importlib.util

    if importlib.util.find_spec("matplotlib") is None:
        return
    import matplotlib

    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt

    # plt.show() must be a quiet no-op: with the Agg backend it would only
    # warn, and the figures are collected after the run regardless.
    if not getattr(plt.show, "_folio_noop", False):
        def _folio_show(*args, **kwargs):
            return None

        _folio_show._folio_noop = True
        plt.show = _folio_show
    _folio_patch_matplotlib()


def _folio_run_start():
    # Each run starts from a clean canvas. Figures from the previous run stay
    # open only so their widgets and animations remain live between runs.
    for animation in _folio_animation_registry.values():
        # The page rendered these frames; silence the "Animation was deleted
        # without rendering anything" warning their teardown would raise.
        animation._draw_was_started = True
    _folio_animation_registry.clear()
    _folio_widget_registry.clear()
    if "matplotlib" in sys.modules:
        import matplotlib.pyplot as plt

        plt.close("all")


def _folio_figure_alive(figure):
    if figure is None:
        return False
    import matplotlib.pyplot as plt

    return figure.number in plt.get_fignums()


def _folio_figure_animated(figure):
    return any(
        getattr(animation, "_fig", None) is figure
        for animation in _folio_animation_registry.values()
    )


def _folio_capture_figure(figure):
    import base64
    import io

    # Bridged widgets are rendered as native page controls beneath the image,
    # so the in-figure widget strip is hidden while capturing to avoid showing
    # a dead duplicate.
    hidden = []
    for widget in _folio_widget_registry.values():
        ax = widget.ax
        if ax.get_figure() is figure and ax.get_visible():
            ax.set_visible(False)
            hidden.append(ax)
    try:
        buffer = io.BytesIO()
        if _folio_figure_animated(figure):
            # Animated figures render every frame: lower dpi keeps stepping
            # fast, and skipping tight bounds keeps the frame size stable so
            # the image does not jitter between frames.
            figure.savefig(buffer, format="png", dpi=96)
        else:
            figure.savefig(buffer, format="png", dpi=144, bbox_inches="tight")
        return base64.b64encode(buffer.getvalue()).decode("ascii")
    finally:
        for ax in hidden:
            ax.set_visible(True)


def _folio_capture_all_json():
    if "matplotlib" not in sys.modules:
        return json.dumps({"images": [], "figures": []})
    import matplotlib.pyplot as plt

    images = []
    figures = []
    for number in plt.get_fignums():
        images.append(_folio_capture_figure(plt.figure(number)))
        figures.append(number)
    return json.dumps({"images": images, "figures": figures})


def _folio_widget_spec(widget_id):
    from matplotlib.widgets import (
        Button,
        CheckButtons,
        RadioButtons,
        RangeSlider,
        Slider,
        TextBox,
    )

    widget = _folio_widget_registry.get(widget_id)
    if widget is None:
        return None
    figure = widget.ax.get_figure()
    if not _folio_figure_alive(figure):
        return None
    base = {"id": widget_id, "figure": figure.number}

    def slider_step(slider):
        try:
            return float(slider.valstep)
        except (TypeError, ValueError):
            span = float(slider.valmax) - float(slider.valmin)
            return (span / 100.0) or 1.0

    if isinstance(widget, RangeSlider):
        low, high = widget.val
        return dict(base, kind="range-slider",
                    label=str(widget.label.get_text() or widget_id),
                    min=float(widget.valmin), max=float(widget.valmax),
                    step=slider_step(widget),
                    value=[float(low), float(high)])
    if isinstance(widget, Slider):
        return dict(base, kind="slider",
                    label=str(widget.label.get_text() or widget_id),
                    min=float(widget.valmin), max=float(widget.valmax),
                    step=slider_step(widget), value=float(widget.val))
    if isinstance(widget, Button):
        return dict(base, kind="button",
                    label=str(widget.label.get_text() or widget_id))
    if isinstance(widget, CheckButtons):
        labels = [str(text.get_text()) for text in widget.labels]
        return dict(base, kind="check-buttons", labels=labels,
                    values=[bool(status) for status in widget.get_status()])
    if isinstance(widget, RadioButtons):
        labels = [str(text.get_text()) for text in widget.labels]
        selected = getattr(widget, "value_selected", None)
        index = labels.index(selected) if selected in labels else 0
        return dict(base, kind="radio-buttons", labels=labels, value=index)
    if isinstance(widget, TextBox):
        return dict(base, kind="text-box",
                    label=str(widget.label.get_text() or widget_id),
                    value=str(widget.text))
    return None


def _folio_widget_specs():
    if "matplotlib" not in sys.modules:
        return "[]"
    specs = []
    for widget_id in _folio_widget_registry:
        spec = _folio_widget_spec(widget_id)
        if spec is not None:
            specs.append(spec)
    return json.dumps(specs)


def _folio_widget_action(widget_id, action_json):
    widget = _folio_widget_registry.get(widget_id)
    if widget is None:
        return json.dumps({"stale": True})
    figure = widget.ax.get_figure()
    if not _folio_figure_alive(figure):
        return json.dumps({"stale": True})
    from matplotlib.widgets import RangeSlider, Slider, TextBox

    action = json.loads(action_json)
    error = None
    try:
        action_type = action.get("type")
        if action_type == "set":
            value = action.get("value")
            if isinstance(widget, RangeSlider):
                widget.set_val(tuple(float(part) for part in value))
            elif isinstance(widget, Slider):
                widget.set_val(float(value))
            elif isinstance(widget, TextBox):
                widget.set_val(str(value))
            else:
                raise TypeError("This widget does not accept a value.")
        elif action_type == "click":
            widget._observers.process("clicked", None)
        elif action_type in ("toggle", "select"):
            widget.set_active(int(action.get("index", 0)))
        else:
            raise ValueError("Unknown widget action.")
    except Exception:
        import traceback

        error = traceback.format_exc()
    return json.dumps({
        "stale": False,
        "figure": figure.number,
        "image": _folio_capture_figure(figure),
        "error": error,
        "spec": _folio_widget_spec(widget_id),
    })


def _folio_animation_specs():
    if "matplotlib" not in sys.modules:
        return "[]"
    specs = []
    for anim_id, animation in _folio_animation_registry.items():
        figure = getattr(animation, "_fig", None)
        if not _folio_figure_alive(figure):
            continue
        try:
            interval = float(getattr(animation, "_interval", 100.0) or 100.0)
        except (TypeError, ValueError):
            interval = 100.0
        specs.append({
            "id": anim_id,
            "figure": figure.number,
            "interval": interval,
        })
    return json.dumps(specs)


def _folio_animation_step(anim_id):
    animation = _folio_animation_registry.get(anim_id)
    if animation is None:
        return json.dumps({"stale": True})
    figure = getattr(animation, "_fig", None)
    if not _folio_figure_alive(figure):
        return json.dumps({"stale": True})
    error = None
    done = False
    try:
        if not getattr(animation, "_folio_started", False):
            animation._init_draw()
            animation._folio_started = True
        # _step advances one frame and handles repeat internally; it returns
        # False once a non-repeating animation is exhausted.
        done = animation._step() is False
    except Exception:
        import traceback

        error = traceback.format_exc()
    return json.dumps({
        "stale": False,
        "done": done,
        "figure": figure.number,
        "image": _folio_capture_figure(figure),
        "error": error,
    })
`;

let loadPromise: Promise<PyodideInterface> | undefined;
let interruptBuffer: Uint8Array | undefined;
const sessions = new Map<string, PyProxyLike>();
// Stdout is streamed to whichever operation is active; the main thread only
// dispatches one operation at a time. The gate keeps runtime chatter (package
// loading and the like) out of a block's console — only output produced while
// the reader's own code is executing flows through.
let currentRequestId = 0;
let streamingUserOutput = false;

function ensurePyodide(id: number): Promise<PyodideInterface> {
  if (!loadPromise) {
    post({ type: "phase", id, phase: "runtime" });
    loadPromise = (async () => {
      const pyodideModule = (await import(
        /* @vite-ignore */ `${PYODIDE_BASE_URL}pyodide.mjs`
      )) as {
        loadPyodide: (options: {
          indexURL: string;
        }) => Promise<PyodideInterface>;
      };
      const pyodide = await pyodideModule.loadPyodide({
        indexURL: PYODIDE_BASE_URL,
      });
      pyodide.runPython(FOLIO_PYTHON_SETUP);
      if (interruptBuffer) pyodide.setInterruptBuffer?.(interruptBuffer);
      const stream = (text: string) => {
        if (streamingUserOutput) {
          post({ type: "stdout", id: currentRequestId, text });
        }
      };
      pyodide.setStdout({ batched: stream });
      pyodide.setStderr({ batched: stream });
      return pyodide;
    })();
    // A failed download must not poison later attempts.
    loadPromise.catch(() => {
      loadPromise = undefined;
    });
  }
  return loadPromise;
}

function sessionNamespace(pyodide: PyodideInterface, sessionId: string) {
  let namespace = sessions.get(sessionId);
  if (!namespace) {
    namespace = pyodide.runPython("dict()") as PyProxyLike;
    sessions.set(sessionId, namespace);
  }
  return namespace;
}

// Pyodide tracebacks include its own dispatch frames; the reader only wrote
// the code in <exec>, so the report starts there.
function cleanTraceback(message: string) {
  const lines = message.trimEnd().split("\n");
  const firstUserFrame = lines.findIndex((line) =>
    line.includes('File "<exec>"'),
  );
  if (firstUserFrame > 0) {
    return [
      "Traceback (most recent call last):",
      ...lines.slice(firstUserFrame),
    ].join("\n");
  }
  return message.trimEnd();
}

async function handleRun({ id, sessionId, code, values }: RunMessage) {
  currentRequestId = id;
  const pyodide = await ensurePyodide(id);
  post({ type: "phase", id, phase: "packages" });
  await pyodide.loadPackagesFromImports(code, {
    messageCallback: () => undefined,
  });
  pyodide.runPython("_folio_prepare()");
  pyodide.runPython("_folio_run_start()");
  post({ type: "phase", id, phase: "running" });
  // JSON is embedded as a Python string literal: JSON.stringify only emits
  // escape sequences Python string literals also understand.
  pyodide.runPython(`_folio_begin(${JSON.stringify(JSON.stringify(values))})`);

  let resultRepr: string | undefined;
  let error: string | undefined;
  streamingUserOutput = true;
  try {
    const result = await pyodide.runPythonAsync(code, {
      globals: sessionNamespace(pyodide, sessionId),
    });
    if (result !== undefined) {
      resultRepr = String(result);
      (result as PyProxyLike)?.destroy?.();
    }
  } catch (caught) {
    error = cleanTraceback(
      caught instanceof Error ? caught.message : String(caught),
    );
  } finally {
    streamingUserOutput = false;
  }

  const controls = JSON.parse(
    pyodide.runPython("_folio_specs_json()") as string,
  ) as PythonControl[];
  const capture = JSON.parse(
    pyodide.runPython("_folio_capture_all_json()") as string,
  ) as { images: string[]; figures: number[] };
  const widgets = JSON.parse(
    pyodide.runPython("_folio_widget_specs()") as string,
  ) as PythonWidget[];
  const animations = JSON.parse(
    pyodide.runPython("_folio_animation_specs()") as string,
  ) as PythonAnimation[];
  post({
    type: "result",
    id,
    output: {
      error,
      resultRepr,
      images: capture.images,
      figures: capture.figures,
      controls,
      widgets,
      animations,
    },
  });
}

async function handleWidget({ id, widgetId, action }: WidgetMessage) {
  currentRequestId = id;
  const pyodide = await ensurePyodide(id);
  streamingUserOutput = true;
  let output: PythonWidgetResult;
  try {
    output = JSON.parse(
      pyodide.runPython(
        `_folio_widget_action(${JSON.stringify(widgetId)}, ${JSON.stringify(
          JSON.stringify(action),
        )})`,
      ) as string,
    ) as PythonWidgetResult;
  } finally {
    streamingUserOutput = false;
  }
  if (output.error) output.error = cleanTraceback(output.error);
  post({ type: "widget-result", id, output });
}

async function handleAnimate({ id, animationId }: AnimateMessage) {
  currentRequestId = id;
  const pyodide = await ensurePyodide(id);
  streamingUserOutput = true;
  let output: PythonAnimationStep;
  try {
    output = JSON.parse(
      pyodide.runPython(
        `_folio_animation_step(${JSON.stringify(animationId)})`,
      ) as string,
    ) as PythonAnimationStep;
  } finally {
    streamingUserOutput = false;
  }
  if (output.error) output.error = cleanTraceback(output.error);
  post({ type: "anim-result", id, output });
}

workerScope.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as WorkerRequest;
  const fail = (id: number) => (caught: unknown) =>
    post({
      type: "error",
      id,
      message: caught instanceof Error ? caught.message : String(caught),
    });
  switch (message.type) {
    case "configure":
      interruptBuffer = message.interruptBuffer;
      break;
    case "reset":
      sessions.get(message.sessionId)?.destroy?.();
      sessions.delete(message.sessionId);
      break;
    case "run":
      void handleRun(message).catch(fail(message.id));
      break;
    case "widget":
      void handleWidget(message).catch(fail(message.id));
      break;
    case "animate":
      void handleAnimate(message).catch(fail(message.id));
      break;
  }
});
