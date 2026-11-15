# QuickDraw Inference Pipeline

How a drawing becomes a ranked prediction. Covers only the inference path: snapshot
trigger → preprocessing → model execution → post-processing → Top-K guesses.

One important fact frames everything below: **inference never reads the visible canvas.** The
drawing is exported as *vector strokes* (`engine.getStrokes()`), and the preprocessor
re-rasterizes them into a clean 28×28 input. "Canvas snapshot" here means that vector-stroke
capture plus re-render, which makes predictions independent of pen colour, glow effects,
mirroring and device pixel ratio.

## Pipeline Flow Diagram

```
 onStrokes("drawing")                 onStrokes("settled")
 (point appended mid-stroke)          (stroke end / shape / undo / clear)
        │                                     │
        ▼                                     ▼
 predictor.drawing()                   predictor.settled()
 setTimeout ≥ PREDICT_THROTTLE_MS      run() immediately
 (=120 ms) since lastRun                       │
        │                                     │
        └───────────────┬─────────────────────┘
                        ▼
              predictor.run()  ── serialised: running/again flags,
                        │         at most 1 queued re-run;
                        │         generation guard drops stale results
                        ▼
              getStrokes(): Pt[][]   (normalised 0..1, un-mirrored;
                        │            closed shapes repeat first point)
                        ▼
        preprocessor.toInput(strokes)   (preprocess.ts)
          bbox → span=max(w,h,MIN_SPAN) → fit+centre into 236px box
          render white-on-black @ RENDER_SIZE=256, LINE_WIDTH=12
          downscale 256 → MID_SIZE=64 → INPUT_SIZE=28 (high quality)
          R/255 → Float32Array(784)   │   null if nothing drawn
                        ▼             ▼ (null → guesses=[], no inference)
              model.predict(input)    (model.ts)
          new core.Tensor(input, [1,28,28,1])
          compiled.run(tin)  ── LiteRT.js, accelerator:"wasm"
          outs[0].moveTo("wasm") → Float32Array.from(toTypedArray())
          delete: tin, outs, moveTo-copy (finally blocks)
                        ▼
              toProbabilities(out)
          pass through if ≥0 and |Σ−1|≤0.05, else softmax(max-subtracted)
                        ▼
              topK(probs, labels, TOP_K=5)                    → guesses
              topK(probs, labels, TOP_K=5, isWord)            → wordGuesses
          pair prob↔labels[i] → (keep flashcard words) → sort desc → slice(0,5)
                        ▼
        onPrediction({ guesses: Guess[], wordGuesses: Guess[], input: Float32Array|null })
          (generation-checked, then consumed by the caller)
```

## 1. Model & Runtime Initialization

### Assets

| Asset | Location | Notes |
| --- | --- | --- |
| Model | `public/models/quickdraw_model.tflite` | ~8.9 MB, float16 weights / **float32 in-out** (`MODEL_NAME`, `MODEL_URL` in `features/quickdraw/constants.ts`). `MIN_MODEL_BYTES = 1000` catches a Git LFS pointer being served instead of the real file; `fetchModelBytes()` then throws with a `git lfs pull` hint. |
| Labels | `public/models/labels.txt` | `LABELS_URL`; 345 lines. `parseLabels()` (`labels.ts`) accepts the file only when it has exactly `LABEL_COUNT = 345` non-empty lines; otherwise the built-in ASCII-sorted `BUILTIN_LABELS` array is used. Which source won is reported as `labelSource: "labels.txt" \| "built-in"`. |
| LiteRT.js wasm runtime | `public/wasm/` | `WASM_DIR = "/wasm/"`. Not committed — `scripts/copy-litert-wasm.mjs` copies `litert_wasm_internal.{js,wasm}` plus the `compat` (no relaxed-SIMD) pair from `node_modules/@litertjs/core/wasm`; threads/JSPI builds are deliberately omitted. Runs as `predev`/`prebuild`/`postinstall`. |

### Runtime singleton — `features/quickdraw/runtime.ts`

`loadRuntime()` returns a **module-level memoized promise**: `loadLiteRt()` throws if called
twice, so one WebAssembly (CPU) instance is shared by every caller and mount. Inside it:

- `@litertjs/core` is imported dynamically to keep it out of the server render.
- `self.Module = { printErr }` is set before instantiation (Emscripten reads it; the loader
  clears it after). `printErr` reroutes the C++ log's routine `VERBOSE:/INFO:/WARNING:` lines
  to `console.debug` so they don't surface as errors, keeping real errors on `console.error`.
- `core.loadLiteRt(new URL(WASM_DIR, window.location.origin).href)` — absolute URL of the
  self-hosted wasm directory; the loader picks the relaxed-SIMD or compat build itself.
- On failure the memo is cleared (`runtime.catch(() => { runtime = null; })`) so a retry is
  possible.

**Load-order constraint:** the LiteRT runtime must not start bootstrapping while another
Emscripten runtime (the MediaPipe hand tracker that produces the strokes) is still loading —
both use the same globals (`self.ModuleFactory` / `self.Module`) and can trip over each other.
The caller chains them: hand tracker first, then `loadQuickDrawModel(...)`.

### Model load & compile — `features/quickdraw/model.ts#loadQuickDrawModel(onStage?)`

1. `onStage?.("runtime")`, then `Promise.all([loadRuntime(), fetchModelBytes(), fetchLabels()])`.
   `fetchModelBytes()` memoizes the original bytes **once per page** and never mutates them —
   every compile patches a copy.
2. `onStage?.("compiling")`, then
   `core.loadAndCompile(fixBatchSize(original.slice()), { accelerator: "wasm" })`.
3. **Batch-size patch — `features/quickdraw/flatbuffer.ts#fixBatchSize(buf)`:** Keras exports
   declare a dynamic batch (`[-1, 28, 28, 1]`), which LiteRT.js 2.6.0 cannot run (strict shape
   equality on the JS input gate; `-1` dims crash C++ buffer allocation; no resize-input API).
   The patcher walks the TFLite FlatBuffer — `Model.subgraphs` (field 2) → `SubGraph.tensors`
   (field 0) → `Tensor.shape` (field 0) and `Tensor.shape_signature` (field 7) — and rewrites
   each leading `-1` int32 to `1` **in place**. Overwrites are int32→int32, so file size and
   all offsets are unchanged; failures are caught and `console.warn`ed (the file may already be
   static-batch).
4. **Validation:** `compiled.getInputDetails()[0].dtype` must be `"float32"`; anything else
   (e.g. a fully quantized model) is deleted and rejected with an explicit error.
   `inputShape = Array.from(details.shape)` → `[1, 28, 28, 1]` after the patch.

Stage transitions (`"runtime"` → `"compiling"` → `"ready"` | `"error"`) are reported through
`onStage` / the returned object so the UI can show loader progress.

### In-memory lifetime

`loadQuickDrawModel` resolves to a `QuickDrawModel` holding the `CompiledModel`, labels,
`inputShape`, `dtype` and an `inflight` promise tracker. Tensors and the compiled model live in
**wasm memory, outside the JS GC**, so cleanup is explicit:

- Every `run()` deletes its input tensor, all output tensors, and the `moveTo("wasm")` copy in
  `finally` blocks; the probability array is copied out with
  `Float32Array.from(cpu.toTypedArray())` before deletion.
- `dispose()` is idempotent (`disposed` flag) and **never frees the model under a running
  inference**: it waits on `inflight` before `compiled.delete()`. After disposal, `run()`
  throws `"Quick Draw model was disposed"`.

## 2. Snapshot Triggering & Concurrency Control

### Triggers

The stroke engine (`features/air-draw/engine.ts`) fires its `onStrokes` callback on every
drawing mutation, and the caller routes it straight into the predictor:

```ts
onStrokes: state => (state === "drawing" ? predictor?.drawing() : predictor?.settled())
```

| State | Fired when | Predictor entry point |
| --- | --- | --- |
| `"drawing"` | a point is appended to the active stroke (pen moving) | `drawing()` — throttled |
| `"settled"` | stroke end (pen up), two-hand shape placed, `undo()`, `clearAll()` | `settled()` — immediate |

Additionally, `predictor.settled()` is called once right after the model finishes loading, so
anything drawn during the load is judged; and `predictor.reset()` runs whenever the drawing is
wiped for a new round, so a prediction for the old drawing can never be reported against the
new one.

There is **no polling interval** — scheduling is purely event-driven.

### Throttle — `features/quickdraw/predictor.ts`

`drawing()` schedules `run()` with
`setTimeout(run, Math.max(0, lastRun + PREDICT_THROTTLE_MS - performance.now()))`, i.e. at
most one prediction every **120 ms** (`PREDICT_THROTTLE_MS`, `features/quickdraw/constants.ts`)
while a stroke grows. While a timer is pending, further `"drawing"` events are no-ops
(`timer !== undefined` guard). `settled()` bypasses the throttle and calls `run()` immediately
(`run()` clears any pending timer first).

### Concurrency guards (all in `predictor.ts`)

- **Serialization:** a `running` flag ensures only one inference is in flight — required by
  `model.ts#predict` ("calls must not overlap"). If `run()` is called while executing, it sets
  `again = true` instead of starting a second pass; the do/while loop then performs **exactly
  one** queued re-run after the current one finishes (coalescing bursts of events).
- **Staleness guard:** each pass captures `generation` before awaiting; the result is delivered
  only if `gen === generation`. `reset()` bumps the generation, silently dropping anything in
  flight for the previous drawing.
- **Freshness:** each pass re-reads `toInput(getStrokes())` *inside* the loop, so the queued
  re-run classifies the latest strokes, not a snapshot captured before the wait.
- **Empty canvas:** when `toInput` returns `null` (nothing drawn), no inference runs and
  `onPrediction({ guesses: [], input: null })` clears the guesses.
- **Shutdown:** `stop()` sets `stopped`, clears the timer, and suppresses both delivery and
  further passes.
- **Errors** from `toInput`/`predict` go to `onError`, and `running` is released in `finally`
  so the predictor recovers.

## 3. Preprocessing, Inference & Post-Processing

### Stroke capture — `engine.ts#getStrokes()`

Returns `Pt[][]` (`type Strokes = readonly (readonly Point[])[]`, `preprocess.ts`): points in
**un-mirrored video-pixel space** with both axes divided by `max(videoWidth, videoHeight)`, so
coordinates are 0..1 with aspect ratio preserved (only relative layout matters downstream).
Empty strokes are filtered out; closed shapes (`rect`/`tri`) repeat their first point.

### Rasterization — `features/quickdraw/preprocess.ts#createPreprocessor().toInput(strokes)`

Three persistent offscreen contexts are created once per preprocessor
(`OffscreenCanvas` when available, else detached `<canvas>`; the readback one with
`willReadFrequently: true`). Per call:

1. **Bounding box** over all points; empty → return `null`.
2. **Normalize:** `span = max(maxX−minX, maxY−minY, MIN_SPAN)` where `MIN_SPAN = 0.02` floors
   the box so a lone dot doesn't blow up. Scale `k = (RENDER_SIZE − 2·PADDING) / span` fits the
   drawing into a **236 px box** inside a `RENDER_SIZE = 256` canvas
   (`PADDING = LINE_WIDTH/2 + 4 = 10`). With `CENTER = true`, the shorter side additionally
   gets equal margins (centred, aspect-preserving).
3. **Render:** black background (`#000`), white strokes (`#fff`), `LINE_WIDTH = 12` px at 256,
   round caps/joins, one polyline per stroke. A single-point stroke gets a `+0.1 px` `lineTo`
   so it rasterizes as a visible dot. Colour information is discarded by design.
4. **Two-step downscale** with `imageSmoothingQuality = "high"`: 256 → `MID_SIZE = 64` →
   `INPUT_SIZE = 28` (stepping avoids aliasing thin strokes out of existence).
5. **To tensor:** `getImageData(0, 0, 28, 28)`, take the **R channel / 255** into a row-major
   `Float32Array(28*28 = 784)`; `INVERT = false` keeps Quick Draw's convention — stroke = 1.0,
   background = 0.0.

All of the above knobs live in `features/quickdraw/constants.ts` and are fixed (no UI for them).

### Inference — `model.ts#predict(input)` → `probabilities(input)` → `run(input)`

1. `const tin = new core.Tensor(input, inputShape)` with `inputShape = [1, 28, 28, 1]`
   (NHWC, float32).
2. `const outs = await compiled.run(tin)` on the wasm accelerator.
3. `const cpu = await outs[0].moveTo("wasm")` brings the output to host memory;
   `Float32Array.from(cpu.toTypedArray())` **copies** it out of the wasm heap.
4. Cleanup in nested `finally` blocks: `cpu.delete()` (when `cpu !== outs[0]`),
   `outs.forEach(t => t.delete())`, `tin.delete()`.
5. `probabilities()` records the promise in `inflight` (swallowing its rejection) so `dispose()`
   can wait for it.

### Post-processing → ranked guesses

- **`toProbabilities(out)`** (`model.ts`): scans the raw output; if every value is ≥ 0 and the
  sum is within 0.05 of 1, it is already probabilities and passes through. Otherwise it is
  treated as **logits** and softmaxed with max-subtraction for numerical stability
  (`exp(v − max) / Σ exp`).
- **`topK(probs, labels, k = TOP_K, keep?)`** (`model.ts`, `TOP_K = 5`): pairs each probability with
  `labels[i]` (falling back to `` `class ${i}` `` if the label list were short), sorts
  descending by `prob`, and slices the best 5 into `Guess[] = { label: string; prob: number }[]`.
  With a `keep` predicate, only the classes it accepts are ranked; probabilities are not
  renormalised.
- The game ranks each output twice (`AirDraw.tsx`): `guesses` over all 345 classes (the debug
  panel, and the win check) and `wordGuesses` over the 284 classes that are flashcard words (the
  "You drew…" feed, so it never lists a class the game has no word for). The predictor wraps both as
  `Prediction = { guesses: Guess[]; wordGuesses: Guess[]; input: Float32Array | null }` — carrying the exact
  784-value tensor alongside so consumers can render "what the model saw" — and delivers it to
  `onPrediction` only if the generation is still current. `guesses[0]` (label + confidence) is
  the top prediction consumers act on.

### Key inference files

| File | Role in the pipeline |
| --- | --- |
| `features/quickdraw/constants.ts` | Every inference knob: asset URLs, `INPUT_SIZE`/`RENDER_SIZE`/`MID_SIZE`/`LINE_WIDTH`/`PADDING`/`MIN_SPAN`, `CENTER`/`INVERT`, `TOP_K`, `PREDICT_THROTTLE_MS`, `MIN_MODEL_BYTES`. |
| `features/quickdraw/runtime.ts` | Singleton LiteRT.js wasm runtime loader. |
| `features/quickdraw/flatbuffer.ts` | In-place `-1` → `1` batch-dim FlatBuffer patch. |
| `features/quickdraw/labels.ts` | 345-class label list, `labels.txt` parsing, built-in fallback. |
| `features/quickdraw/model.ts` | Fetch/validate/compile, `run` with wasm cleanup, `toProbabilities`, `topK`, `dispose`. |
| `features/quickdraw/preprocess.ts` | Vector strokes → normalized 28×28 `Float32Array` (or `null`). |
| `features/quickdraw/predictor.ts` | Trigger routing, 120 ms throttle, serialization + generation guards. |
| `features/air-draw/engine.ts` | Source of the snapshot: `getStrokes()` export and `onStrokes("drawing"/"settled")` events. |
