// Air Draw engine: hand tracking, gesture recognition and Canvas 2D rendering.
// Framework-free on purpose — AirDraw.tsx owns the DOM and UI state, this owns the frame loop.
//
// Gestures (draw mode):
//   one hand   ☝️ draw · 🤏🤏 undo · 👋 flick to clear · ✋ hold still for the colour wheel
//   two hands  line (both pinch) · rectangle (both L) · triangle (index tips + thumbs touching),
//              stretched by pulling the hands apart and placed on release

import type { HandLandmarker, HandLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  CURL_MAX, CURL_OFF, DOUBLE_GAP_MS, DRAW_ARM_MS, EXT_OFF, EXT_ON, FLICK_COOLDOWN_MS, FLICK_DIST, FLICK_WINDOW_MS,
  MODEL_URL, PALETTE, PEN_COLOR, PEN_SIZE, PINCH_OFF, PINCH_ON, POSE_FRAMES, RECT_HOLD_MS, RECT_MIN_GAP,
  SHAPE_ARM_FRAMES, SHAPE_COOLDOWN_MS, SHAPE_MIN_PX, SQUARE_SNAP, TAP_MAX_MS, THUMB_CLOSED, THUMB_OPEN, TOUCH, WASM_BASE,
  WHEEL_COOLDOWN_MS, WHEEL_HOLD_MS, WHEEL_SPAN_DEG, WHEEL_STILL, WHEEL_UPRIGHT_DEG,
} from "./constants";

type Vision = Pick<typeof import("@mediapipe/tasks-vision"), "FilesetResolver" | "HandLandmarker">;
type Pt = [number, number];
type Pt3 = [number, number, number];
type Fit = { vw: number; vh: number; s: number; dw: number; dh: number; ox: number; oy: number };
type ShapeKind = "line" | "rect" | "tri";
// pts in un-mirrored video px; `shape` strokes are straight-edged (rect / tri closed)
type Stroke = { pts: Pt[]; active: boolean; color: string; shape?: ShapeKind };
type HistoryEntry = { type: "stroke"; stroke: Stroke } | { type: "clear"; saved: Stroke[] };
type CurlFinger = "middle" | "ring" | "pinky";
type Slot = {
  wrist: Pt;
  pointFrames: number; relaxFrames: number; pointing: boolean; stroke: Stroke | null;
  fx: OneEuro; fy: OneEuro; tip: Pt | null;
  pinched: boolean; pinchStart: number; lastTapEnd: number;
  idxExt: boolean; thumbIn: boolean; curled: Record<CurlFinger, boolean>;
  palm: number; // wrist → middle knuckle, video px (3D)
  openPalm: boolean; fist: boolean; lPose: boolean;
  balled: boolean; // all four fingers properly curled (a fist's thumb can read as a pinch)
  still: { x: number; y: number; t: number } | null; // where an open palm started holding still
  wheelBlockUntil: number;
  trail: { t: number; x: number; y: number; open: boolean }[];
};
type HandInfo = { lm: NormalizedLandmark[]; slot: Slot };
type Wheel = { slot: Slot; theta: number; idx: number; fistFrames: number; center: Pt; radius: number };
type Shape = { kind: ShapeKind; pts: Pt[]; releaseFrames: number };

// Test builds only (NEXT_PUBLIC_AIR_DRAW_TEST=1): a mock landmarker can be injected and state is observable.
const TEST_BUILD = process.env.NEXT_PUBLIC_AIR_DRAW_TEST === "1";
type TestHook = {
  strokes: Stroke[]; toasts: string[];
  screenToVideo: (x: number, y: number) => Pt;
  penColor: string; wheel: number | null; shape: ShapeKind | null;
};
type TestWindow = Window & { __airDrawMock?: Vision; __airDraw?: TestHook };

const FINGERS = { index: [5, 6, 8], middle: [9, 10, 12], ring: [13, 14, 16], pinky: [17, 18, 20] } as const; // mcp, pip, tip
const CURL_FINGERS: CurlFinger[] = ["middle", "ring", "pinky"];
const DEG = Math.PI / 180;

// One Euro filter: smooths jitter without adding much lag
class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(private minCutoff = 1.5, private beta = 0.01, private dCutoff = 1) {}
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

const toScreen = (f: Fit, x: number, y: number): Pt => [f.ox + f.dw - x * f.s, f.oy + y * f.s]; // mirrored
const px = (f: Fit, p: NormalizedLandmark): Pt => [p.x * f.vw, p.y * f.vh];
const p3 = (f: Fit, p: NormalizedLandmark): Pt3 => [p.x * f.vw, p.y * f.vh, p.z * f.vw]; // z is on the same scale as x
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0));
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** On-screen tilt of the hand in degrees: 0 = fingers up, + = leaning right (as the user sees it). */
function handTilt(f: Fit, lm: NormalizedLandmark[]) {
  const [wx, wy] = px(f, lm[0]), [mx, my] = px(f, lm[9]);
  return Math.atan2(-(mx - wx), -(my - wy)) / DEG; // x negated: the view is mirrored
}

function newSlot(): Slot {
  return {
    wrist: [0, 0], pointFrames: 0, relaxFrames: 0, pointing: false, stroke: null,
    fx: new OneEuro(), fy: new OneEuro(), tip: null,
    pinched: false, pinchStart: 0, lastTapEnd: -1e9,
    idxExt: false, thumbIn: false, curled: { middle: false, ring: false, pinky: false },
    palm: 1, openPalm: false, fist: false, lPose: false, balled: false, still: null, wheelBlockUntil: 0,
    trail: [],
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
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
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
  clearAll: () => void;
  destroy: () => void;
};

export function createAirDraw({ video, canvas, onToast, onError, onPointer }: AirDrawOptions): AirDrawEngine {
  const ctx = canvas.getContext("2d")!;
  let landmarker: HandLandmarker | null = null;
  let connections: { start: number; end: number }[] = [];
  let stream: MediaStream | null = null;
  let starting: Promise<MediaStream> | null = null;
  let raf = 0, destroyed = false;
  let W = 0, H = 0;
  let mode: AirDrawMode = "menu";
  let armAt = 0; // pen stays up until this time (see DRAW_ARM_MS)
  const cursorFx = new OneEuro(), cursorFy = new OneEuro();

  const strokes: Stroke[] = [];
  const history: HistoryEntry[] = [];
  let slots: Slot[] = [];
  let lastInfo: HandInfo[] | null = null, lastVideoTime = -1, lastFlickT = -1e9;
  let penColor: string = PEN_COLOR;
  let wheel: Wheel | null = null;
  let shape: Shape | null = null;
  const arming = { line: 0, tri: 0, rectSince: 0 }; // two-hand shape candidates (frames / start time)
  let shapeBlockUntil = 0;

  let toast = onToast;
  let hook: TestHook | null = null;
  if (TEST_BUILD) {
    const h: TestHook = {
      strokes, toasts: [], penColor, wheel: null, shape: null,
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
    const dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function onKey(e: KeyboardEvent) {
    if (mode !== "draw" || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "c") clearAll();
    if (k === "z") undo();
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
    slots = []; lastInfo = null; wheel = null; shape = null;
    resetArming();
    cursorFx.reset(); cursorFy.reset();
    if (m === "draw") {
      strokes.length = 0; history.length = 0; // a fresh card
      armAt = performance.now() + DRAW_ARM_MS;
    }
  }

  // ---------------- drawing actions ----------------
  function addStroke(s: Stroke) {
    strokes.push(s); history.push({ type: "stroke", stroke: s });
    return s;
  }
  function endStroke(slot: Slot) {
    const st = slot.stroke;
    if (!st) return;
    st.active = false;
    if (!st.pts.length) { // nothing was drawn: drop silently
      strokes.splice(strokes.indexOf(st), 1);
      history.splice(history.findIndex(h => h.type === "stroke" && h.stroke === st), 1);
    }
    slot.stroke = null; slot.fx.reset(); slot.fy.reset();
  }
  function undo() {
    // most recent finished action (skip strokes still being drawn)
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h.type === "stroke" && h.stroke.active) continue;
      history.splice(i, 1);
      if (h.type === "stroke") { strokes.splice(strokes.indexOf(h.stroke), 1); toast("↩ Undo"); }
      else { strokes.push(...h.saved); toast("↩ Restored"); }
      return;
    }
    toast("Nothing to undo");
  }
  function clearAll() {
    slots.forEach(endStroke);
    if (!strokes.length) return;
    history.push({ type: "clear", saved: strokes.splice(0) });
    toast("✨ Cleared");
  }

  // ---------------- per-hand gesture analysis ----------------
  // keep each hand's state attached to the same physical hand even if result order swaps
  function trackHands(wrists: Pt[]) {
    let prev = slots;
    if (wrists.length === 2 && prev.length === 2) {
      const keep = dist(wrists[0], prev[0].wrist) + dist(wrists[1], prev[1].wrist);
      const swap = dist(wrists[0], prev[1].wrist) + dist(wrists[1], prev[0].wrist);
      if (swap < keep) prev = [prev[1], prev[0]];
    } else if (wrists.length === 1 && prev.length === 2) {
      const i = dist(wrists[0], prev[1].wrist) < dist(wrists[0], prev[0].wrist) ? 1 : 0;
      endStroke(prev[1 - i]); prev = [prev[i]];
    } else if (wrists.length === 2 && prev.length === 1) {
      prev = dist(wrists[1], prev[0].wrist) < dist(wrists[0], prev[0].wrist) ? [newSlot(), prev[0]] : [prev[0], newSlot()];
    } else if (wrists.length === 0) {
      prev.forEach(endStroke);
    }
    slots = wrists.map((wrist, i) => Object.assign(prev[i] ?? newSlot(), { wrist }));
    if (wheel && !slots.includes(wheel.slot)) wheel = null; // hand left the frame: cancel the wheel
  }

  const shapePending = () => arming.line > 0 || arming.tri > 0 || arming.rectSince > 0;

  function analyse(f: Fit, lm: NormalizedLandmark[], s: Slot, t: number): HandInfo {
    const wrist = p3(f, lm[0]);
    const extScore = ([, pip, tip]: readonly number[]) => dist(wrist, p3(f, lm[tip])) / (dist(wrist, p3(f, lm[pip])) || 1);

    // finger states with hysteresis
    const sc = { index: extScore(FINGERS.index), middle: extScore(FINGERS.middle), ring: extScore(FINGERS.ring), pinky: extScore(FINGERS.pinky) };
    s.idxExt = s.idxExt ? sc.index > EXT_OFF : sc.index > EXT_ON;
    for (const k of CURL_FINGERS) s.curled[k] = s.curled[k] ? sc[k] < CURL_OFF : sc[k] < CURL_MAX;
    const openCount = Object.values(sc).filter(v => v > EXT_ON).length;
    const palm = s.palm = dist(wrist, p3(f, lm[9])) || 1;

    // thumb: tucked if its tip sits near the index/middle knuckles or middle-finger PIP
    const thumbTip = p3(f, lm[4]);
    const thumbR = Math.min(...[5, 6, 9, 10].map(i => dist(thumbTip, p3(f, lm[i])))) / palm;
    s.thumbIn = s.thumbIn ? thumbR < THUMB_OPEN : thumbR < THUMB_CLOSED;

    // pinch (thumb tip ↔ index tip, relative to palm size)
    const pinchR = dist(thumbTip, p3(f, lm[8])) / palm;
    const wasPinched = s.pinched;
    s.pinched = s.pinched ? pinchR < PINCH_OFF : pinchR < PINCH_ON;

    const othersCurled = s.curled.middle && s.curled.ring && s.curled.pinky;
    s.openPalm = openCount >= 4 && !s.thumbIn && !s.pinched;
    s.fist = !s.idxExt && othersCurled;
    s.balled = sc.index < CURL_MAX && othersCurled;
    s.lPose = s.idxExt && !s.thumbIn && othersCurled && !s.pinched; // 🫷 "L": index up, thumb out

    const tip = px(f, lm[8]);
    s.tip = [s.fx.filter(tip[0], t), s.fy.filter(tip[1], t)];

    if (wheel?.slot === s) { updateWheel(f, lm, s, t); return { lm, slot: s }; }
    const twoHand = shape !== null || shapePending(); // a two-hand shape owns both hands

    // ☝️ pointing pose → pen down after POSE_FRAMES, pen up after POSE_FRAMES without it
    const pose = s.idxExt && s.thumbIn && othersCurled && !s.pinched;
    if (pose) { s.pointFrames++; s.relaxFrames = 0; } else { s.relaxFrames++; s.pointFrames = 0; }
    if (!s.pointing && s.pointFrames >= POSE_FRAMES) s.pointing = true;
    if (s.pointing && s.relaxFrames >= POSE_FRAMES) { s.pointing = false; endStroke(s); }
    if (twoHand) endStroke(s);
    else if (s.pointing && pose && t >= armAt) {
      s.stroke ??= addStroke({ pts: [], active: true, color: penColor });
      const last = s.stroke.pts.at(-1);
      if (!last || dist(s.tip, last) > 1.5) s.stroke.pts.push(s.tip);
    }

    // 🤏🤏 double pinch → undo
    if (!wasPinched && s.pinched) s.pinchStart = t;
    if (wasPinched && !s.pinched && !twoHand) {
      const dur = t - s.pinchStart;
      if (dur <= TAP_MAX_MS) {
        if (s.pinchStart - s.lastTapEnd <= DOUBLE_GAP_MS) { undo(); s.lastTapEnd = -1e9; }
        else s.lastTapEnd = t;
      } else s.lastTapEnd = -1e9;
    }

    // 👋 flick → clear: fast travel of the hand centre while the hand is open
    let cx = 0, cy = 0;
    for (const p of lm) { cx += p.x / 21; cy += p.y / 21; }
    cy *= f.vh / f.vw; // same units as x
    s.trail.push({ t, x: cx, y: cy, open: openCount >= 3 });
    while (s.trail.length && t - s.trail[0].t > FLICK_WINDOW_MS) s.trail.shift();
    if (!twoHand && t - lastFlickT > FLICK_COOLDOWN_MS && s.trail.length >= 3) {
      const a = s.trail[0], b = s.trail.at(-1)!;
      const travel = Math.hypot(b.x - a.x, b.y - a.y);
      const openShare = s.trail.filter(p => p.open).length / s.trail.length;
      if (travel > FLICK_DIST && openShare >= 0.5) {
        lastFlickT = t; s.trail.length = 0;
        clearAll();
      }
    }

    // ✋ open palm held still (one hand only) → colour wheel
    if (s.openPalm && !twoHand && slots.length === 1 && t >= s.wheelBlockUntil && Math.abs(handTilt(f, lm)) < WHEEL_UPRIGHT_DEG) {
      if (!s.still || Math.hypot(cx - s.still.x, cy - s.still.y) > WHEEL_STILL) s.still = { x: cx, y: cy, t };
      else if (t - s.still.t >= WHEEL_HOLD_MS) openWheel(f, lm, s);
    } else s.still = null;

    return { lm, slot: s };
  }

  // ---------------- colour wheel ----------------
  const wheelIndex = (theta: number) =>
    clamp(Math.floor((theta + WHEEL_SPAN_DEG / 2) / WHEEL_SPAN_DEG * PALETTE.length), 0, PALETTE.length - 1);

  function wheelPlacement(f: Fit, lm: NormalizedLandmark[], s: Slot): { center: Pt; radius: number } {
    let x = 0, y = 0;
    for (const i of [0, 5, 9, 13, 17]) { x += lm[i].x / 5; y += lm[i].y / 5; } // palm centre
    return { center: toScreen(f, x * f.vw, y * f.vh), radius: s.palm * f.s * 1.7 };
  }

  function openWheel(f: Fit, lm: NormalizedLandmark[], s: Slot) {
    endStroke(s);
    s.still = null; s.trail.length = 0;
    const theta = handTilt(f, lm);
    wheel = { slot: s, theta, idx: wheelIndex(theta), fistFrames: 0, ...wheelPlacement(f, lm, s) };
  }

  function updateWheel(f: Fit, lm: NormalizedLandmark[], s: Slot, t: number) {
    const w = wheel!;
    w.theta += (handTilt(f, lm) - w.theta) * 0.35; // light smoothing
    Object.assign(w, wheelPlacement(f, lm, s));
    // knuckle-based tilt doesn't change while the fingers close, so the choice holds through the fist
    if (!s.fist) w.idx = wheelIndex(w.theta);
    w.fistFrames = s.fist ? w.fistFrames + 1 : 0;
    if (w.fistFrames >= POSE_FRAMES) { // ✊ pick
      penColor = PALETTE[w.idx].color;
      toast(`🎨 ${PALETTE[w.idx].name}`);
      wheel = null;
      s.wheelBlockUntil = t + WHEEL_COOLDOWN_MS;
    }
  }

  // ---------------- two-hand shapes ----------------
  function resetArming() { arming.line = 0; arming.tri = 0; arming.rectSince = 0; }

  function shapeGeometry(kind: ShapeKind, f: Fit, a: HandInfo, b: HandInfo): Pt[] {
    const tipA = px(f, a.lm[8]), tipB = px(f, b.lm[8]);
    if (kind === "line") return [mid(tipA, px(f, a.lm[4])), mid(tipB, px(f, b.lm[4]))]; // the two pinch points
    if (kind === "rect") { // index fingertips are opposite corners
      const [x1, y1] = tipA;
      let [x2, y2] = tipB;
      const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      if (Math.abs(w - h) < SQUARE_SNAP * Math.max(w, h)) { // near-square → square
        const side = (w + h) / 2;
        x2 = x1 + Math.sign(x2 - x1 || 1) * side; y2 = y1 + Math.sign(y2 - y1 || 1) * side;
      }
      return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    }
    // triangle: equilateral, base between the index fingertips, apex pointing up
    const [mx, my] = mid(tipA, tipB);
    const dx = tipB[0] - tipA[0], dy = tipB[1] - tipA[1];
    let nx = -dy, ny = dx;
    if (ny > 0) { nx = -nx; ny = -ny; }
    const k = Math.sqrt(3) / 2; // height / base; (nx, ny) already has the base's length
    return [tipA, tipB, [mx + nx * k, my + ny * k]];
  }

  function shapeHeld(kind: ShapeKind, a: Slot, b: Slot) {
    if (kind === "line") return a.pinched && b.pinched;
    if (kind === "rect") return a.lPose && b.lPose;
    return a.idxExt && b.idxExt;
  }

  function placeShape(t: number) {
    const sh = shape!;
    shape = null;
    shapeBlockUntil = t + SHAPE_COOLDOWN_MS;
    const xs = sh.pts.map(p => p[0]), ys = sh.pts.map(p => p[1]);
    if (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < SHAPE_MIN_PX) return;
    addStroke({ pts: sh.pts, active: false, color: penColor, shape: sh.kind });
  }

  function updateShapes(f: Fit, hands: HandInfo[], t: number) {
    const two = hands.length === 2 && !wheel;
    if (shape) {
      if (two && shapeHeld(shape.kind, hands[0].slot, hands[1].slot)) {
        shape.releaseFrames = 0;
        shape.pts = shapeGeometry(shape.kind, f, hands[0], hands[1]);
      } else if (++shape.releaseFrames >= POSE_FRAMES) placeShape(t); // the last held geometry
      return;
    }
    if (!two || t < shapeBlockUntil) { resetArming(); return; }

    const [a, b] = hands, A = a.slot, B = b.slot;
    const palm = (A.palm + B.palm) / 2;
    const tipGap = dist(px(f, a.lm[8]), px(f, b.lm[8])) / palm;
    const thumbGap = dist(px(f, a.lm[4]), px(f, b.lm[4])) / palm;

    const triPose = A.idxExt && B.idxExt && !A.pinched && !B.pinched && tipGap < TOUCH && thumbGap < TOUCH;
    arming.tri = triPose ? arming.tri + 1 : 0;
    arming.line = A.pinched && B.pinched && !A.balled && !B.balled ? arming.line + 1 : 0;
    arming.rectSince = A.lPose && B.lPose && tipGap > RECT_MIN_GAP ? arming.rectSince || t : 0;

    const kind: ShapeKind | null =
      arming.tri >= SHAPE_ARM_FRAMES ? "tri"
      : arming.line >= SHAPE_ARM_FRAMES ? "line"
      : arming.rectSince && t - arming.rectSince >= RECT_HOLD_MS ? "rect"
      : null;
    if (!kind) return;
    resetArming();
    for (const s of [A, B]) { endStroke(s); s.pinchStart = -1e9; s.lastTapEnd = -1e9; } // releasing isn't an undo tap
    shape = { kind, pts: shapeGeometry(kind, f, a, b), releaseFrames: 0 };
  }

  function process(result: HandLandmarkerResult, f: Fit, t: number): HandInfo[] {
    const hands = result.landmarks;
    trackHands(hands.map(lm => px(f, lm[0])));
    const info = hands.map((lm, i) => analyse(f, lm, slots[i], t));
    updateShapes(f, info, t);
    return info;
  }

  // the first hand's index fingertip is the on-screen cursor (start screen buttons, back button)
  function trackPointer(result: HandLandmarkerResult, f: Fit, t: number) {
    const lm = result.landmarks[0];
    if (!lm) { cursorFx.reset(); cursorFy.reset(); onPointer?.(null); return; }
    const [x, y] = toScreen(f, cursorFx.filter(lm[8].x * f.vw, t), cursorFy.filter(lm[8].y * f.vh, t));
    onPointer?.({ x, y });
  }

  // ---------------- rendering ----------------
  const penWidth = (f: Fit) => PEN_SIZE * f.dh / 720;

  function tracePolyline(pts: Pt[], closed: boolean) {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
    if (closed) ctx.closePath();
  }

  function drawStrokes(f: Fit) {
    const w = penWidth(f);
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.lineWidth = w; ctx.shadowBlur = w * 1.2;
    for (const s of strokes) {
      if (!s.pts.length) continue;
      ctx.strokeStyle = ctx.fillStyle = ctx.shadowColor = s.color;
      const pts = s.pts.map(p => toScreen(f, p[0], p[1]));
      if (s.shape) { tracePolyline(pts, s.shape !== "line"); ctx.stroke(); continue; }
      if (pts.length === 1) { ctx.beginPath(); ctx.arc(pts[0][0], pts[0][1], w / 2, 0, 7); ctx.fill(); continue; }
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      ctx.lineTo(pts.at(-1)![0], pts.at(-1)![1]);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
  }

  function drawShapePreview(f: Fit) {
    if (!shape) return;
    const pts = shape.pts.map(p => toScreen(f, p[0], p[1]));
    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.lineWidth = penWidth(f); ctx.strokeStyle = penColor; ctx.globalAlpha = 0.85;
    ctx.setLineDash([penWidth(f) * 2, penWidth(f) * 2]);
    tracePolyline(pts, shape.kind !== "line"); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = "#fffdf5"; ctx.strokeStyle = "#1d1b16"; ctx.lineWidth = 2;
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.stroke(); } // handles
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

  function drawHands(f: Fit, info: HandInfo[]) {
    for (const { lm, slot } of info) {
      const P = lm.map(p => toScreen(f, ...px(f, p)));
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 2;
      ctx.beginPath();
      for (const c of connections) { ctx.moveTo(...P[c.start]); ctx.lineTo(...P[c.end]); }
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.8)";
      for (const p of P) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 7); ctx.fill(); }

      if (slot.pinched && !shape) { // pinch feedback
        const m = [(P[4][0] + P[8][0]) / 2, (P[4][1] + P[8][1]) / 2];
        ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(m[0], m[1], 12, 0, 7); ctx.stroke();
      }
      if (slot.pointing && slot.tip && !shape && wheel?.slot !== slot) { // pen cursor
        const [x, y] = toScreen(f, ...slot.tip);
        const w = penWidth(f);
        ctx.fillStyle = penColor; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, Math.max(w / 2 + 3, 6), 0, 7); ctx.fill(); ctx.stroke();
      }
    }
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
        if (mode === "draw") lastInfo = process(result, f, t);
      } catch (e) {
        onError("Hand tracking error: " + (e instanceof Error ? e.message : String(e)));
      }
      if (hook) Object.assign(hook, { penColor, wheel: wheel?.idx ?? null, shape: shape?.kind ?? null });
    }
    if (mode === "menu") return; // the start screen covers the canvas

    ctx.save(); ctx.translate(f.ox + f.dw, f.oy); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, f.dw, f.dh); ctx.restore();

    drawStrokes(f);
    drawShapePreview(f);
    if (lastInfo) drawHands(f, lastInfo);
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

  return { load, start, setMode, undo, clearAll, destroy };
}
