// Main-thread orchestrator for Folio's runnable Python blocks. The Pyodide
// interpreter itself lives in a dedicated worker (app/python-worker.ts) so a
// busy or runaway script never freezes the reader. This module serializes
// operations onto that worker, streams its stdout back to the owning block,
// and exposes a stop control: a graceful interrupt when the page is
// cross-origin isolated, otherwise tearing the worker down and starting the
// next run on a fresh interpreter.

import PythonWorker from "@/app/python-worker?worker";

export type PythonControl =
  | {
      kind: "slider";
      name: string;
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
    }
  | { kind: "toggle"; name: string; label: string; value: boolean }
  | {
      kind: "select";
      name: string;
      label: string;
      options: string[];
      value: string;
    };

export type PythonControlValue = number | boolean | string;

// A live matplotlib widget registered inside a still-open figure. Unlike
// PythonControl values, using one of these does not re-run the block; it
// drives the widget's own Python callbacks on the live figure.
export type PythonWidget =
  | {
      id: string;
      kind: "slider";
      figure: number;
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
    }
  | {
      id: string;
      kind: "range-slider";
      figure: number;
      label: string;
      min: number;
      max: number;
      step: number;
      value: [number, number];
    }
  | { id: string; kind: "button"; figure: number; label: string }
  | {
      id: string;
      kind: "check-buttons";
      figure: number;
      labels: string[];
      values: boolean[];
    }
  | {
      id: string;
      kind: "radio-buttons";
      figure: number;
      labels: string[];
      value: number;
    }
  | { id: string; kind: "text-box"; figure: number; label: string; value: string };

export type PythonWidgetAction =
  | { type: "set"; value: number | [number, number] | string }
  | { type: "click" }
  | { type: "toggle"; index: number }
  | { type: "select"; index: number };

// A live matplotlib animation whose frames the page pulls one at a time.
export type PythonAnimation = {
  id: string;
  figure: number;
  interval: number;
};

export type PythonAnimationStep = {
  stale: boolean;
  done?: boolean;
  figure?: number;
  image?: string;
  error?: string;
};

export type PythonRunPhase = "runtime" | "packages" | "running";

export type PythonRunOutput = {
  error?: string;
  resultRepr?: string;
  images: string[];
  figures: number[];
  controls: PythonControl[];
  widgets: PythonWidget[];
  animations: PythonAnimation[];
};

export type PythonWidgetResult = {
  stale: boolean;
  figure?: number;
  image?: string;
  error?: string;
  spec?: PythonWidget | null;
};

export type PythonRunRequest = {
  sessionId: string;
  code: string;
  values: Record<string, PythonControlValue>;
  onPhase?: (phase: PythonRunPhase) => void;
  onStdout?: (text: string) => void;
};

export type PythonWidgetRequest = {
  widgetId: string;
  action: PythonWidgetAction;
  onStdout?: (text: string) => void;
};

export type PythonAnimationRequest = {
  animationId: string;
  onStdout?: (text: string) => void;
};

export class PythonStoppedError extends Error {
  constructor() {
    super("Stopped — the page's Python session was reset.");
    this.name = "PythonStoppedError";
  }
}

type WorkerResponse =
  | { type: "phase"; id: number; phase: PythonRunPhase }
  | { type: "stdout"; id: number; text: string }
  | { type: "result"; id: number; output: Omit<PythonRunOutput, never> }
  | { type: "widget-result"; id: number; output: PythonWidgetResult }
  | { type: "anim-result"; id: number; output: PythonAnimationStep }
  | { type: "error"; id: number; message: string };

type PendingOperation = {
  resolve: (value: never) => void;
  reject: (reason: Error) => void;
  onPhase?: (phase: PythonRunPhase) => void;
  onStdout?: (text: string) => void;
};

type WorkerState = { worker: Worker; interrupt?: Uint8Array };

let workerState: WorkerState | undefined;
let requestCounter = 0;
const pending = new Map<number, PendingOperation>();
// One interpreter serves every block, so operations are serialized.
let queue: Promise<unknown> = Promise.resolve();

function failAllPending(error: Error) {
  for (const operation of pending.values()) operation.reject(error);
  pending.clear();
}

function ensureWorker(): WorkerState {
  if (workerState) return workerState;
  const worker = new PythonWorker();

  // With cross-origin isolation the interpreter can take a real
  // KeyboardInterrupt through shared memory; without it, stopping falls back
  // to terminating the worker.
  let interrupt: Uint8Array | undefined;
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
  ) {
    interrupt = new Uint8Array(new SharedArrayBuffer(1));
    worker.postMessage({ type: "configure", interruptBuffer: interrupt });
  }

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as WorkerResponse;
    const operation = pending.get(message.id);
    if (!operation) return;
    switch (message.type) {
      case "phase":
        operation.onPhase?.(message.phase);
        break;
      case "stdout":
        operation.onStdout?.(message.text);
        break;
      case "result":
      case "widget-result":
      case "anim-result":
        pending.delete(message.id);
        operation.resolve(message.output as never);
        break;
      case "error":
        pending.delete(message.id);
        operation.reject(new Error(message.message));
        break;
    }
  };
  worker.onerror = () => {
    worker.terminate();
    workerState = undefined;
    failAllPending(
      new Error(
        "The Python runtime could not start. Check your connection and run the block again.",
      ),
    );
  };

  workerState = { worker, interrupt };
  return workerState;
}

function send<T>(
  message: Record<string, unknown>,
  handlers: Pick<PendingOperation, "onPhase" | "onStdout">,
): Promise<T> {
  const state = ensureWorker();
  const id = ++requestCounter;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject, ...handlers });
    state.worker.postMessage({ ...message, id });
  });
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function runPythonBlock(
  request: PythonRunRequest,
): Promise<PythonRunOutput> {
  const { sessionId, code, values, ...handlers } = request;
  return enqueue(() =>
    send<PythonRunOutput>({ type: "run", sessionId, code, values }, handlers),
  );
}

export function setPythonWidget(
  request: PythonWidgetRequest,
): Promise<PythonWidgetResult> {
  const { widgetId, action, ...handlers } = request;
  // A widget with no live worker has no live figure behind it either; report
  // stale instead of booting a whole interpreter to find that out.
  if (!workerState) return Promise.resolve({ stale: true });
  return enqueue(() => {
    if (!workerState) return Promise.resolve({ stale: true });
    return send<PythonWidgetResult>(
      { type: "widget", widgetId, action },
      handlers,
    );
  });
}

export function stepPythonAnimation(
  request: PythonAnimationRequest,
): Promise<PythonAnimationStep> {
  const { animationId, ...handlers } = request;
  // No worker means no live figure to animate; report stale instead of
  // booting a whole interpreter to find that out.
  if (!workerState) return Promise.resolve({ stale: true });
  return enqueue(() => {
    if (!workerState) return Promise.resolve({ stale: true });
    return send<PythonAnimationStep>(
      { type: "animate", animationId },
      handlers,
    );
  });
}

export function resetPythonSession(sessionId: string) {
  workerState?.worker.postMessage({ type: "reset", sessionId });
}

// Stops the running operation. Under cross-origin isolation this raises
// KeyboardInterrupt inside the interpreter and sessions survive; otherwise the
// worker is terminated, which also discards every page's session and any live
// figure widgets.
export function stopPython() {
  const state = workerState;
  if (!state) return;
  if (state.interrupt) {
    state.interrupt[0] = 2; // SIGINT
    return;
  }
  state.worker.terminate();
  workerState = undefined;
  failAllPending(new PythonStoppedError());
}
