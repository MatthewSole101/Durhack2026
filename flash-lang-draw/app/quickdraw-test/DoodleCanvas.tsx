'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  classifyCanvas,
  initClassifier,
  isClassifierReady,
  type Prediction,
} from '@/lib/quickdrawClassifier';

/** Internal drawing resolution; CSS scales it responsively. */
const CANVAS_SIZE = 420;
const MIN_BRUSH = 8;
const MAX_BRUSH = 28;
const DEFAULT_BRUSH = 16;
const SNAPSHOT_INTERVAL_MS = 200;

type ModelStatus = 'loading' | 'ready' | 'error';

interface Point {
  x: number;
  y: number;
}

function getCanvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): Point {
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  };
}

export default function DoodleCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // All per-frame drawing state lives in refs: pointer handlers at 60fps must
  // never trigger React re-renders.
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<Point | null>(null);
  /** New strokes were drawn since the last snapshot was taken. */
  const isDirtyRef = useRef(false);
  /** The canvas contains at least one stroke (used to gate snapshots). */
  const hasStrokesRef = useRef(false);
  /** An inference is in flight; skip snapshots until it finishes. */
  const isInferringRef = useRef(false);

  const [status, setStatus] = useState<ModelStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);
  const [isEmpty, setIsEmpty] = useState(true);

  // Prime the canvas with a solid white background once on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  // Load LiteRT + the TFLite model + labels (client-only; runs after mount).
  useEffect(() => {
    let cancelled = false;
    initClassifier()
      .then(() => {
        if (!cancelled) setStatus('ready');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : String(error));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runSnapshot = useCallback(async () => {
    if (!isClassifierReady() || !isDirtyRef.current || isInferringRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    isInferringRef.current = true;
    isDirtyRef.current = false;
    try {
      setPredictions(await classifyCanvas(canvas));
    } catch (error) {
      console.error('QuickDraw inference failed:', error);
    } finally {
      isInferringRef.current = false;
    }
  }, []);

  // 200ms heartbeat while the model is ready (pointerup also snapshots early).
  useEffect(() => {
    if (status !== 'ready') return;
    const intervalId = window.setInterval(() => {
      void runSnapshot();
    }, SNAPSHOT_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [status, runSnapshot]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    canvas.setPointerCapture(event.pointerId);
    const point = getCanvasPoint(event);
    isDrawingRef.current = true;
    lastPointRef.current = point;

    ctx.strokeStyle = '#000000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    // Zero-length segment paints a dot for plain taps.
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();

    hasStrokesRef.current = true;
    isDirtyRef.current = true;
    setIsEmpty(false);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;

    const point = getCanvasPoint(event);
    const last = lastPointRef.current ?? point;
    ctx.strokeStyle = '#000000';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    isDirtyRef.current = true;
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    isDrawingRef.current = false;
    lastPointRef.current = null;
    // Snapshot immediately on stroke end instead of waiting for the next tick.
    void runSnapshot();
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    hasStrokesRef.current = false;
    isDirtyRef.current = false;
    setIsEmpty(true);
    setPredictions([]);
  };

  return (
    <div className="grid w-full gap-6 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <section className="flex flex-col gap-4">
        <div className="relative overflow-hidden rounded-2xl border border-black/10 bg-white shadow-sm dark:border-white/15">
          <canvas
            ref={canvasRef}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            aria-label="Doodle canvas — draw with mouse, touch, or stylus"
            className="block h-auto w-full cursor-crosshair touch-none select-none bg-white"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          />
          {isEmpty && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-400">
              Draw a doodle here…
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 rounded-2xl border border-black/10 bg-white px-4 py-3 dark:border-white/15 dark:bg-zinc-900">
          <label className="flex flex-1 items-center gap-3 text-sm text-zinc-700 dark:text-zinc-300">
            <span className="shrink-0 font-medium">Brush</span>
            <input
              type="range"
              min={MIN_BRUSH}
              max={MAX_BRUSH}
              step={1}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
              className="w-full accent-zinc-900 dark:accent-zinc-100"
            />
            <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums">
              {brushSize}px
            </span>
          </label>
          <button
            type="button"
            onClick={handleClear}
            className="shrink-0 rounded-full border border-solid border-black/[.08] px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-100 dark:hover:bg-white/[.08]"
          >
            Clear Canvas
          </button>
        </div>
      </section>

      <section
        aria-label="Live predictions"
        className="flex flex-col gap-4 rounded-2xl border border-black/10 bg-white p-5 dark:border-white/15 dark:bg-zinc-900"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Top 5 predictions
          </h2>
          <StatusBadge status={status} />
        </div>
        {status === 'error' && (
          <p
            role="alert"
            className="rounded-xl bg-red-50 px-4 py-3 text-sm leading-6 text-red-700 dark:bg-red-950/40 dark:text-red-300"
          >
            {errorMessage ?? 'Failed to load the model.'}
          </p>
        )}
        {status === 'ready' && predictions.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Start drawing — recognition updates as you draw.
          </p>
        )}
        <ol className="flex flex-col gap-3">
          {predictions.map((prediction, rank) => {
            const percent = prediction.confidence * 100;
            return (
              <li key={`${rank}-${prediction.label}`} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                    <span className="mr-2 font-mono text-xs text-zinc-400 tabular-nums">
                      {rank + 1}
                    </span>
                    {prediction.label}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-zinc-600 tabular-nums dark:text-zinc-400">
                    {percent.toFixed(1)}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div
                    className={`h-full rounded-full transition-[width] duration-200 ease-out ${
                      rank === 0 ? 'bg-zinc-900 dark:bg-zinc-100' : 'bg-zinc-400 dark:bg-zinc-600'
                    }`}
                    style={{ width: `${Math.max(percent, 0)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: ModelStatus }) {
  const config = {
    loading: {
      text: 'Loading model…',
      className:
        'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 animate-pulse',
    },
    ready: {
      text: 'Model ready',
      className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
    },
    error: {
      text: 'Model error',
      className: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
    },
  }[status];

  return (
    <span
      aria-live="polite"
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${config.className}`}
    >
      {config.text}
    </span>
  );
}
