/**
 * Client-only QuickDraw classifier backed by LiteRT.js (@litertjs/core).
 *
 * Only call `initClassifier()` / `classifyCanvas()` from the browser (inside
 * effects or event handlers of client components); `loadLiteRt()`, the hidden
 * offscreen canvas, and `fetch` all touch browser globals.
 */
import {
  loadAndCompile,
  loadLiteRt,
  Tensor,
  type CompiledModel,
} from '@litertjs/core';

const WASM_BASE_URL = '/wasm/';
const MODEL_URL = '/models/quickdraw_model.tflite';
const LABELS_URL = '/models/labels.txt';

/** The QuickDraw model consumes a single 1x28x28x1 grayscale image. */
const INPUT_SIZE = 28;
/** Number of top predictions returned per inference. */
const TOP_K = 5;

export interface Prediction {
  label: string;
  confidence: number;
}

let model: CompiledModel | null = null;
let initPromise: Promise<void> | null = null;
let labels: string[] = [];

// Reusable hidden 28x28 canvas used to downsample the user's drawing.
let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

// ---------------------------------------------------------------------------
// TFLite flatbuffer: dynamic-batch patch
// ---------------------------------------------------------------------------
//
// quickdraw_model.tflite compiles in LiteRT.js as an
// `image float32[-1, 28, 28, 1]` signature even though every graph tensor has
// a static `shape = [1, ...]`: the exporter (MLIR) attaches the deprecated
// `Tensor.shape_if_variable` (flatbuffer field 7) = [-1, ...] to all 50
// activation tensors, and LiteRT derives its signature types from that.
// A dynamic-batch signature is then unusable with this library version:
//  - `CompiledModel.run()`'s input gate compares tensor dims against the
//    signature dims with strict element equality, so `1 !== -1` throws
//    "TensorBuffer ranked tensor type float32[1, 28, 28, 1] does not match
//    expected ranked tensor type float32[-1, 28, 28, 1]";
//  - the underlying C++ `checkTensorBufferCompatible` rejects the same pair,
//    and it refuses input buffers carrying -1 dims themselves
//    ("TensorBuffer must have all static dimensions");
//  - @litertjs/core 2.6.0 exposes no resize-input / allocate-tensors API.
// (All three facts were verified empirically against the real Wasm runtime.)
//
// Fix: before compiling, rewrite every batch dim stored as -1 to 1 in the
// flatbuffer's `Tensor.shape` / `Tensor.shape_if_variable` vectors. Values
// are overwritten in place (int32 → int32), so all offsets stay valid and
// the model compiles as a plain static batch-1 graph.
//
// tflite.fbs field ids used (v3 schema):
//   Model: subgraphs=2  ·  SubGraph: tensors=0
//   Tensor: shape=0, shape_if_variable=7

function readU32(dv: DataView, pos: number): number {
  if (pos < 0 || pos + 4 > dv.byteLength) {
    throw new Error(`quickdraw model: flatbuffer read out of bounds at ${pos}`);
  }
  return dv.getUint32(pos, true);
}

/** Follows a uoffset table reference to the absolute position of the table. */
function deref(dv: DataView, pos: number): number {
  return pos + readU32(dv, pos);
}

/** Absolute position of a table field, or null when absent. */
function fieldPos(dv: DataView, tablePos: number, id: number): number | null {
  const soffset = readU32(dv, tablePos);
  const vtPos = tablePos - (soffset | 0); // soffset is signed
  if (vtPos < 0 || vtPos + 4 > dv.byteLength) {
    throw new Error(`quickdraw model: bad vtable at ${vtPos} (table ${tablePos}).`);
  }
  const vtSize = dv.getUint16(vtPos, true);
  const offsetEntry = vtPos + 4 + id * 2;
  if (offsetEntry + 2 > vtPos + vtSize) return null;
  const off = dv.getUint16(offsetEntry, true);
  return off === 0 ? null : tablePos + off;
}

function vectorInfo(dv: DataView, table: number, id: number) {
  const pos = fieldPos(dv, table, id);
  if (pos === null) return null;
  // pos -> uoffset; the vector's uint32 length lives at (pos + uoffset),
  // and its elements begin immediately after the length prefix.
  const vecStart = pos + readU32(dv, pos);
  return { dataPos: vecStart + 4, length: readU32(dv, vecStart) };
}

/** Sets the batch dim of one i32 vector field to 1 when it is -1; returns 0 or 1. */
function patchShapeField(dv: DataView, table: number, shapeFieldId: number): number {
  const shape = vectorInfo(dv, table, shapeFieldId);
  if (!shape || shape.length === 0) return 0;
  if (dv.getInt32(shape.dataPos, true) === -1) {
    dv.setInt32(shape.dataPos, 1, true);
    return 1;
  }
  return 0;
}

/**
 * Rewrites `-1` batch dims to `1` in a TFLite flatbuffer, in place.
 * Returns the number of batch dims that were patched.
 */
export function patchTFLiteBatchDims(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const root = deref(dv, 0);
  let patched = 0;

  const subgraphs = vectorInfo(dv, root, 2);
  if (!subgraphs) {
    throw new Error('quickdraw model: not a tflite flatbuffer (no subgraphs vector).');
  }
  for (let s = 0; s < subgraphs.length; s++) {
    const subgraph = deref(dv, subgraphs.dataPos + s * 4);
    const tensors = vectorInfo(dv, subgraph, 0);
    if (!tensors) continue;
    for (let t = 0; t < tensors.length; t++) {
      const tensor = deref(dv, tensors.dataPos + t * 4);
      patched += patchShapeField(dv, tensor, 0);
      patched += patchShapeField(dv, tensor, 7);
    }
  }

  return patched;
}

// LiteRT's C++ core logs routine runtime chatter ("INFO: [foo.cc:54] ...",
// "WARNING: [npu_registry.cc:34] ...", "INFO: Created TensorFlow Lite XNNPACK
// delegate for CPU.") through console.error, which makes the Next.js dev
// overlay flag every page load. Swallow only those level-prefixed lines and
// pass everything else through untouched.
let consoleFilterInstalled = false;
const LITE_RT_CPP_LOG = /^(INFO|WARNING|VERBOSE): /;

function suppressLiteRtCppConsoleErrors(): void {
  if (consoleFilterInstalled) return;
  consoleFilterInstalled = true;
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && LITE_RT_CPP_LOG.test(first)) return;
    originalError(...args);
  };
}

async function initialize(): Promise<void> {
  suppressLiteRtCppConsoleErrors();
  await loadLiteRt(WASM_BASE_URL);

  const [modelBytes, labelsResponse] = await Promise.all([
    fetch(MODEL_URL).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load ${MODEL_URL}: ${response.status} ${response.statusText}`);
      }
      return response.arrayBuffer();
    }),
    fetch(LABELS_URL).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load ${LABELS_URL}: ${response.status} ${response.statusText}`);
      }
      return response.text();
    }),
  ]);

  // The model is exported with a dynamic (None) batch dim; pin it to 1
  // (see the patchTFLiteBatchDims comment) so LiteRT.js accepts our inputs.
  const patchedBytes = new Uint8Array(modelBytes);
  const patchedCount = patchTFLiteBatchDims(patchedBytes);
  console.info(
    `[quickdraw] fixed-batch patch: rewrote ${patchedCount} dynamic batch dim(s) to 1`,
  );

  const compiled = await loadAndCompile(patchedBytes, { accelerator: 'wasm' });
  labels = labelsResponse
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  model = compiled;
}

/**
 * Loads the LiteRT Wasm runtime, compiles the QuickDraw model on the Wasm
 * accelerator, and parses the label list. Safe to call repeatedly; the
 * underlying load runs once (failures may be retried).
 */
export function initClassifier(): Promise<void> {
  if (!initPromise) {
    initPromise = initialize().catch((error) => {
      // Allow a later retry after a failed load (e.g. transient network error).
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

export function isClassifierReady(): boolean {
  return model !== null && !model.deleted;
}

function getOffscreenContext(): CanvasRenderingContext2D {
  if (!offscreenCtx) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = INPUT_SIZE;
    offscreenCanvas.height = INPUT_SIZE;
    const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('Could not create the 28x28 offscreen 2D context.');
    }
    offscreenCtx = ctx;
  }
  return offscreenCtx;
}

/**
 * Runs one inference on the current contents of `source`.
 *
 * The source canvas is downsampled onto a solid-white 28x28 canvas and
 * converted to luminance floats where 1.0 = white background and
 * 0.0 = black stroke, matching the model's training convention.
 */
export async function classifyCanvas(source: HTMLCanvasElement): Promise<Prediction[]> {
  const activeModel = model;
  if (!activeModel) {
    throw new Error('Classifier is not initialized — await initClassifier() first.');
  }

  const ctx = getOffscreenContext();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(source, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const { data: rgba } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);

  const input = new Float32Array(INPUT_SIZE * INPUT_SIZE);
  for (let i = 0; i < input.length; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    // Standard luminance; keep the 1.0=white / 0.0=black polarity.
    input[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
  }

  const inputTensor = Tensor.fromTypedArray(input, [1, INPUT_SIZE, INPUT_SIZE, 1]);
  let topPredictions: Prediction[] = [];
  try {
    const outputs = await activeModel.run([inputTensor]);
    try {
      // Verified in @litertjs/core 2.6.0: data() copies the bytes
      // (HEAPU8.slice) for host tensors, but the reduction still happens
      // before the deletes below, which keeps us safe across versions.
      const scores = (await outputs[0].data()) as Float32Array;
      const indices: number[] = [];
      for (let i = 0; i < scores.length; i++) {
        indices.push(i);
      }
      indices.sort((a, b) => scores[b] - scores[a]);
      topPredictions = indices.slice(0, TOP_K).map((index) => ({
        label: labels[index] ?? `class_${index}`,
        confidence: scores[index],
      }));
    } finally {
      for (const outputTensor of outputs) {
        outputTensor.delete();
      }
    }
  } finally {
    inputTensor.delete();
  }

  return topPredictions;
}
