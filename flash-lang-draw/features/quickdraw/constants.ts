// Quick Draw classifier settings. Everything that defines what the model is fed lives here.

// Self-hosted: public/wasm is filled from node_modules by scripts/copy-litert-wasm.mjs,
// public/models is committed. Nothing is fetched from a CDN, so recognition works offline.
export const WASM_DIR = "/wasm/";
export const MODEL_NAME = "quickdraw_model.tflite"; // float16 weights, float32 in/out — the only supported model
export const MODEL_URL = `/models/${MODEL_NAME}`;
export const LABELS_URL = "/models/labels.txt";

/** A Git LFS pointer is ~132 bytes of text; the real model is ~8.9 MB. */
export const MIN_MODEL_BYTES = 1000;

// ---- input settings: fixed on purpose, there is no UI for them ----
/** Centre the drawing in the input image (the shorter side gets equal margins). */
export const CENTER = true;
/** false = white strokes (1.0) on a black background (0.0), like Quick Draw's numpy bitmaps. */
export const INVERT = false;

export const INPUT_SIZE = 28; // model input is [1, 28, 28, 1]
export const RENDER_SIZE = 256; // strokes are rasterised here first…
export const MID_SIZE = 64; // …then downscaled 256 → 64 → 28
export const LINE_WIDTH = 12; // px on the 256 canvas
export const PADDING = LINE_WIDTH / 2 + 4; // 10 px → the drawing is fitted into a 236 px box
export const MIN_SPAN = 0.02; // floor for the bounding-box size, so a dot doesn't blow up

export const TOP_K = 5;
export const PREDICT_THROTTLE_MS = 120; // while a stroke is being drawn
