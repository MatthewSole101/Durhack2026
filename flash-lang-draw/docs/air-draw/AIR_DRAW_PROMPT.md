# Prompt for Claude Code: add "Air Draw" (AR hand-gesture drawing over the webcam)

Implement an augmented-reality drawing feature in this project. The user draws in the air over their own mirrored webcam feed using hand gestures. Hand tracking uses Google MediaPipe **Hand Landmarker** running fully in the browser. Before you start, read this whole spec, then look at how this project is structured (framework, bundler, where components live) and fit the feature into it. A working single-file reference implementation exists (`hand-landmarker.html`). If it's in the repo, treat it as ground truth for behaviour and thresholds.

---

## 1. What the user experiences

1. A start screen explains the three gestures and has a **Start camera** button. It stays disabled with the text "Loading model…" until the model has loaded.
2. After the click, the start screen disappears. The **mirrored** webcam feed fills the whole viewport (cover-fit, no letterboxing). A thin white hand skeleton is drawn over each detected hand.
3. Gestures:
   - **☝️ Draw:** index finger extended, with the **thumb, middle, ring and pinky all curled/tucked**. While the pose is held, the index fingertip draws a line. Opening or relaxing the hand lifts the pen. Either hand can draw, and both hands can draw at the same time.
   - **🤏🤏 Undo:** two quick thumb-to-index pinches on the same hand remove the most recent stroke. If the last action was a clear, undo restores the cleared drawing.
   - **👋 Clear:** a quick flick or swipe of an **open** hand wipes the drawing.
4. One fixed pen colour, `#4fd1c5` (soft teal), with a slight glow, at a fixed width. There are **no settings, colour pickers, size sliders or on-screen buttons** once drawing starts.
5. A small pill toast at top-centre briefly confirms actions ("↩ Undo", "↩ Restored", "✨ Cleared", "Nothing to undo") for about 0.9 s.
6. Keyboard fallbacks: `C` clears and `Z` undoes.
7. A filled teal dot with a white outline marks the pen tip while drawing. A small white ring appears between the thumb and index tips while pinching.

---

## 2. Dependencies

- `@mediapipe/tasks-vision` version **1.2.3** (npm). Import `FilesetResolver` and `HandLandmarker`. If the project has a bundler, install it from npm. Otherwise import it from the CDN:
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs`
- WASM fileset base path: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm`. You can self-host this by copying `node_modules/@mediapipe/tasks-vision/wasm` into the static assets.
- Model: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`. Self-host it if the app has a strict CSP or needs to work offline.
- No other libraries. Rendering is plain Canvas 2D.

Create the landmarker like this:

```js
const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
const opts = delegate => ({
  baseOptions: { modelAssetPath: MODEL_URL, delegate },
  runningMode: "VIDEO", numHands: 2,
  minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
});
try { landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU")); }
catch { landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU")); } // WebGL fallback
```

Camera: `getUserMedia({ video: { width:{ideal:1280}, height:{ideal:720}, facingMode:"user" }, audio:false })`. Wait for `loadedmetadata` before calling `video.play()`, and only then hide the start screen. If the camera fails, show the error with a hint that the page must be served over **https or http://localhost**.

---

## 3. Architecture

- One `<video>` element as the frame source, and one full-viewport `<canvas>` that draws **everything**: the video frame, strokes, skeleton and cursors. Drawing everything on one canvas keeps all coordinates in a single space.
- The `<video>` must **not** be `display:none`, because some browsers stop decoding hidden video. Keep it in the DOM but invisible: `position:fixed; width:2px; height:2px; opacity:0; pointer-events:none`.
- The canvas is sized to `innerWidth*devicePixelRatio × innerHeight*devicePixelRatio`, with `ctx.setTransform(dpr,0,0,dpr,0,0)` so all drawing is in CSS pixels. Resize it on window `resize`.
- A `requestAnimationFrame` loop:
  1. Run detection only when `video.currentTime` has changed: `landmarker.detectForVideo(video, performance.now())`. The timestamp must increase on every call.
  2. Process gestures for that result.
  3. Draw the mirrored video, then the strokes, then the hands and cursors.
  4. Wrap detection and processing in `try/catch`, and show errors in a visible red banner rather than letting the loop die silently.
- **Pitfall that actually happened:** if you hide overlays with the `hidden` attribute, add `[hidden]{display:none !important}`. Otherwise a CSS rule like `display:flex` on the overlay overrides `hidden`, and the start screen never disappears. The camera turns on but the user sees nothing change.

---

## 4. Coordinate system

MediaPipe landmarks are normalised (`x,y ∈ [0,1]` of the video frame, with `z` on roughly the same scale as `x`). Convert them to **video pixels** for all gesture maths and stroke storage. Map to the screen only when rendering.

```js
function fit() {                     // cover-fit the video into the viewport
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(W / vw, H / vh), dw = vw * s, dh = vh * s;
  return { vw, vh, s, dw, dh, ox: (W - dw) / 2, oy: (H - dh) / 2 };
}
const px = (f, p) => [p.x * f.vw, p.y * f.vh];                 // 2D video px
const p3 = (f, p) => [p.x * f.vw, p.y * f.vh, p.z * f.vw];     // 3D video px (z scaled like x)
const toScreen = (f, x, y) => [f.ox + f.dw - x * f.s, f.oy + y * f.s];   // MIRRORED screen px
```

Draw the video mirrored:

```js
ctx.save(); ctx.translate(f.ox + f.dw, f.oy); ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, f.dw, f.dh); ctx.restore();
```

Store stroke points in un-mirrored **video pixels**, so the drawing stays aligned after window resizes. Scale line width by `f.dh / 720`.

---

## 5. Per-hand state and identity tracking

MediaPipe can return hands in a different order from frame to frame. Keep one **slot** object per physical hand and match slots to detections by **nearest wrist position** (landmark 0):

- 2 hands, 2 slots: compare the total wrist distance with the current pairing against the swapped pairing, and swap if that's cheaper.
- 1 hand, 2 slots: keep the nearer slot. End the other slot's stroke.
- 2 hands, 1 slot: give the existing slot to the nearer hand and create a new slot for the other.
- 0 hands: end all strokes.

Slot fields: `wrist, pointFrames, relaxFrames, pointing, stroke, fx, fy (One Euro filters), pinched, pinchStart, lastTapEnd, idxExt, thumbIn, curled{middle,ring,pinky}, trail[], tip`.

---

## 6. Gesture algorithms

Landmark indices: wrist 0. Thumb 1–4 (tip 4). Index MCP 5, PIP 6, tip 8. Middle 9/10/12. Ring 13/14/16. Pinky 17/18/20. All distances are 3D, using `p3`.

**Palm size** = `dist(wrist, middle MCP 9)`. It makes the thresholds independent of how far the hand is from the camera.

### 6.1 Finger extended or curled

`extScore(finger) = dist(wrist, tip) / dist(wrist, PIP)`. A straight finger scores about 1.3–1.5; a curled finger about 0.7–0.95. Every state uses **hysteresis**, meaning different thresholds for turning on and turning off, so states don't flicker:

- Index extended: turns on when `> 1.15`, stays on while `> 1.05`.
- Middle, ring and pinky curled: turn on when `< 1.0`, stay on while `< 1.1`.
- `openCount` = how many of index, middle, ring and pinky have `extScore > 1.15`. Used by the flick gesture.

### 6.2 Thumb tucked

`thumbR = min(dist(thumbTip4, lm[i]) for i in [5, 6, 9, 10]) / palm`, i.e. the thumb tip's distance to the nearest index or middle knuckle or the middle PIP.
Thumb counts as tucked when `thumbR < 0.55`, and stays tucked while `< 0.70`.

### 6.3 Pinch

`pinchR = dist(thumbTip4, indexTip8) / palm`. Pinch turns on when `< 0.30`, and stays on while `< 0.45`.

### 6.4 Draw (pointing pose) with debounce

```
pose = idxExt && thumbIn && curled.middle && curled.ring && curled.pinky && !pinched
```

- Count consecutive frames with and without the pose. The pen goes down (`pointing = true`) after **3** frames with the pose. It goes up after **3** frames without it, which also ends the current stroke.
- Smooth the index tip (landmark 8, in video px) with a **One Euro filter** per axis (`minCutoff 1.5, beta 0.01, dCutoff 1`), timed with the detection timestamp. Reset the filters when a stroke ends.
- While `pointing && pose`: create a stroke if none is active, and append the smoothed point if it's more than 1.5 px from the last point.
- If a stroke ends with zero points, delete it and its history entry.

One Euro filter:

```js
class OneEuro {
  constructor(minCutoff=1.5, beta=0.01, dCutoff=1){ Object.assign(this,{minCutoff,beta,dCutoff}); this.reset(); }
  reset(){ this.x=null; this.dx=0; this.t=null; }
  alpha(c,dt){ const tau=1/(2*Math.PI*c); return 1/(1+tau/dt); }
  filter(x,t){
    if(this.x===null){ this.x=x; this.t=t; return x; }
    const dt=Math.max((t-this.t)/1000,1e-3); this.t=t;
    this.dx += this.alpha(this.dCutoff,dt)*((x-this.x)/dt - this.dx);
    this.x  += this.alpha(this.minCutoff+this.beta*Math.abs(this.dx),dt)*(x-this.x);
    return this.x;
  }
}
```

### 6.5 Double pinch: undo

Track this per hand, on pinch transitions:
- Pinch starts: record `pinchStart = t`.
- Pinch releases: `dur = t - pinchStart`.
  - If `dur ≤ 450 ms`, it's a tap. If `pinchStart - lastTapEnd ≤ 550 ms`, call **undo()** and reset `lastTapEnd`. Otherwise set `lastTapEnd = t`.
  - If the pinch was longer than that, reset `lastTapEnd`, because a long pinch isn't a tap.

### 6.6 Flick: clear

- Every frame, push `{t, x, y, open}` onto the slot's `trail`.
  - `x, y` = mean of all 21 landmarks, normalised by **video width** (use `y * vh / vw` so both axes share the same units).
  - `open = openCount >= 3`.
- Keep only the last **220 ms** of the trail.
- Trigger **clearAll()** when all of these hold:
  - the trail has at least 3 samples;
  - the straight-line distance from the oldest to the newest sample is greater than **0.16** of the frame width, in any direction;
  - at least 50% of the trail samples are `open`;
  - at least **1200 ms** have passed since the last flick (shared across hands).
- After a flick, empty the trail.
- Requiring an open hand is what stops fast drawing strokes from clearing the screen.

---

## 7. Undo and clear history

- `strokes[]`: `{ pts: [[x,y],…], active }`.
- `history[]`: either `{type:"stroke", stroke}`, pushed when a stroke **begins**, or `{type:"clear", saved: strokes.splice(0)}`.
- `undo()`: walk `history` from the end, skipping strokes that are still `active` (being drawn right now).
  - A stroke entry: remove that stroke from `strokes`, and toast "↩ Undo".
  - A clear entry: push the saved strokes back, and toast "↩ Restored".
  - If there's nothing to undo, toast "Nothing to undo".
- `clearAll()`: end all active strokes. If any strokes exist, push a clear entry and toast "✨ Cleared".

---

## 8. Rendering details

- Strokes: `lineCap/lineJoin = "round"`, colour `#4fd1c5`, `lineWidth = 8 * f.dh/720`, `shadowColor` set to the same teal with `shadowBlur = lineWidth*1.2` for the glow.
  - Draw a smoothed path: `quadraticCurveTo` each point, ending at the midpoint between it and the next point.
  - A stroke with a single point is drawn as a filled dot.
  - Reset `shadowBlur` to 0 afterwards.
- Skeleton: `HandLandmarker.HAND_CONNECTIONS` (an array of `{start,end}`). Lines are `rgba(255,255,255,.55)` at width 2; joints are `rgba(255,255,255,.8)` dots with radius 2.5.
- Pen cursor: draw it at the **smoothed** tip while `pointing`. Teal fill, 2 px white outline, radius `max(lineWidth/2+3, 6)`.
- Pinch ring: white circle, radius 12, at the midpoint between landmarks 4 and 8 while pinched.

---

## 9. Constants (keep them together at the top so they're easy to tune)

```js
const PEN_COLOR = "#4fd1c5", PEN_SIZE = 8;
const EXT_ON = 1.15, EXT_OFF = 1.05, CURL_MAX = 1.0, CURL_OFF = 1.1;
const THUMB_CLOSED = 0.55, THUMB_OPEN = 0.70;
const POSE_FRAMES = 3;
const PINCH_ON = 0.30, PINCH_OFF = 0.45, TAP_MAX_MS = 450, DOUBLE_GAP_MS = 550;
const FLICK_WINDOW_MS = 220, FLICK_DIST = 0.16, FLICK_COOLDOWN_MS = 1200;
```

---

## 10. How to verify (do this. Don't just eyeball the code)

There's no real hand available in an automated environment, so test the gesture logic with a **mock landmarker**:

1. Serve the page with Playwright or Puppeteer in headless Chrome, launched with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.
2. Intercept the `vision_bundle.mjs` request (or swap the module in tests) and return a mock that exports:
   - `FilesetResolver.forVisionTasks` (async, returns `{}`);
   - `HandLandmarker.HAND_CONNECTIONS`;
   - `HandLandmarker.createFromOptions`, which returns an object whose `detectForVideo(video, t)` returns scripted landmarks according to elapsed time.
3. Build synthetic hands:
   - Wrist below the middle MCP.
   - **Extended** finger: PIP, DIP and tip in a straight line above the MCP.
   - **Curled** finger: PIP slightly above the MCP and the tip folded back down below it (negative `z`).
   - **Thumb out**: tip well to the side.
   - **Thumb tucked**: tip next to the middle MCP with negative `z`.
   - **Pinch**: thumb tip on the index tip.
4. Expose `strokes` and the toast messages on `window` in the test build only, and assert this sequence:
   1. Point with thumb tucked while moving: 1 stroke.
   2. Point with thumb **out**: no new stroke.
   3. Point with thumb tucked again: 2 strokes.
   4. Double pinch: 1 stroke, plus the "↩ Undo" toast.
   5. Open hand travelling 0.35 frame-widths in 150 ms: 0 strokes, plus the "✨ Cleared" toast.
   6. Double pinch again: strokes restored, plus the "↩ Restored" toast.
5. Also check that the start screen is hidden after clicking Start, and that no page errors are logged.

Adapt the file layout, component boundaries and styling to this codebase's conventions, but keep the behaviour, thresholds and gesture logic exactly as specified above.
