// The Quick Draw classifier: fetch the self-hosted model, patch it, compile it on the wasm (CPU)
// accelerator and expose predict() / dispose(). Tensors and the compiled model live in wasm
// memory, outside the JS garbage collector, so everything created here is deleted explicitly.

import type { CompiledModel } from "@litertjs/core";
import { LABELS_URL, MIN_MODEL_BYTES, MODEL_NAME, MODEL_URL, TOP_K } from "./constants";
import { fixBatchSize } from "./flatbuffer";
import { BUILTIN_LABELS, parseLabels, type LabelSource } from "./labels";
import { loadRuntime } from "./runtime";

export type Guess = { label: string; prob: number };
export type LoadStage = "runtime" | "compiling";

export type QuickDrawModel = {
  name: string;
  inputShape: number[];
  dtype: string;
  labels: readonly string[];
  labelSource: LabelSource;
  /** Top guesses for one 28×28 input, best first. Calls must not overlap (see predictor.ts). */
  predict: (input: Float32Array) => Promise<Guess[]>;
  /** Raw class probabilities for one input, in label order. */
  probabilities: (input: Float32Array) => Promise<Float32Array>;
  dispose: () => void;
};

// The original bytes are fetched once per page and never modified; each compile patches a copy.
let modelBytes: Promise<Uint8Array> | null = null;

function fetchModelBytes(): Promise<Uint8Array> {
  modelBytes ??= (async () => {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`Could not load ${MODEL_URL} (HTTP ${res.status}). Is ${MODEL_NAME} in public/models?`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength < MIN_MODEL_BYTES) {
      throw new Error(
        `${MODEL_NAME} is only ${bytes.byteLength} bytes — that is a Git LFS pointer, not the model. ` +
        "Run `git lfs pull` or download the real file into public/models.");
    }
    return bytes;
  })();
  modelBytes.catch(() => { modelBytes = null; }); // allow a retry after a failed load
  return modelBytes;
}

async function fetchLabels(): Promise<{ labels: readonly string[]; labelSource: LabelSource }> {
  try {
    const res = await fetch(LABELS_URL);
    const labels = res.ok ? parseLabels(await res.text()) : null;
    if (labels) return { labels, labelSource: "labels.txt" };
  } catch { /* fall through to the built-in list */ }
  return { labels: BUILTIN_LABELS, labelSource: "built-in" };
}

/** If the output looks like logits (negatives, or it doesn't sum to ≈ 1), turn it into probabilities. */
export function toProbabilities(out: Float32Array): Float32Array {
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of out) { sum += v; min = Math.min(min, v); max = Math.max(max, v); }
  if (min >= 0 && Math.abs(sum - 1) <= 0.05) return out;
  const exp = out.map(v => Math.exp(v - max));
  const total = exp.reduce((a, b) => a + b, 0);
  return exp.map(v => v / total);
}

export function topK(probs: ArrayLike<number>, labels: readonly string[], k = TOP_K): Guess[] {
  return Array.from(probs, (prob, i) => ({ label: labels[i] ?? `class ${i}`, prob }))
    .sort((a, b) => b.prob - a.prob)
    .slice(0, k);
}

export async function loadQuickDrawModel(onStage?: (stage: LoadStage) => void): Promise<QuickDrawModel> {
  onStage?.("runtime");
  const [core, original, { labels, labelSource }] = await Promise.all([loadRuntime(), fetchModelBytes(), fetchLabels()]);

  onStage?.("compiling");
  const compiled: CompiledModel = await core.loadAndCompile(fixBatchSize(original.slice()), { accelerator: "wasm" });

  // Only the float32-input model is supported; a fully quantized one must never run, whatever it is named.
  const details = compiled.getInputDetails()[0];
  if (details?.dtype !== "float32") {
    compiled.delete();
    throw new Error(`Unsupported model (input dtype ${details?.dtype}): only ${MODEL_NAME} (float32 input) is supported.`);
  }
  const inputShape = Array.from(details.shape); // [1, 28, 28, 1] once the batch size is patched

  let disposed = false;
  let inflight: Promise<unknown> | null = null;

  async function run(input: Float32Array): Promise<Float32Array> {
    if (disposed) throw new Error("Quick Draw model was disposed");
    const tin = new core.Tensor(input, inputShape);
    try {
      const outs = await compiled.run(tin);
      let cpu: (typeof outs)[number] | null = null;
      try {
        cpu = await outs[0].moveTo("wasm");
        return toProbabilities(Float32Array.from(cpu.toTypedArray() as Float32Array)); // copy out of wasm memory
      } finally {
        if (cpu && cpu !== outs[0]) cpu.delete();
        outs.forEach(t => t.delete());
      }
    } finally {
      tin.delete();
    }
  }

  function probabilities(input: Float32Array) {
    const p = run(input);
    inflight = p.catch(() => {});
    return p;
  }

  return {
    name: MODEL_NAME, inputShape, dtype: details.dtype, labels, labelSource,
    probabilities,
    predict: async input => topK(await probabilities(input), labels),
    dispose() {
      if (disposed) return;
      disposed = true;
      // never free the model under a running inference
      (inflight ?? Promise.resolve()).then(() => compiled.delete());
    },
  };
}
