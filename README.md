# Langotoon — DurHack 2026

Learn vocabulary by drawing it in the air. Pick a language, see a word, draw the thing with
your finger in front of the webcam, and an on-device model tells you when it recognises it.

The app lives in [`flash-lang-draw/`](flash-lang-draw/) (Next.js 16, React 19, Tailwind 4).

```bash
cd flash-lang-draw
npm install
npm run dev
```

Open http://localhost:3000 (it must be `localhost` or https, or the browser will not give
camera access). `npm install` also copies the doodle model's WebAssembly runtime into
`public/wasm`; see [Doodle recognition](#doodle-recognition).

## How a round works

1. **Start screen.** The camera is on straight away. Pick one of seven languages (Spanish,
   Russian, Polish, Bahasa Indonesia, Telugu, Yoruba, Japanese) with the mouse, or by holding your
   index fingertip over a button until the ring fills.
2. **Flashcard.** A card at the top shows a word in that language, with the English underneath.
3. **Draw it in the air.** Strokes appear over the mirrored camera picture.
4. **Live judging.** Every change to the drawing is classified in the browser. As soon as the
   model's **top guess** is the word on the card, the card turns green ("Correct!") and the next
   word comes up after 1.6 s on a clean canvas.
5. **Skip / leave.** "Skip →" (or `N`) gives up on the word: the card shows what it means in
   English, with a doodle of it from the Quick, Draw! dataset in the middle of the screen, for
   3 s, then the next word comes up ("Next →" or `N` again moves on at once). "← Languages" (or
   `Esc`) goes back to the language list.

### Gestures

| Gesture | What it does |
|---|---|
| 🤏 Pinch thumb and index together, then move | Draw |
| 👈 Fist with the thumb pointing left | Undo |
| 👉 Fist with the thumb pointing right | Redo |
| 👏 Clap your hands (two open hands brought together quickly), or 🫰 snap your fingers | Clear |
| ✋ Hold an open palm still, tilt, then make a fist | Colour wheel: tilt chooses, fist picks |
| Both hands pinch, pull apart, let go | Straight line |
| An "L" with each hand, pull apart, close the hands | Rectangle (snaps to a square when close) |
| An "O" with both hands (index tips and thumb tips touching), pull apart, close | Circle |
| Hold a fingertip over a button | Press it (start screen, back button) |

### Keys

`C` clear · `Z` undo · `Shift+Z` / `Y` redo · `N` skip the word · `Esc` back to languages · `H` show/hide the gesture
hints · `D` show/hide the debug panel (the model's top-5 guesses, the 28×28 image it is
actually fed, and the load status).

## Where things are

```
flash-lang-draw/
  app/                      Next.js entry: the page just renders <AirDraw />
  features/
    air-draw/               AirDraw.tsx (owns UI state, wires everything together)
                            engine.ts   (framework-free: camera, hand tracking, gestures, canvas)
                            constants.ts, GestureHints.tsx
    start-screen/           landing screen with the language buttons and doodle cards
    hand-cursor/            fingertip cursor that dwell-presses [data-hand-target] elements
    languages/              the 7 languages, flag art, and the flashcard word list
    game/                   deck.ts (which word is next, is the drawing correct)
                            GameHud.tsx (flashcard, debug panel)
    quickdraw/              the doodle classifier (see below)
  public/models/            quickdraw_model.tflite (8.9 MB) and labels.txt
  public/wasm/              LiteRT.js runtime — generated, git-ignored
  scripts/
    copy-litert-wasm.mjs    copies the runtime from node_modules into public/wasm
    quickdraw-verify/       dev-only Python check of the model (not part of the app)
  e2e/                      Playwright tests and the mock hand they drive
```

## Hand tracking

MediaPipe Hand Landmarker (`@mediapipe/tasks-vision` 1.2.3) finds up to two hands per frame;
`engine.ts` turns the landmarks into the gestures above with hysteresis and a One Euro filter.
The engine has two modes: `menu` (only the fingertip cursor is reported) and `draw` (the full
gesture set, rendered to the canvas).

The hand tracker's wasm and model are loaded from a CDN (jsdelivr and Google storage), so
**the app as a whole needs a network connection** even though doodle recognition does not.

## Doodle recognition

Runs entirely in the browser with **LiteRT.js (`@litertjs/core` 2.6.0, pinned) on WebAssembly /
CPU**. No server calls, nothing from a CDN. Code is in `features/quickdraw/`:

| File | Job |
|---|---|
| `constants.ts` | Every setting that defines what the model is fed |
| `runtime.ts` | One lazily loaded LiteRT instance per page |
| `flatbuffer.ts` | `fixBatchSize`: the batch-dimension patch |
| `model.ts` | Fetch, patch, compile, check, `predict()`, `dispose()` |
| `preprocess.ts` | Strokes → `Float32Array(784)` |
| `predictor.ts` | Throttled, serialised prediction loop |
| `labels.ts` | The 345 class names and `labels.txt` parsing |

### The model

- [`zarqankhn/quickdraw-345-tflite`](https://huggingface.co/zarqankhn/quickdraw-345-tflite),
  file **`quickdraw_model.tflite` only**: SE-ResNet, about 3M parameters, float16 weights,
  float32 input `[1, 28, 28, 1]`, float32 softmax output `[1, 345]`.
- The fully quantized variant from the same repository is deliberately **not** used, shipped or
  offered. This is enforced in code: after compiling, the input dtype must be `float32` or the
  model is deleted and an error is shown.
- The binary is committed directly (no Git LFS). If it is ever under 1000 bytes it is treated as
  an LFS pointer and reported with a fix.
- **Labels:** `public/models/labels.txt`, 345 lines in ASCII sort order, so the three "The …"
  entries come first. Output index *i* is line *i*. The same list is built in as a fallback and
  a labels file is only accepted with exactly 345 non-empty lines. The upstream
  `categories.txt` is in a different order and must not be used.

### Things that will bite you

- **Batch dimension.** The model was exported from Keras with input shape `[-1, 28, 28, 1]`,
  which LiteRT.js 2.6.0 cannot run (a `[1,…]` tensor is rejected, `[-1,…]` crashes).
  `fixBatchSize` rewrites the leading `-1` of every tensor's `shape` / `shape_signature` to `1`
  in the flatbuffer bytes before compiling, on a copy. If the LiteRT version changes, retest
  this.
- **Two wasm runtimes.** MediaPipe and LiteRT are both Emscripten modules that bootstrap
  through the same globals (`self.ModuleFactory` / `self.Module`). They are loaded one after
  the other (hand tracker first), never at the same time.
- **Console noise.** LiteRT's C++ side logs routine `INFO:` lines to stderr, which Emscripten
  sends to `console.error` and Next's dev overlay then reports. `runtime.ts` routes those lines
  to `console.debug` and leaves real errors alone.
- **Memory.** Tensors and the compiled model live in wasm memory, outside the JS garbage
  collector. Every tensor is deleted after each prediction and the model is disposed on
  unmount.
- **CSP.** If a Content Security Policy is added, it needs `'wasm-unsafe-eval'` in `script-src`
  and must allow `/wasm/` for scripts and fetches.
- **Not used on purpose:** WebGPU, WebNN, threads, JSPI. The input is tiny, and the prototype
  measured roughly 1–20 ms per inference on CPU. Only the default and the compat (no relaxed
  SIMD) wasm builds are copied.

### Preprocessing (fixed; do not "correct" it)

The drawing is re-rendered from its vector strokes, never read back from the visible canvas:

1. Bounding box of all points; `span = max(width, height, 0.02)`.
2. Draw on a 256×256 canvas: black background, white strokes, `lineWidth` 12, round caps and
   joins, 10 px padding, centred.
3. Downscale 256 → 64 → 28 with high-quality smoothing.
4. `value = R / 255`, so **stroke = 1.0, background = 0.0**.

`CENTER = true` and `INVERT = false` are named constants with no UI. The model card says the
opposite polarity (white background, black strokes). **The model card is wrong**, as measured
below. Two-hand rectangles and circles are fed as closed outlines.

### Verification

`scripts/quickdraw-verify/verify.py` runs the same `.tflite` in the reference Python
interpreter on real Quick Draw bitmaps. Last run: 2,050 drawings from 41 categories.

| Input polarity | Top-1 | Top-5 |
|---|---|---|
| As-is: white strokes on black (what the app sends) | 76.3% | 93.7% |
| Inverted: black strokes on white (what the model card says) | 1.4% | 4.6% |

The author's own figures are 76.4% / 92.3%, so the as-is result reproduces them. The script
also writes `e2e/fixtures/quickdraw-parity.json`; a test replays that input through the browser
implementation and checks the 345 outputs match Python to within 1e-3.

```bash
cd flash-lang-draw
python3 -m venv .venv && .venv/bin/pip install -r scripts/quickdraw-verify/requirements.txt
.venv/bin/python scripts/quickdraw-verify/verify.py --categories 40 --samples 50
```

It only downloads the first few samples of each category (HTTP range requests).

## Words

`features/languages/words.ts` holds 284 drawable words in all seven languages. Each word is one
of the model's 345 Quick Draw classes; the other 61 classes (the Eiffel Tower, squiggle, …) have
no entry, so they are never dealt and never listed in the "You drew…" guess feed, which ranks the
model's guesses among the 284 words only. (The `D` debug panel still shows the model's own top 5.) Each word has a
`labels` list (the Quick Draw classes that count as that word) and a `t` object with the word
in each language, keyed by language code. `features/game/deck.ts` deals every word once,
shuffled, before any repeats.

The languages are listed in `features/languages/languages.ts`, and each has a flag in
`features/languages/Flag.tsx` (Telugu uses India's, Yoruba uses Nigeria's). Spanish words carry
their article, Japanese is written in kana, and Yoruba is written with tone marks. Many Yoruba
(and some Telugu) words for modern objects are loanwords or descriptive phrases; they have not
been checked by a native speaker.

`public/doodles/quickdraw.json` holds one doodle per word, shown when the word is skipped
(`features/game/SkipDoodle.tsx`). They are real drawings from Google's
[Quick, Draw! dataset](https://github.com/googlecreativelab/quickdraw-dataset) (CC BY 4.0): for
each word, the one of its first 30 recognised samples that this app's model is most sure about.
Each stroke is stored as an SVG path in the dataset's 0–255 coordinate space.

To add a word: add a row with its translations and one or more class names from
`features/quickdraw/labels.ts`, and a doodle for its first class in `quickdraw.json`. To add a language: add it to `LANGUAGES`, give it a flag, and
add its code to every word's `t`. Tests fail if a label does not exist, if two words claim the
same label, or if a word is missing a language.

## Tests

```bash
cd flash-lang-draw
npm run lint
npm run test:e2e
```

33 Playwright tests in headless Chromium, on a test build (`NEXT_PUBLIC_AIR_DRAW_TEST=1`, port
3111, its own `.next-e2e` build folder so it can run next to `npm run dev`):

- `e2e/air-draw.spec.ts` — gestures, colour wheel, two-hand shapes, the hand-pressed start
  screen and back button, and one test that loads the real MediaPipe model (needs network).
- `e2e/quickdraw.spec.ts` — the batch-size patch on a hand-built flatbuffer and on the real
  model, labels and scoring, self-hosted loading with no cross-origin requests, preprocessing
  (centring and polarity on the 28×28 output), parity with Python, no wasm memory growth over
  1,500 predictions and repeated load/dispose, and full rounds of the game.

There is no real hand in the tests. `e2e/support/mock-hand.ts` replaces MediaPipe with a
landmarker that returns scripted synthetic hands; the doodle model is the real one. In test
builds `window.__airDraw` and `window.__quickDraw` expose state, and `window.__gameDeck` fixes
the words dealt.

## Known gaps

- **Never tried with a real hand and camera.** Everything above was verified with a mocked
  hand. How well shaky air-drawn doodles are recognised is unknown; press `D` in the game to
  see what the model sees.
- A 12 px line on the 256 canvas ends up about 1.3 px wide at 28×28, thinner and dimmer than
  the bitmaps the model was trained on. If recognition of real drawings is weak, `LINE_WIDTH`
  is the first thing to look at (it was specified, so it has not been changed).
- Hand tracking still depends on a CDN.
- The translations were not reviewed by native speakers (see [Words](#words)).

## Branches and history

| Branch | What it is |
|---|---|
| `main` | Everything below, merged |
| `MatthewSole` | Air Draw engine and the first start screen; where the classifier and game were integrated |
| `greta` | Flashcard UI, language picker, hand cursor, colour wheel, two-hand shapes |
| `quickdraw-test` | Earlier standalone classifier prototype at `app/quickdraw-test/` |

How `main` was assembled:

1. Next.js scaffold, then the Quick Draw `labels.txt`.
2. Air Draw (hand tracking, draw / undo / clear gestures) and the animated start screen.
3. The doodle classifier described above, built from a written spec plus a standalone prototype.
   Only the model binary was taken from `quickdraw-test`.
4. `greta` merged twice. Her UI replaced the first in-game UI: her flashcard took the place of a
   plain word pill, and her colour wheel took the place of an on-screen swatch palette. Her
   12-word multilingual list replaced a 345-word Spanish-only list.

Notes on `quickdraw-test`, for anyone who checks it out:

- It branched from `main` before Air Draw, so its home page is the default Next.js template.
- Its classifier feeds the model black strokes on a white background, read from the visible
  canvas — the polarity measured at 1.4% above. It also commits all four wasm builds. It is
  superseded by `features/quickdraw/` and should not be merged.
- Its `package.json` differs, so run `npm install` after switching to it and again after
  switching back.

An idea that was started and stopped: training a tiny 10-word model (apple, banana, car, fish,
house, moon, star, sun, tree, umbrella) on Quick Draw stroke data with added wobble, to run in
plain TypeScript. Only a Python environment was created (`flash-lang-draw/training/.venv`,
local and git-ignored); no data was downloaded and nothing was trained. The pretrained
345-class model was used instead.

## Notes for AI agents working here

- `flash-lang-draw/AGENTS.md` is generated by `next dev` and says this Next.js version differs
  from older ones; read `node_modules/next/dist/docs/` before using Next APIs.
- Do not change `CENTER`, `INVERT`, the model file, or the label order without re-running
  `verify.py` and the parity test.
- Do not commit `public/wasm/`, `.next-e2e/`, `training/.venv/` or `node_modules/`.
