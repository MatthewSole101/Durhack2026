// Air Draw engine: hand tracking, gesture recognition and Canvas 2D rendering.
// Framework-free on purpose — AirDraw.tsx owns the DOM and UI state, this owns the frame loop.
//
// Gestures (draw mode):
//   one hand   🤏 pinch to draw · 👈 thumb left = undo · 👉 thumb right = redo
//              👋 flick an open hand to the left to clear · ✋ hold an open palm still for the colour wheel
//   two hands  line (pinch both at once) · rectangle (an L with each hand; the L corners are
//              opposite corners) · circle (make an O with both hands — index tips together on
//              top, thumb tips together underneath — then pull apart to grow it).
//              Move the hands to place / size the shape, let go to drop it.
//
// Each tracked hand lives in a Slot. A hand that drops out of tracking (partly off-screen,
// motion blur) is remembered for HAND_MEMORY_MS with everything it was doing — stroke, pinch,
// shape — and a detection that reappears near it picks that back up.

import type { HandLandmarker, HandLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  ACTION_COOLDOWN_MS, CIRCLE_ARM_MS, CIRCLE_HOLE, CIRCLE_TOUCH, CIRCLE_SEGMENTS, CURL_MAX, CURL_OFF, DRAW_ARM_MS, EXT_OFF, EXT_ON,
  FLICK_COOLDOWN_MS, FLICK_DIST, FLICK_OPEN_SHARE, FLICK_PEAK_SPEED, FLICK_STRAIGHT, FLICK_WINDOW_MS,
  HAND_MATCH, HAND_MEMORY_MS, LINE_ARM_MS, LINE_SYNC_MS, MIN_HAND_DETECTION, MIN_HAND_PRESENCE, MIN_TRACKING, MODEL_URL,
  PALETTE, PEN_BRIDGE, PEN_COLOR, PEN_DOWN_MS, PEN_SIZE, PEN_UP_MS, PINCH_MIN_INDEX, PINCH_OFF, PINCH_ON,
  RECT_HOLD_MS, RECT_MIN_GAP, SHAPE_COOLDOWN_MS, SHAPE_MIN_PX, SHAPE_RELEASE_MS, SQUARE_SNAP, THUMB_AXIS_DEG,
  THUMB_CLOSED, THUMB_HOLD_MS, THUMB_OPEN, THUMB_POINT_EXT, THUMB_REARM_MS, WASM_BASE,
  WHEEL_HOLD_MS, WHEEL_PICK_MS, WHEEL_SPAN_DEG, WHEEL_STILL, WHEEL_UPRIGHT_DEG,
} from "./constants";

type Vision = Pick<typeof import("@mediapipe/tasks-vision"), "FilesetResolver" | "HandLandmarker">;
type Pt = [number, number];
type Pt3 = [number, number, number];
type Fit = { vw: number; vh: number; s: number; dw: number; dh: number; ox: number; oy: number };
type ShapeKind = "line" | "rect" | "circle";
// pts in un-mirrored video px; `shape` strokes are straight-edged polygons (rect / circle closed)
type Stroke = { pts: Pt[]; active: boolean; color: string; shape?: ShapeKind };
type HistoryEntry = { type: "stroke"; stroke: Stroke } | { type: "clear"; saved: Stroke[] };
type Finger = "index" | "middle" | "ring" | "pinky";
// x, y: fingertips (a wrist flick moves them much more than the palm), frame-width units
type TrailPt = { t: number; x: number; y: number; open: boolean; pinched: boolean };
type Slot = {
  lm: NormalizedLandmark[]; // latest landmarks (the remembered ones while not live)
  live: boolean; // seen in the latest frame
  lastSeen: number;
  wrist: Pt; vel: Pt; // video px, px per ms (for re-matching after a dropout)
  palm: number; // wrist → middle knuckle, video px (3D), smoothed
  ext: Record<Finger, boolean>; curled: Record<Finger, boolean>; thumbIn: boolean;
  othersOpen: number; // how many of middle / ring / pinky are extended
  pinched: boolean; pinchSince: number;
  openSince: number; openFor: number; // current release: first frame seen open, and how long it has been seen open
  penBlocked: boolean; // a pinch that was part of a shape must be released before it can draw
  pen: Pt; penF: [OneEuro, OneEuro]; // pinch point (between thumb and index tips), filtered
  tips: { thumb: Pt; index: Pt }; // raw 2D fingertips
  arc: Pt; arcF: [OneEuro, OneEuro]; // middle of the curve the thumb and index make (one side of an O), filtered
  cupped: boolean; // thumb and index curved apart with a gap between them, like half an O
  corner: Pt; cornerF: [OneEuro, OneEuro]; // where the thumb and index lines of an L meet, filtered
  stroke: Stroke | null; strokePinch: number; // the pinch (its pinchSince) that is drawing it
  openPalm: boolean; fist: boolean; lPose: boolean; openish: boolean;
  thumbDir: -1 | 0 | 1; // thumb pointing left / right (on screen) out of a fist
  thumbPose: -1 | 0 | 1; thumbSince: number; thumbSeen: number; thumbFired: boolean;
  still: { x: number; y: number; t: number } | null; // where an open palm started holding still
  trail: TrailPt[]; // recent fingertip positions, for the flick
};
type Wheel = { slot: Slot; theta: number; idx: number; fistSince: number; center: Pt; radius: number };
type Shape = { kind: ShapeKind; a: Slot; b: Slot; pts: Pt[]; handles: Pt[]; offSince: number | null };

// Test builds only (NEXT_PUBLIC_AIR_DRAW_TEST=1): a mock landmarker can be injected and state is observable.
const TEST_BUILD = process.env.NEXT_PUBLIC_AIR_DRAW_TEST === "1";
type TestHook = {
  strokes: Stroke[]; toasts: string[];
  screenToVideo: (x: number, y: number) => Pt;
  penColor: string; wheel: number | null; shape: ShapeKind | null;
  /** hands being tracked: [live, remembered] */
  hands: [number, number];
};
type TestWindow = Window & { __airDrawMock?: Vision; __airDraw?: TestHook };

const FINGERS = { index: [6, 8], middle: [10, 12], ring: [14, 16], pinky: [18, 20] } as const; // pip, tip
const FINGER_NAMES = Object.keys(FINGERS) as Finger[];
const DEG = Math.PI / 180;
const THUMB_AXIS_TAN = Math.tan(THUMB_AXIS_DEG * DEG);

// One Euro filter: smooths jitter when slow, follows closely when fast
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(private minCutoff = 1.2, private beta = 0.012, private dCutoff = 1) {}
  reset() { this.x = null; this.dx = 0; this.t = 0; }
  private alpha(cutoff: number, dt: number) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  filter(x: number, t: number) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max((t - this.t) / 1000, 1e-3); this.t = t;
    const dx = (x - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}
const filterPair = (): [OneEuro, OneEuro] => [new OneEuro(), new OneEuro()];
const applyPair = ([fx, fy]: [OneEuro, OneEuro], p: Pt, t: number): Pt => [fx.filter(p[0], t), fy.filter(p[1], t)];

const toScreen = (f: Fit, x: number, y: number): Pt => [f.ox + f.dw - x * f.s, f.oy + y * f.s]; // mirrored
const px = (f: Fit, p: NormalizedLandmark): Pt => [p.x * f.vw, p.y * f.vh];
const p3 = (f: Fit, p: NormalizedLandmark): Pt3 => [p.x * f.vw, p.y * f.vh, p.z * f.vw]; // z is on the same scale as x
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0));
const dist2 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** On-screen tilt of the hand in degrees: 0 = fingers up, + = leaning right (as the user sees it). */
function handTilt(f: Fit, lm: NormalizedLandmark[]) {
  const [wx, wy] = px(f, lm[0]), [mx, my] = px(f, lm[9]);
  return Math.atan2(-(mx - wx), -(my - wy)) / DEG; // x negated: the view is mirrored
}

/** Palm centre in frame-width units (both axes), for motion that doesn't care about the fingers. */
function palmCentre(f: Fit, lm: NormalizedLandmark[]): Pt {
  let x = 0, y = 0;
  for (const i of [0, 5, 9, 13, 17]) { x += lm[i].x / 5; y += lm[i].y / 5; }
  return [x, y * f.vh / f.vw];
}

/** Corner of an L hand: where the line along the thumb meets the line along the index finger. */
function lCorner(f: Fit, lm: NormalizedLandmark[], palm: number): Pt {
  const a = px(f, lm[2]), b = px(f, lm[4]), c = px(f, lm[5]), d = px(f, lm[8]);
  const web = mid(a, c); // fallback: the web between thumb and index
  const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 0.5 * Math.hypot(r[0], r[1]) * Math.hypot(q[0], q[1])) return web; // < 30° apart: no clear corner
  const u = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den;
  const x: Pt = [a[0] + u * r[0], a[1] + u * r[1]];
  return dist2(x, web) < 0.8 * palm ? x : web;
}

function newSlot(lm: NormalizedLandmark[], wrist: Pt, t: number): Slot {
  const none = { index: false, middle: false, ring: false, pinky: false };
  return {
    lm, live: true, lastSeen: t, wrist, vel: [0, 0], palm: 0,
    ext: { ...none }, curled: { ...none }, thumbIn: false, othersOpen: 0,
    pinched: false, pinchSince: 0, openSince: t, openFor: Infinity, penBlocked: false,
    pen: [0, 0], penF: filterPair(), tips: { thumb: [0, 0], index: [0, 0] }, arc: [0, 0], arcF: filterPair(), cupped: false, corner: [0, 0], cornerF: filterPair(),
    stroke: null, strokePinch: 0,
    openPalm: false, fist: false, lPose: false, openish: false,
    thumbDir: 0, thumbPose: 0, thumbSince: 0, thumbSeen: -1e9, thumbFired: false,
    still: null, trail: [],
  };
}

// One landmarker per page, shared across mounts: the model is heavy, and React StrictMode
// mounts effects twice in dev — building (and tearing down) a second GL graph stalls the first.
type Shared = { landmarker: HandLandmarker; connections: { start: number; end: number }[] };
let sharedLandmarker: Promise<Shared> | null = null;

function loadLandmarker(): Promise<Shared> {
  sharedLandmarker ??= (async () => {
    const mock = TEST_BUILD ? (window as TestWindow).__airDrawMock : undefined;
    const vision: Vision = mock ?? (await import("@mediapipe/tasks-vision"));
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
    const opts = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO" as const, numHands: 2,
      minHandDetectionConfidence: MIN_HAND_DETECTION,
      minHandPresenceConfidence: MIN_HAND_PRESENCE,
      minTrackingConfidence: MIN_TRACKING,
    });
    let landmarker: HandLandmarker;
    try { landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts("CPU")); } // WebGL fallback
    // The first inference compiles shaders and can block the page for a while. Pay that cost
    // here, under "Loading model…", rather than as a freeze right after the camera starts.
    try {
      const blank = document.createElement("canvas");
      blank.width = blank.height = 64;
      blank.getContext("2d")!.fillRect(0, 0, 64, 64);
      landmarker.detectForVideo(blank, performance.now());
    } catch { /* warm-up is best-effort */ }
    return { landmarker, connections: vision.HandLandmarker.HAND_CONNECTIONS };
  })();
  sharedLandmarker.catch(() => { sharedLandmarker = null; }); // allow a retry after a failed load
  return sharedLandmarker;
}

/** Screen position (CSS px) of the index fingertip, or null when no hand is in view. */
export type Pointer = { x: number; y: number } | null;

/**
 * "menu": track the fingertip and report it through onPointer; nothing is drawn.
 * "draw": the full gesture set, rendered to the canvas (the fingertip is still reported).
 */
export type AirDrawMode = "menu" | "draw";

export type AirDrawOptions = {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  onToast: (msg: string) => void;
  onError: (msg: string) => void;
  onPointer?: (p: Pointer) => void;
  /** The drawing changed: "drawing" while a stroke grows, "settled" on stroke end, shape, undo, redo and clear. */
  onStrokes?: (state: "drawing" | "settled") => void;
};

export type AirDrawEngine = {
  /** Download the WASM runtime + model. Resolves when the landmarker is ready. */
  load: () => Promise<void>;
  /**
   * Ask for the camera and begin the frame loop (tracking starts once the model is loaded).
   * Safe to call repeatedly. Resolves with the live stream; rejects if the camera is unavailable.
   */
  start: () => Promise<MediaStream>;
  /** Switching to "draw" starts a fresh, empty canvas. */
  setMode: (mode: AirDrawMode) => void;
  undo: () => void;
  redo: () => void;
  clearAll: () => void;
  /**
   * The drawing as the player sees it (mirrored), one point list per stroke; closed shapes
   * repeat their first point. Both axes are divided by the same number, so the aspect ratio
   * is kept and every coordinate is in 0..1.
   */
  getStrokes: () => Pt[][];
  /** Wipe the drawing and its undo history without any feedback (the next word starts). */
  reset: () => void;
  destroy: () => void;
};

export function createAirDraw({ video, canvas, onToast, onError, onPointer, onStrokes }: AirDrawOptions): AirDrawEngine {
  const ctx = canvas.getContext("2d")!;
  // finished ink is rendered once into this layer; only strokes in progress are redrawn each frame
  const ink = document.createElement("canvas");
  const inkCtx = ink.getContext("2d")!;
  let inkKey = ""; // layout the layer was drawn for; anything else means redraw

  let landmarker: HandLandmarker | null = null;
  let connections: { start: number; end: number }[] = [];
  let stream: MediaStream | null = null;
  let starting: Promise<MediaStream> | null = null;
  let raf = 0, destroyed = false;
  let W = 0, H = 0, dpr = 1;
  let mode: AirDrawMode = "menu";
  let armAt = 0; // pen stays up until this time (see DRAW_ARM_MS)
  const cursorF = filterPair();

  const strokes: Stroke[] = [];
  const history: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  let slots: Slot[] = [];
  let lastVideoTime = -1, lastFlickT = -1e9;
  let penColor: string = PEN_COLOR;
  let wheel: Wheel | null = null;
  let shape: Shape | null = null;
  const arming = { line: 0, circle: 0, rect: 0 }; // when each two-hand shape's pose started (0 = not held)
  let shapeBlockUntil = 0;
  let actionBlockUntil = 0; // undo / redo / clear / wheel, after a shape or a colour pick

  let toast = onToast;
  let hook: TestHook | null = null;
  if (TEST_BUILD) {
    const h: TestHook = {
      strokes, toasts: [], penColor, wheel: null, shape: null, hands: [0, 0],
      // inverse of toScreen: screen px → normalised video coords, so tests can aim a mock fingertip
      screenToVideo: (x, y) => {
        const f = fit();
        return [(f.ox + f.dw - x) / f.s / f.vw, (y - f.oy) / f.s / f.vh];
      },
    };
    hook = (window as TestWindow).__airDraw = h;
    toast = msg => { h.toasts.push(msg); onToast(msg); };
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = ink.width = Math.round(W * dpr); canvas.height = ink.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    inkKey = "";
  }
  function onKey(e: KeyboardEvent) {
    if (mode !== "draw" || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "c") clearAll();
    if (k === "z") { if (e.shiftKey) redo(); else undo(); }
    if (k === "y") redo();
  }
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", onKey);
  resize();

  // ---------------- geometry ----------------
  // video is drawn mirrored with "cover" fit
  function fit(): Fit {
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s, dh = vh * s;
    return { vw, vh, s, dw, dh, ox: (W - dw) / 2, oy: (H - dh) / 2 };
  }

  // ---------------- model + camera ----------------
  async function load() {
    const shared = await loadLandmarker();
    if (destroyed) return;
    landmarker = shared.landmarker;
    connections = shared.connections;
  }

  function start() {
    starting ??= (async () => {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false,
      });
      if (destroyed) { s.getTracks().forEach(t => t.stop()); throw new Error("Air Draw was closed"); }
      video.srcObject = s;
      await new Promise<void>(r => {
        if (video.readyState >= 1) r();
        else video.addEventListener("loadedmetadata", () => r(), { once: true });
      });
      await video.play();
      stream = s;
      raf = requestAnimationFrame(loop);
      return s;
    })();
    starting.catch(() => { starting = null; }); // allow a retry (e.g. after the user grants permission)
    return starting;
  }

  function setMode(m: AirDrawMode) {
    if (m === mode) return;
    mode = m;
    slots.forEach(endStroke);
    slots = []; wheel = null; shape = null;
    resetArming();
    cursorF.forEach(f => f.reset());
    if (m === "draw") {
      strokes.length = 0; history.length = 0; redoStack.length = 0; // a fresh card
      inkKey = "";
      armAt = performance.now() + DRAW_ARM_MS;
    }
  }

  // ---------------- drawing actions ----------------
  function record(h: HistoryEntry) { history.push(h); redoStack.length = 0; }
  function addStroke(s: Stroke) {
    strokes.push(s); record({ type: "stroke", stroke: s });
    if (!s.active) inkKey = "";
    return s;
  }
  function removeStroke(st: Stroke) {
    const i = strokes.indexOf(st);
    if (i >= 0) strokes.splice(i, 1);
    const j = history.findIndex(h => h.type === "stroke" && h.stroke === st);
    if (j >= 0) history.splice(j, 1);
  }
  function endStroke(slot: Slot) {
    const st = slot.stroke;
    if (!st) return;
    st.active = false;
    slot.stroke = null;
    inkKey = "";
    if (!st.pts.length) { removeStroke(st); return; } // nothing was drawn: drop silently
    onStrokes?.("settled");
  }
  /** Throw away the stroke a hand is drawing (its pinch turned out to be the start of a line). */
  function discardStroke(slot: Slot) {
    if (!slot.stroke) return;
    removeStroke(slot.stroke);
    slot.stroke = null;
    onStrokes?.("settled");
  }
  function undo() {
    // most recent finished action (skip strokes still being drawn)
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h.type === "stroke" && h.stroke.active) continue;
      history.splice(i, 1);
      redoStack.push(h);
      if (h.type === "stroke") { strokes.splice(strokes.indexOf(h.stroke), 1); toast("↩ Undo"); }
      else { strokes.push(...h.saved); toast("↩ Restored"); }
      inkKey = "";
      onStrokes?.("settled");
      return;
    }
    toast("Nothing to undo");
  }
  function redo() {
    const h = redoStack.pop();
    if (!h) { toast("Nothing to redo"); return; }
    if (h.type === "stroke") { strokes.push(h.stroke); history.push(h); }
    else { slots.forEach(endStroke); history.push({ type: "clear", saved: strokes.splice(0) }); }
    toast("↪ Redo");
    inkKey = "";
    onStrokes?.("settled");
  }
  function clearAll() {
    slots.forEach(endStroke);
    if (!strokes.length) return;
    record({ type: "clear", saved: strokes.splice(0) });
    inkKey = "";
    toast("✨ Cleared");
    onStrokes?.("settled");
  }
  function reset() {
    slots.forEach(endStroke);
    strokes.length = 0; history.length = 0; redoStack.length = 0;
    inkKey = "";
    shape = null; resetArming();
  }
  function getStrokes(): Pt[][] {
    const vw = video.videoWidth, m = Math.max(vw, video.videoHeight) || 1;
    return strokes.filter(s => s.pts.length).map(s => {
      const pts = s.shape && s.shape !== "line" ? [...s.pts, s.pts[0]] : s.pts; // rect / circle are closed
      return pts.map(([x, y]): Pt => [(vw - x) / m, y / m]);
    });
  }

  // ---------------- hand tracking with memory ----------------
  function forget(s: Slot) {
    endStroke(s);
    if (wheel?.slot === s) wheel = null;
  }

  // Attach each detection to the hand it most likely is: the nearest remembered hand (at its
  // predicted position), or a new one. Remembered hands that aren't claimed stay around, not
  // live, until HAND_MEMORY_MS has passed.
  function trackHands(f: Fit, hands: NormalizedLandmark[][], t: number) {
    const dets = hands.map(lm => ({ lm, wrist: px(f, lm[0]) }));
    const predicted = slots.map(s => {
      const dt = Math.min(t - s.lastSeen, 200);
      return [s.wrist[0] + s.vel[0] * dt, s.wrist[1] + s.vel[1] * dt] as Pt;
    });
    const pairs: { i: number; j: number; d: number }[] = [];
    slots.forEach((_, i) => dets.forEach((det, j) => pairs.push({ i, j, d: dist2(det.wrist, predicted[i]) })));
    pairs.sort((a, b) => a.d - b.d);
    const slotOf = new Map<number, Slot>(), taken = new Set<number>();
    for (const { i, j, d } of pairs) {
      if (d > HAND_MATCH * f.vw || taken.has(i) || slotOf.has(j)) continue;
      taken.add(i); slotOf.set(j, slots[i]);
    }

    for (const s of slots) s.live = false;
    dets.forEach((det, j) => {
      const s = slotOf.get(j);
      if (!s) { slots.push(newSlot(det.lm, det.wrist, t)); return; }
      const dt = Math.max(t - s.lastSeen, 1), k = 0.5;
      s.vel = [s.vel[0] + ((det.wrist[0] - s.wrist[0]) / dt - s.vel[0]) * k, s.vel[1] + ((det.wrist[1] - s.wrist[1]) / dt - s.vel[1]) * k];
      Object.assign(s, { lm: det.lm, wrist: det.wrist, lastSeen: t, live: true });
    });

    slots = slots.filter(s => {
      if (s.live) return true;
      if (t - s.lastSeen <= HAND_MEMORY_MS) return true;
      forget(s);
      return false;
    });
    if (wheel && !slots.includes(wheel.slot)) wheel = null;
  }

  // ---------------- per-hand pose analysis ----------------
  function analyse(f: Fit, s: Slot, t: number) {
    const lm = s.lm;
    const P = (i: number) => p3(f, lm[i]);
    const wrist = P(0);
    const rawPalm = dist(wrist, P(9)) || 1;
    s.palm = s.palm ? s.palm + (rawPalm - s.palm) * 0.3 : rawPalm; // the z estimate is noisy
    const palm = s.palm;

    // finger states with hysteresis
    const sc = {} as Record<Finger, number>;
    for (const k of FINGER_NAMES) {
      const [pip, tip] = FINGERS[k];
      sc[k] = dist(wrist, P(tip)) / (dist(wrist, P(pip)) || 1);
      s.ext[k] = s.ext[k] ? sc[k] > EXT_OFF : sc[k] > EXT_ON;
      s.curled[k] = s.curled[k] ? sc[k] < CURL_OFF : sc[k] < CURL_MAX;
    }
    const openCount = FINGER_NAMES.filter(k => sc[k] > EXT_ON).length;
    const othersCurled = s.curled.middle && s.curled.ring && s.curled.pinky;
    s.othersOpen = (["middle", "ring", "pinky"] as const).filter(k => s.ext[k]).length;

    // thumb: tucked if its tip sits near the index/middle knuckles or middle-finger PIP
    const thumbTip = P(4), indexTip = P(8);
    const thumbR = Math.min(...[5, 6, 9, 10].map(i => dist(thumbTip, P(i)))) / palm;
    s.thumbIn = s.thumbIn ? thumbR < THUMB_OPEN : thumbR < THUMB_CLOSED;

    // 🤏 pinch: strict to start (3D, index not curled into a fist), forgiving to hold (2D)
    // How long a release lasted is measured between frames that actually saw the hand open, so
    // a stalled or dropped frame can't stretch a one-frame flicker into a lifted pen.
    if (s.pinched) {
      if (dist2(thumbTip, indexTip) / palm > PINCH_OFF) { s.pinched = false; s.openSince = t; s.openFor = 0; }
    } else if (dist(thumbTip, indexTip) / palm < PINCH_ON && sc.index > PINCH_MIN_INDEX) {
      s.pinched = true;
      if (s.openFor >= PEN_UP_MS) s.pinchSince = t; // a re-pinch inside the grace period is the same pinch
    }
    if (!s.pinched) { s.openFor = t - s.openSince; s.penBlocked = false; }

    const thumb2 = px(f, lm[4]), index2 = px(f, lm[8]);
    s.pen = applyPair(s.penF, mid(thumb2, index2), t);
    s.tips = { thumb: thumb2, index: index2 };
    let ax = 0, ay = 0;
    for (const i of [2, 3, 4, 5, 6, 7, 8]) { ax += lm[i].x / 7; ay += lm[i].y / 7; }
    s.arc = applyPair(s.arcF, [ax * f.vw, ay * f.vh], t);
    s.corner = applyPair(s.cornerF, lCorner(f, lm, palm), t);

    s.openPalm = openCount >= 4 && !s.thumbIn && !s.pinched;
    s.openish = FINGER_NAMES.filter(k => sc[k] > 1.0).length >= 3 && !s.pinched; // lenient: motion blur folds fingers
    s.fist = !s.ext.index && othersCurled;
    s.lPose = s.ext.index && !s.thumbIn && othersCurled && !s.pinched; // 🫷 "L": index up, thumb out
    s.cupped = !s.pinched && !s.fist && dist(thumbTip, indexTip) / palm > CIRCLE_HOLE; // ⊂ half an O

    // 👈 / 👉 all four fingers curled, thumb sticking out sideways
    s.thumbDir = 0;
    if (s.curled.index && othersCurled && !s.pinched && dist(thumbTip, P(5)) / palm > THUMB_POINT_EXT) {
      const base = px(f, lm[2]);
      const sx = -(thumb2[0] - base[0]), sy = thumb2[1] - base[1]; // screen direction (mirrored x)
      if (Math.abs(sy) <= Math.abs(sx) * THUMB_AXIS_TAN) s.thumbDir = sx < 0 ? -1 : 1;
    }
  }

  // ---------------- per-hand actions ----------------
  const linePending = () => arming.line > 0;

  function act(f: Fit, s: Slot, t: number) {
    if (wheel?.slot === s) { updateWheel(f, s, t); return; }
    const free = !shape; // a two-hand shape owns both hands
    draw(f, s, t);
    thumbAction(s, t, free);

    // 👋 flick left → clear
    let tx = 0, ty = 0;
    for (const i of [8, 12, 16, 20]) { tx += s.lm[i].x / 4; ty += s.lm[i].y / 4; }
    s.trail.push({ t, x: tx, y: ty * f.vh / f.vw, open: s.openish, pinched: s.pinched });
    const [cx, cy] = palmCentre(f, s.lm);
    while (s.trail.length && t - s.trail[0].t > FLICK_WINDOW_MS) s.trail.shift();
    if (free && canClear(t) && isFlick(s.trail)) flicked(s, t);

    // ✋ open palm held still (one hand only) → colour wheel
    const liveHands = slots.filter(o => o.live).length;
    if (s.openPalm && free && liveHands === 1 && t >= actionBlockUntil && Math.abs(handTilt(f, s.lm)) < WHEEL_UPRIGHT_DEG) {
      if (!s.still || Math.hypot(cx - s.still.x, cy - s.still.y) > WHEEL_STILL) s.still = { x: cx, y: cy, t };
      else if (t - s.still.t >= WHEEL_HOLD_MS) openWheel(f, s);
    } else s.still = null;
  }

  // 🤏 the pen: down while pinched; lifted only once the pinch has stayed open for PEN_UP_MS
  function draw(f: Fit, s: Slot, t: number) {
    if (shape) { endStroke(s); return; }
    // a pinch let go for longer than the grace period ends the stroke; so does a different pinch
    // (a remembered hand comes back pinched but had released before it was lost)
    if (s.stroke && (s.strokePinch !== s.pinchSince || (!s.pinched && s.openFor >= PEN_UP_MS))) endStroke(s);
    if (!s.pinched || s.penBlocked || t - s.pinchSince < PEN_DOWN_MS || t < armAt || linePending()) return;
    const last = s.stroke?.pts.at(-1);
    if (last && dist2(s.pen, last) > PEN_BRIDGE * f.vw) endStroke(s); // came back somewhere else: new stroke
    if (!s.stroke) { s.stroke = addStroke({ pts: [], active: true, color: penColor }); s.strokePinch = s.pinchSince; }
    const prev = s.stroke.pts.at(-1);
    if (!prev || dist2(s.pen, prev) > 1.5) { s.stroke.pts.push(s.pen); onStrokes?.("drawing"); }
  }

  // 👈 undo / 👉 redo: fires once when the pose has been held; drop the pose to fire again
  function thumbAction(s: Slot, t: number, free: boolean) {
    if (s.thumbDir !== 0) s.thumbSeen = t;
    else if (t - s.thumbSeen > THUMB_REARM_MS) { s.thumbPose = 0; s.thumbFired = false; }
    if (s.thumbDir !== 0 && s.thumbDir !== s.thumbPose) { s.thumbPose = s.thumbDir; s.thumbSince = t; }
    if (!s.thumbPose || s.thumbFired) return;
    // a pose already made while something else was going on doesn't count: make it again
    if (!free || t < actionBlockUntil) { s.thumbFired = true; return; }
    if (t - s.thumbSince < THUMB_HOLD_MS) return;
    s.thumbFired = true;
    endStroke(s); // the hand isn't pinching: its stroke is finished, so undo takes that one
    if (s.thumbPose < 0) undo(); else redo();
  }

  const canClear = (t: number) => t >= actionBlockUntil && t - lastFlickT > FLICK_COOLDOWN_MS;

  // A short, fast flick of an open hand to the left (as seen on screen). Only leftwards and
  // mostly horizontal: dropping a hand to rest, raising it to draw or moving it back to the right
  // are fast and straight too. Fires on the way out, so the hand snapping back doesn't matter.
  function isFlick(trail: TrailPt[]) {
    if (trail.length < 3 || trail.some(p => p.pinched)) return false;
    const a = trail[0], b = trail.at(-1)!;
    const left = b.x - a.x; // video x grows to the left on the mirrored screen
    const disp = Math.hypot(b.x - a.x, b.y - a.y);
    if (left < FLICK_DIST || left < Math.abs(b.y - a.y)) return false;
    let path = 0, peak = 0;
    for (let i = 1; i < trail.length; i++) {
      const p = trail[i - 1], q = trail[i];
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      path += d;
      peak = Math.max(peak, d / Math.max(q.t - p.t, 16) * 1000);
    }
    const open = trail.filter(p => p.open).length / trail.length;
    return disp / path >= FLICK_STRAIGHT && peak >= FLICK_PEAK_SPEED && open >= FLICK_OPEN_SHARE;
  }

  function flicked(s: Slot, t: number) {
    lastFlickT = t; s.trail.length = 0; s.still = null;
    clearAll();
  }

  // ---------------- colour wheel ----------------
  const wheelIndex = (theta: number) =>
    clamp(Math.floor((theta + WHEEL_SPAN_DEG / 2) / WHEEL_SPAN_DEG * PALETTE.length), 0, PALETTE.length - 1);

  function wheelPlacement(f: Fit, s: Slot): { center: Pt; radius: number } {
    let x = 0, y = 0;
    for (const i of [0, 5, 9, 13, 17]) { x += s.lm[i].x / 5; y += s.lm[i].y / 5; } // palm centre
    return { center: toScreen(f, x * f.vw, y * f.vh), radius: s.palm * f.s * 1.7 };
  }

  function openWheel(f: Fit, s: Slot) {
    endStroke(s);
    s.still = null; s.trail.length = 0;
    const theta = handTilt(f, s.lm);
    wheel = { slot: s, theta, idx: wheelIndex(theta), fistSince: 0, ...wheelPlacement(f, s) };
  }

  function updateWheel(f: Fit, s: Slot, t: number) {
    const w = wheel!;
    w.theta += (handTilt(f, s.lm) - w.theta) * 0.35; // light smoothing
    Object.assign(w, wheelPlacement(f, s));
    // knuckle-based tilt doesn't change while the fingers close, so the choice holds through the fist
    if (!s.fist) { w.idx = wheelIndex(w.theta); w.fistSince = 0; }
    else w.fistSince ||= t;
    if (w.fistSince && t - w.fistSince >= WHEEL_PICK_MS) { // ✊ pick
      penColor = PALETTE[w.idx].color;
      toast(`🎨 ${PALETTE[w.idx].name}`);
      wheel = null;
      actionBlockUntil = t + ACTION_COOLDOWN_MS;
      s.thumbFired = true; // a thumb sticking out of the picking fist isn't an undo
      s.trail.length = 0;
    }
  }

  // ---------------- two-hand shapes ----------------
  function resetArming() { arming.line = 0; arming.circle = 0; arming.rect = 0; }

  function circlePoints(c: Pt, r: number): Pt[] {
    return Array.from({ length: CIRCLE_SEGMENTS }, (_, i): Pt => {
      const a = i / CIRCLE_SEGMENTS * 2 * Math.PI;
      return [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
    });
  }

  function shapeGeometry(kind: ShapeKind, a: Slot, b: Slot): { pts: Pt[]; handles: Pt[] } {
    if (kind === "line") return { pts: [a.pen, b.pen], handles: [a.pen, b.pen] }; // the two pinch points
    if (kind === "circle") { // each hand is one side of the O: their curves are opposite ends of a diameter
      return { pts: circlePoints(mid(a.arc, b.arc), dist2(a.arc, b.arc) / 2), handles: [a.arc, b.arc] };
    }
    // rectangle: the two L corners are opposite corners
    const [x1, y1] = a.corner;
    let [x2, y2] = b.corner;
    const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    if (Math.abs(w - h) < SQUARE_SNAP * Math.max(w, h)) { // near-square → square
      const side = (w + h) / 2;
      x2 = x1 + Math.sign(x2 - x1 || 1) * side; y2 = y1 + Math.sign(y2 - y1 || 1) * side;
    }
    const pts: Pt[] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    return { pts, handles: [pts[0], pts[2]] };
  }

  // is this hand still holding the shape's pose? (a remembered hand keeps its last state)
  function holding(kind: ShapeKind, s: Slot) {
    if (kind === "line") return s.pinched;
    if (kind === "circle") return s.cupped; // closing the hand (fist, or thumb onto index) lets go
    return s.ext.index && !s.pinched && s.othersOpen <= 1 && !s.thumbIn; // opening the whole hand lets go
  }

  function placeShape(t: number) {
    const sh = shape!;
    shape = null;
    shapeBlockUntil = t + SHAPE_COOLDOWN_MS;
    actionBlockUntil = Math.max(actionBlockUntil, t + ACTION_COOLDOWN_MS);
    for (const s of [sh.a, sh.b]) { s.penBlocked = s.pinched; s.trail.length = 0; s.still = null; }
    const xs = sh.pts.map(p => p[0]), ys = sh.pts.map(p => p[1]);
    if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < SHAPE_MIN_PX) return;
    addStroke({ pts: sh.pts, active: false, color: penColor, shape: sh.kind });
    onStrokes?.("settled");
  }

  function updateShapes(t: number) {
    if (shape) {
      const { kind, a, b } = shape;
      const present = slots.includes(a) && slots.includes(b);
      if (present && holding(kind, a) && holding(kind, b)) {
        shape.offSince = null;
        if (a.live || b.live) Object.assign(shape, shapeGeometry(kind, a, b));
      } else {
        shape.offSince ??= t;
        if (!present || t - shape.offSince >= SHAPE_RELEASE_MS) placeShape(t); // the last held geometry
      }
      return;
    }
    const live = slots.filter(s => s.live);
    if (wheel || live.length !== 2 || t < shapeBlockUntil) { resetArming(); return; }

    const [A, B] = live;
    const palm = (A.palm + B.palm) / 2;
    const since = (ok: boolean, start: number) => (ok ? start || t : 0);
    arming.line = since(A.pinched && B.pinched && !A.penBlocked && !B.penBlocked
      && Math.abs(A.pinchSince - B.pinchSince) <= LINE_SYNC_MS, arming.line);
    // ⭕ an O made of both hands: index tips together, thumb tips together, a hole in the middle
    arming.circle = since(A.cupped && B.cupped && dist2(A.tips.index, B.tips.index) / palm < CIRCLE_TOUCH
      && dist2(A.tips.thumb, B.tips.thumb) / palm < CIRCLE_TOUCH, arming.circle);
    arming.rect = since(A.lPose && B.lPose && dist2(A.corner, B.corner) / palm > RECT_MIN_GAP, arming.rect);

    const kind: ShapeKind | null =
      arming.line && t - arming.line >= LINE_ARM_MS ? "line"
      : arming.circle && t - arming.circle >= CIRCLE_ARM_MS ? "circle"
      : arming.rect && t - arming.rect >= RECT_HOLD_MS ? "rect"
      : null;
    if (!kind) return;
    resetArming();
    for (const s of [A, B]) {
      if (kind === "line") discardStroke(s); // the ink these pinches made in the meantime
      else endStroke(s);
      s.still = null;
    }
    shape = { kind, a: A, b: B, ...shapeGeometry(kind, A, B), offSince: null };
  }

  function process(result: HandLandmarkerResult, f: Fit, t: number) {
    trackHands(f, result.landmarks, t);
    const live = slots.filter(s => s.live);
    for (const s of live) analyse(f, s, t);
    updateShapes(t);
    for (const s of live) act(f, s, t);
  }

  // the first hand's index fingertip is the on-screen cursor (start screen buttons, back button)
  function trackPointer(result: HandLandmarkerResult, f: Fit, t: number) {
    const lm = result.landmarks[0];
    if (!lm) { cursorF.forEach(c => c.reset()); onPointer?.(null); return; }
    const [x, y] = toScreen(f, ...applyPair(cursorF, px(f, lm[8]), t));
    onPointer?.({ x, y });
  }

  // ---------------- rendering ----------------
  const penWidth = (f: Fit) => PEN_SIZE * f.dh / 720;

  function tracePolyline(c: CanvasRenderingContext2D, pts: Pt[], closed: boolean) {
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) c.lineTo(p[0], p[1]);
    if (closed) c.closePath();
  }

  function drawStroke(c: CanvasRenderingContext2D, f: Fit, s: Stroke, w: number) {
    c.strokeStyle = c.fillStyle = c.shadowColor = s.color;
    const pts = s.pts.map(p => toScreen(f, p[0], p[1]));
    if (s.shape) { tracePolyline(c, pts, s.shape !== "line"); c.stroke(); return; }
    if (pts.length === 1) { c.beginPath(); c.arc(pts[0][0], pts[0][1], w / 2, 0, 7); c.fill(); return; }
    c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    c.lineTo(pts.at(-1)![0], pts.at(-1)![1]);
    c.stroke();
  }

  function inkStyle(c: CanvasRenderingContext2D, w: number) {
    c.lineCap = c.lineJoin = "round";
    c.lineWidth = w; c.shadowBlur = w * 1.2;
  }

  function drawStrokes(f: Fit) {
    const w = penWidth(f);
    const key = `${W}x${H}@${dpr}:${f.vw}x${f.vh}`;
    if (inkKey !== key) { // finished ink changed: re-render the layer once
      inkKey = key;
      inkCtx.setTransform(1, 0, 0, 1, 0, 0);
      inkCtx.clearRect(0, 0, ink.width, ink.height);
      inkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      inkStyle(inkCtx, w);
      for (const s of strokes) if (!s.active && s.pts.length) drawStroke(inkCtx, f, s, w);
    }
    ctx.drawImage(ink, 0, 0, W, H);
    inkStyle(ctx, w);
    for (const s of strokes) if (s.active && s.pts.length) drawStroke(ctx, f, s, w);
    ctx.shadowBlur = 0;
  }

  function handle(x: number, y: number) {
    ctx.fillStyle = "#fffdf5"; ctx.strokeStyle = "#1d1b16"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.stroke();
  }

  function drawShapePreview(f: Fit) {
    if (!shape) return;
    const pts = shape.pts.map(p => toScreen(f, p[0], p[1]));
    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.lineWidth = penWidth(f); ctx.strokeStyle = penColor; ctx.globalAlpha = 0.85;
    ctx.setLineDash([penWidth(f) * 2, penWidth(f) * 2]);
    tracePolyline(ctx, pts, shape.kind !== "line"); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    for (const p of shape.handles) handle(...toScreen(f, p[0], p[1]));
    if (shape.kind === "circle") handle(...toScreen(f, ...mid(shape.handles[0], shape.handles[1]))); // centre
    ctx.restore();
  }

  function drawWheel() {
    if (!wheel) return;
    const { center: [cx, cy], radius: r, idx, theta } = wheel;
    const n = PALETTE.length, seg = WHEEL_SPAN_DEG / n;
    const r0 = r * 1.05, r1 = r * 1.55;
    ctx.save();
    for (let i = 0; i < n; i++) {
      const a0 = (-90 - WHEEL_SPAN_DEG / 2 + i * seg) * DEG, a1 = a0 + seg * DEG;
      const on = i === idx, out = on ? r1 + r * 0.18 : r1;
      ctx.beginPath(); ctx.arc(cx, cy, out, a0 + 0.02, a1 - 0.02); ctx.arc(cx, cy, r0, a1 - 0.02, a0 + 0.02, true); ctx.closePath();
      ctx.fillStyle = PALETTE[i].color; ctx.globalAlpha = on ? 1 : 0.75; ctx.fill();
      ctx.globalAlpha = 1; ctx.lineWidth = on ? 4 : 2; ctx.strokeStyle = on ? "#fffdf5" : "#1d1b16"; ctx.stroke();
    }
    // needle follows the hand's tilt; hub shows the colour that a fist would pick
    const a = (-90 + clamp(theta, -WHEEL_SPAN_DEG / 2, WHEEL_SPAN_DEG / 2)) * DEG;
    ctx.strokeStyle = "#fffdf5"; ctx.lineWidth = 4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r0 * 0.95, cy + Math.sin(a) * r0 * 0.95); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.28, 0, 7);
    ctx.fillStyle = PALETTE[idx].color; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = "#1d1b16"; ctx.stroke();
    ctx.font = "600 16px ui-rounded, system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.fillStyle = "#fffdf5";
    const label = `${PALETTE[idx].name} · tilt to choose, fist to pick`;
    ctx.strokeText(label, cx, cy + r * 0.28 + 26); ctx.fillText(label, cx, cy + r * 0.28 + 26);
    ctx.restore();
  }

  function drawHands(f: Fit, now: number) {
    const w = penWidth(f);
    ctx.save();
    for (const s of slots) {
      // a remembered hand fades out where it was last seen
      const alpha = s.live ? 1 : 0.6 * (1 - clamp((now - s.lastSeen) / HAND_MEMORY_MS, 0, 1));
      const P = s.lm.map(p => toScreen(f, ...px(f, p)));
      ctx.globalAlpha = alpha;
      ctx.setLineDash(s.live ? [] : [4, 5]);
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 2;
      ctx.beginPath();
      for (const c of connections) { ctx.moveTo(...P[c.start]); ctx.lineTo(...P[c.end]); }
      ctx.stroke();
      ctx.setLineDash([]);
      if (s.live) {
        ctx.fillStyle = "rgba(255,255,255,.8)";
        for (const p of P) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 7); ctx.fill(); }
      }
      if (shape || wheel?.slot === s) continue;

      // pen: hollow ring where ink would go, filled while drawing
      const [x, y] = toScreen(f, ...s.pen), r = Math.max(w / 2 + 3, 6);
      ctx.lineWidth = 2;
      if (s.stroke && s.pinched) {
        ctx.fillStyle = penColor; ctx.strokeStyle = "#fff";
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
      } else if (s.live && !s.thumbPose) {
        ctx.strokeStyle = penColor; ctx.globalAlpha = s.pinched ? 1 : 0.7;
        ctx.beginPath(); ctx.arc(x, y, r + (s.pinched ? 0 : 4), 0, 7); ctx.stroke();
        ctx.globalAlpha = alpha;
      }

      // 👈 / 👉 progress: ring fills while the pose is held
      if (s.live && s.thumbPose && !s.thumbFired) {
        const [tx, ty] = P[4];
        const prog = clamp((now - s.thumbSince) / THUMB_HOLD_MS, 0, 1);
        const bx = tx + s.thumbPose * 30, by = ty;
        ctx.fillStyle = "rgba(15,17,21,.65)";
        ctx.beginPath(); ctx.arc(bx, by, 18, 0, 7); ctx.fill();
        ctx.strokeStyle = "#4fd1c5"; ctx.lineWidth = 4; ctx.lineCap = "round";
        ctx.beginPath(); ctx.arc(bx, by, 18, -Math.PI / 2, -Math.PI / 2 + prog * 2 * Math.PI); ctx.stroke();
        ctx.fillStyle = "#fffdf5"; ctx.font = "600 18px ui-rounded, system-ui, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(s.thumbPose < 0 ? "↩" : "↪", bx, by + 1);
      }
    }
    ctx.restore();
  }

  function loop() {
    if (destroyed || !stream) return;
    raf = requestAnimationFrame(loop);
    if (!video.videoWidth || !landmarker) return;
    const f = fit();

    if (video.currentTime !== lastVideoTime && video.readyState >= 2) {
      lastVideoTime = video.currentTime;
      const t = performance.now(); // must increase on every detectForVideo call
      try {
        const result = landmarker.detectForVideo(video, t);
        trackPointer(result, f, t);
        if (mode === "draw") process(result, f, t);
      } catch (e) {
        onError("Hand tracking error: " + (e instanceof Error ? e.message : String(e)));
      }
      if (hook) {
        const live = slots.filter(s => s.live).length;
        Object.assign(hook, { penColor, wheel: wheel?.idx ?? null, shape: shape?.kind ?? null, hands: [live, slots.length - live] });
      }
    }
    if (mode === "menu") return; // the start screen covers the canvas

    ctx.save(); ctx.translate(f.ox + f.dw, f.oy); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, f.dw, f.dh); ctx.restore();

    drawStrokes(f);
    drawShapePreview(f);
    drawHands(f, performance.now());
    drawWheel();
  }

  function destroy() {
    destroyed = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("keydown", onKey);
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    video.srcObject = null;
    landmarker = null; // shared across mounts; lives for the page (see loadLandmarker)
  }

  return { load, start, setMode, undo, redo, clearAll, getStrokes, reset, destroy };
}
