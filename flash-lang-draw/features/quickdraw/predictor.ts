// Prediction scheduling. While a stroke is being drawn, predict at most once every
// PREDICT_THROTTLE_MS; when the drawing settles (stroke end, undo, clear), predict right away.
// Inference is serialised: if a prediction is running, one more is queued for when it finishes.

import { PREDICT_THROTTLE_MS } from "./constants";
import type { Guess } from "./model";
import type { Strokes } from "./preprocess";

export type Prediction = { guesses: Guess[]; input: Float32Array | null };

export type PredictorOptions = {
  getStrokes: () => Strokes;
  toInput: (strokes: Strokes) => Float32Array | null;
  predict: (input: Float32Array) => Promise<Guess[]>;
  onPrediction: (p: Prediction) => void;
  onError: (e: unknown) => void;
};

export type Predictor = {
  /** The drawing changed mid-stroke: throttled. */
  drawing: () => void;
  /** The drawing settled: predict now. */
  settled: () => void;
  /** Drop anything in flight (e.g. the round changed); its result is never reported. */
  reset: () => void;
  stop: () => void;
};

export function createPredictor({ getStrokes, toInput, predict, onPrediction, onError }: PredictorOptions): Predictor {
  let running = false, again = false, stopped = false;
  let generation = 0, lastRun = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function run() {
    clearTimeout(timer); timer = undefined;
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        lastRun = performance.now();
        const gen = generation;
        const input = toInput(getStrokes());
        // empty canvas: no inference, just clear the guesses
        const guesses = input ? await predict(input) : [];
        if (!stopped && gen === generation) onPrediction({ guesses, input });
      } while (again && !stopped);
    } catch (e) {
      if (!stopped) onError(e);
    } finally {
      running = false;
    }
  }

  return {
    drawing() {
      if (stopped || timer !== undefined) return;
      timer = setTimeout(run, Math.max(0, lastRun + PREDICT_THROTTLE_MS - performance.now()));
    },
    settled() { void run(); },
    reset() { generation++; },
    stop() { stopped = true; clearTimeout(timer); },
  };
}
