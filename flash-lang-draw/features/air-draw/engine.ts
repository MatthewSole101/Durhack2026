// Air Draw engine: hand tracking, gesture recognition and Canvas 2D rendering.
// Framework-free on purpose — AirDraw.tsx owns the DOM and UI state, this owns the frame loop.
//
// Gestures (draw mode):
//   one hand   🤏 pinch to draw · ✊✊ clench twice to undo · 👋 flick to clear · ✋ hold still for the colour wheel
//   two hands  line (both pinch) · rectangle (an L with each hand) · circle (an O made with both hands),
//              stretched by pulling the hands apart and placed on release
// A hand MediaPipe briefly loses (e.g. half out of frame) keeps its state for HAND_MEMORY_MS.

import type { HandLandmarker, HandLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  CLENCH_GAP_MS, CLENCH_MAX_MS, CURL_MAX, CURL_OFF, DRAW_ARM_MS, EXT_OFF, EXT_ON, FIST_FRAMES, FIST_INDEX_OFF, FIST_INDEX_ON, FLICK_COOLDOWN_MS,
  FLICK_DIST, FLICK_EXIT_SPEED, FLICK_WINDOW_MS, FLINCH_MS, HAND_DETECTION_CONF, HAND_MEMORY_JOIN, HAND_MEMORY_MS, HAND_MEMORY_REACH,
  HAND_PRESENCE_CONF, HAND_TRACKING_CONF, LOCAL_MODEL_URL, LOCAL_WASM_BASE, MODEL_URL, PALETTE, PEN_COLOR, PEN_SIZE,
  PEN_UP_FRAMES, PINCH_OFF, PINCH_ON, POSE_FRAMES, RECT_HOLD_MS, RECT_MIN_GAP, RECT_MIN_SIDE, SHAPE_ARM_FRAMES,
  SHAPE_COOLDOWN_MS, SHAPE_MIN_PX, SQUARE_SNAP, THUMB_CLOSED, THUMB_OPEN, TOUCH, WASM_BASE, WHEEL_COOLDOWN_MS,
  WHEEL_HOLD_MS, WHEEL_SPAN_DEG, WHEEL_STILL, WHEEL_UPRIGHT_DEG,
} from "./constants";

type Vision = Pick<typeof import("@mediapipe/tasks-vision"), "FilesetResolver" | "HandLandmarker">;
type Pt = [number, number];
type Pt3 = [number, number, number];
type Fit = { vw: number; vh: number; s: number; dw: number; dh: number; ox: number; oy: number };
type ShapeKind = "line" | "rect" | "circle";
// pts in un-mirrored video px. Shapes: line = 2 ends, rect = 4 corners, circle = [centre, a point on the rim]
type Stroke = { pts: Pt[]; active: boolean; color: string; shape?: ShapeKind };
type HistoryEntry = { type: "stroke"; stroke: Stroke } | { type: "clear"; saved: Stroke[] };
type CurlFinger = "middle" | "ring" | "pinky";
type Slot = {
  wrist: Pt;
  lm: NormalizedLandmark[] | null; // last landmarks seen
  lostAt: number | null; // when MediaPipe stopped reporting this hand (null = in view)
  // pen
  pinchFrames: number; relaxFrames: number; stroke: Stroke | null; pending: Pt[];
  lastStroke: Stroke | null; strokeBorn: number; // this hand's most recent stroke, and when its pen went down
  fx: OneEuro; fy: OneEuro; pen: Pt | null; // filtered pen point (between thumb and index tips), video px
  // finger states
  idxExt: boolean; idxCurled: boolean; thumbIn: boolean; curled: Record<CurlFinger, boolean>;
  palm: number; // wrist → middle knuckle, video px (3D)
  pinched: boolean; openPalm: boolean; lPose: boolean;
  balled: boolean; // a fist this frame
  // ✊ debounced fist + clench counting
  fist: boolean; fistFrames: number; openFrames: number; fistStart: number; lastClenchEnd: number;
  fistIgnore: boolean; // this fist was used for something else (wheel pick, placing a shape)
  ignoreFistUntil: number;
  still: { x: number; y: number; t: number } | null; // where an open palm started holding still
  wheelBlockUntil: number;
  trail: { t: number; x: number; y: number; open: boolean; pen: boolean }[];
  dbg: { index: number; pinch: number };
};
type HandInfo = { lm: NormalizedLandmark[]; slot: Slot; ghost?: boolean };
type Wheel = { slot: Slot; theta: number; idx: number; fistFrames: number; center: Pt; radius: number };
type Shape = { kind: ShapeKind; pts: Pt[]; handles: Pt[]; releaseFrames: number };

// Test builds only (NEXT_PUBLIC_AIR_DRAW_TEST=1): a mock landmarker can be injected and state is observable.
const TEST_BUILD = process.env.NEXT_PUBLIC_AIR_DRAW_TEST === "1";
type TestHook = {
  strokes: Stroke[]; toasts: string[];
  screenToVideo: (x: number, y: number) => Pt;
  penColor: string; wheel: number | null; shape: ShapeKind | null; hands: number; remembered: number;
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

/** Corner of an L: the web between the thumb and the index finger (thumb MCP ↔ index MCP). */
const crotch = (f: Fit, lm: NormalizedLandmark[]) => mid(px(f, lm[2]), px(f, lm[5]));
/** Where a pinch closes: between the thumb tip and the index tip. */
const pinchPoint = (f: Fit, lm: NormalizedLandmark[]) => mid(px(f, lm[4]), px(f, lm[8]));

function newSlot(): Slot {
  return {
    wrist: [0, 0], lm: null, lostAt: null,
    pinchFrames: 0, relaxFrames: 0, stroke: null, pending: [], lastStroke: null, strokeBorn: 0,
    fx: new OneEuro(), fy: new OneEuro(), pen: null,
    idxExt: false, idxCurled: false, thumbIn: false, curled: { middle: false, ring: false, pinky: false },
    palm: 1, pinched: false, openPalm: false, lPose: false, balled: false,
    fist: false, fistFrames: 0, openFrames: 0, fistStart: 0, lastClenchEnd: -1e9, fistIgnore: false, ignoreFistUntil: 0,
    still: null, wheelBlockUntil: 0, trail: [], dbg: { index: 0, pinch: 0 },
  };
}

// One landmarker per page, shared across mounts: the model is heavy, and React StrictMode
// mounts effects twice in dev — building (and tearing down) a second GL graph stalls the first.
type Shared = { landmarker: HandLandmarker; connections: { start: number; end: number }[] };
let sharedLandmarker: Promise<Shared> | null = null;

/** The self-hosted copy if it's there (see scripts/setup-mediapipe.mjs), else the CDN. */
async function fetchModel(): Promise<Uint8Array> {
  let lastError: unknown;
  for (const url of [LOCAL_MODEL_URL, MODEL_URL]) {
    try {
      const res = await fetch(url);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      lastError = new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) { lastError = e; }
  }
  throw lastError;
}
async function wasmBase(): Promise<string> {
  try {
    if ((await fetch(`${LOCAL_WASM_BASE}/vision_wasm_internal.js`, { method: "HEAD" })).ok) return LOCAL_WASM_BASE;
  } catch { /* fall through to the CDN */ }
  return WASM_BASE;
}

function loadLandmarker(): Promise<Shared> {
  sharedLandmarker ??= (async () => {
    const t0 = performance.now(), ms = (a: number, b = performance.now()) => `${Math.round(b - a)}ms`;
    const mock = TEST_BUILD ? (window as TestWindow).__airDrawMock : undefined;
    // runtime, WASM location and model all download in parallel (they used to be one after another)
    const [vision, base, model] = await Promise.all([
      mock ?? import("@mediapipe/tasks-vision"),
      mock ? WASM_BASE : wasmBase(),
      mock ? new Uint8Array() : fetchModel(),
    ]);
    const tFetched = performance.now();
    const fileset = await vision.FilesetResolver.forVisionTasks(base);
    const opts = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetBuffer: model.slice(), delegate }, // a copy each try: the buffer may be consumed
      runningMode: "VIDEO" as const, numHands: 2,
      minHandDetectionConfidence: HAND_DETECTION_CONF,
      minHandPresenceConfidence: HAND_PRESENCE_CONF,
      minTrackingConfidence: HAND_TRACKING_CONF,
    });
    let landmarker: HandLandmarker, delegate = "GPU";
    try { landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch { delegate = "CPU"; landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts("CPU")); } // WebGL fallback
    const tCreated = performance.now();
    // The first inference compiles shaders and can block the page for a while. Pay that cost
    // here, under "Loading hand tracking…", rather than as a freeze right after the camera starts.
    try {
      const blank = document.createElement("canvas");
      blank.width = blank.height = 64;
      blank.getContext("2d")!.fillRect(0, 0, 64, 64);
      landmarker.detectForVideo(blank, performance.now());
    } catch { /* warm-up is best-effort */ }
    if (!mock) {
      console.info(`[air-draw] hand tracking ready in ${ms(t0)} — download ${ms(t0, tFetched)} (${base === LOCAL_WASM_BASE ? "local" : "CDN"}), ` +
        `${delegate} setup ${ms(tFetched, tCreated)}, first frame ${ms(tCreated)}`);
    }
    return { landmarker, connections: vision.HandLandmarker.HAND_CONNECTIONS };
  })();
  sharedLandmarker.catch(() => { sharedLandmarker = null; }); // allow a retry after a failed load
  return sharedLandmarker;
}

/** Screen position (CSS px) of the index fingertip, or null when no hand is in view. */
export type Pointer = { x: number; y: number } | null;

/**
 * "menu": track the fingertip and report it through onPointer; nothing is drawn.
 * "draw": the full gesture set, rendered to the canvas (the fingertip is still reported, except while drawing).
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
  let debug = false; // D: show finger scores next to each hand
  const cursorFx = new OneEuro(), cursorFy = new OneEuro();

  const strokes: Stroke[] = [];
  const history: HistoryEntry[] = [];
  let slots: Slot[] = []; // hands in view first, then remembered ones
  let lastInfo: HandInfo[] | null = null, lastVideoTime = -1, lastFlickT = -1e9;
  let penColor: string = PEN_COLOR;
  let wheel: Wheel | null = null;
  let shape: Shape | null = null;
  const arming = { line: 0, circle: 0, rectSince: 0 }; // two-hand shape candidates (frames / start time)
  let shapeBlockUntil = 0;

  let toast = onToast;
  let hook: TestHook | null = null;
  if (TEST_BUILD) {
    const h: TestHook = {
      strokes, toasts: [], penColor, wheel: null, shape: null, hands: 0, remembered: 0,
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
    if (k === "d") debug = !debug;
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
  function removeStroke(st: Stroke) { // silently, as if it was never drawn
    const i = strokes.indexOf(st);
    if (i >= 0) strokes.splice(i, 1);
    const j = history.findIndex(h => h.type === "stroke" && h.stroke === st);
    if (j >= 0) history.splice(j, 1);
  }
  function endStroke(slot: Slot) {
    const st = slot.stroke;
    if (!st) return;
    st.active = false;
    if (!st.pts.length) removeStroke(st);
    slot.stroke = null;
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

  // ---------------- which hand is which ----------------
  function forget(s: Slot) {
    endStroke(s);
    if (wheel?.slot === s) wheel = null;
  }

  /**
   * Pair this frame's hands with the hands we know (in view or remembered), nearest wrist first,
   * so each physical hand keeps its state even when MediaPipe drops it for a moment or swaps the order.
   * Returns the slot for each detected hand.
   */
  function trackHands(wrists: Pt[], f: Fit, t: number): Slot[] {
    const reach = HAND_MEMORY_REACH * f.vw;
    const pairs: { i: number; s: Slot; d: number }[] = [];
    wrists.forEach((w, i) => slots.forEach(s => {
      const d = dist(w, s.wrist);
      if (s.lostAt === null || d < reach) pairs.push({ i, s, d });
    }));
    pairs.sort((a, b) => a.d - b.d);
    const found: (Slot | undefined)[] = [];
    const used = new Set<Slot>();
    for (const { i, s } of pairs) if (!found[i] && !used.has(s)) { found[i] = s; used.add(s); }

    let remembered: Slot[] = [];
    for (const s of slots) {
      if (used.has(s)) continue;
      if (s.lostAt === null) { s.lostAt = t; flickOnExit(s); } // just went missing
      if (t - s.lostAt < HAND_MEMORY_MS) remembered.push(s); else forget(s);
    }
    const live = wrists.map((wrist, i) => {
      const s = found[i];
      if (!s) return Object.assign(newSlot(), { wrist });
      // back from memory, but somewhere else: carry on, just don't join the stroke up across the jump
      if (s.lostAt !== null && dist(wrist, s.wrist) > HAND_MEMORY_JOIN * f.vw) endStroke(s);
      return Object.assign(s, { wrist, lostAt: null });
    });
    while (live.length + remembered.length > 2) forget(remembered.shift()!); // MediaPipe tracks two hands at most
    remembered = remembered.filter(s => s.lm);
    slots = [...live, ...remembered];
    return live;
  }

  // ---------------- per-hand gesture analysis ----------------
  const shapePending = () => arming.line > 0 || arming.circle > 0 || arming.rectSince > 0;

  function analyse(f: Fit, lm: NormalizedLandmark[], s: Slot, t: number): HandInfo {
    s.lm = lm;
    const wrist = p3(f, lm[0]);
    const extScore = ([, pip, tip]: readonly number[]) => dist(wrist, p3(f, lm[tip])) / (dist(wrist, p3(f, lm[pip])) || 1);

    // finger states with hysteresis
    const sc = { index: extScore(FINGERS.index), middle: extScore(FINGERS.middle), ring: extScore(FINGERS.ring), pinky: extScore(FINGERS.pinky) };
    s.idxExt = s.idxExt ? sc.index > EXT_OFF : sc.index > EXT_ON;
    s.idxCurled = s.idxCurled ? sc.index < FIST_INDEX_OFF : sc.index < FIST_INDEX_ON;
    for (const k of CURL_FINGERS) s.curled[k] = s.curled[k] ? sc[k] < CURL_OFF : sc[k] < CURL_MAX;
    const openCount = Object.values(sc).filter(v => v > EXT_ON).length;
    const palm = s.palm = dist(wrist, p3(f, lm[9])) || 1;
    const othersCurled = s.curled.middle && s.curled.ring && s.curled.pinky;

    // thumb: tucked if its tip sits near the index/middle knuckles or middle-finger PIP
    const thumbTip = p3(f, lm[4]);
    const thumbR = Math.min(...[5, 6, 9, 10].map(i => dist(thumbTip, p3(f, lm[i])))) / palm;
    s.thumbIn = s.thumbIn ? thumbR < THUMB_OPEN : thumbR < THUMB_CLOSED;

    // ✊ fist this frame. Checked before the pinch: a fist's thumb often lands on the index and reads as one.
    s.balled = s.idxCurled && othersCurled;
    // 🤏 pinch (thumb tip ↔ index tip, relative to palm size)
    const pinchR = dist(thumbTip, p3(f, lm[8])) / palm;
    s.pinched = !s.balled && (s.pinched ? pinchR < PINCH_OFF : pinchR < PINCH_ON);
    s.openPalm = openCount >= 4 && !s.thumbIn && !s.pinched;
    s.lPose = s.idxExt && !s.thumbIn && othersCurled && !s.pinched; // 🫷 "L": index up, thumb out
    s.dbg = { index: sc.index, pinch: pinchR };

    const pen = pinchPoint(f, lm);
    s.pen = [s.fx.filter(pen[0], t), s.fy.filter(pen[1], t)];

    const twoHand = shape !== null || shapePending(); // a two-hand shape owns both hands
    updateFist(s, t, wheel?.slot !== s && !twoHand);
    if (wheel?.slot === s) { updateWheel(f, lm, s, t); return { lm, slot: s }; }

    // 🤏 pen down after POSE_FRAMES of pinch (backfilling those frames), up after PEN_UP_FRAMES without
    if (s.pinched) { s.pinchFrames++; s.relaxFrames = 0; } else { s.relaxFrames++; s.pinchFrames = 0; s.pending.length = 0; }
    if (twoHand) dropYoungStroke(s, t);
    if (twoHand || t < armAt || s.relaxFrames >= PEN_UP_FRAMES) { endStroke(s); s.pending.length = 0; }
    else if (s.pinched) {
      if (!s.stroke) s.pending.push(s.pen);
      if (!s.stroke && s.pinchFrames >= POSE_FRAMES) {
        s.stroke = s.lastStroke = addStroke({ pts: [], active: true, color: penColor });
        s.strokeBorn = t;
      }
      if (s.stroke) {
        for (const p of s.pending.length ? s.pending.splice(0) : [s.pen]) {
          const last = s.stroke.pts.at(-1);
          if (!last || dist(p, last) > 1.5) s.stroke.pts.push(p);
        }
      }
    }

    // 👋 flick → clear: fast sideways travel of the palm while the hand isn't drawing
    let cx = 0, cy = 0;
    for (const i of [0, 5, 9, 13, 17]) { cx += lm[i].x / 5; cy += lm[i].y / 5; } // palm centre: steadier than fingertips when blurred
    cy *= f.vh / f.vw; // same units as x
    s.trail.push({ t, x: cx, y: cy, open: openCount >= 3 && !s.pinched, pen: !!s.stroke });
    while (s.trail.length && t - s.trail[0].t > FLICK_WINDOW_MS) s.trail.shift();
    if (!twoHand && s.trail.length >= 3) {
      const b = s.trail.at(-1)!;
      // furthest any earlier point in the window is from here, counted only when mostly sideways
      const travel = Math.max(...s.trail.map(a => Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? Math.abs(b.x - a.x) : 0));
      if (travel > FLICK_DIST && flickPose(s.trail)) flick(s);
    }

    // ✋ open palm held still (one hand only) → colour wheel
    if (s.openPalm && !twoHand && slots.length === 1 && t >= s.wheelBlockUntil && Math.abs(handTilt(f, lm)) < WHEEL_UPRIGHT_DEG) {
      if (!s.still || Math.hypot(cx - s.still.x, cy - s.still.y) > WHEEL_STILL) s.still = { x: cx, y: cy, t };
      else if (t - s.still.t >= WHEEL_HOLD_MS) openWheel(f, lm, s);
    } else s.still = null;

    return { lm, slot: s };
  }

  // a stroke only a moment old was the hand passing through a pinch (closing into a fist, or
  // starting a two-hand line), not drawing: take it back
  function dropYoungStroke(s: Slot, t: number) {
    const st = s.lastStroke;
    if (!st || t - s.strokeBorn >= FLINCH_MS) return;
    if (s.stroke === st) s.stroke = null;
    removeStroke(st);
    s.lastStroke = null;
  }

  // ✊ debounced fist; two quick clenches → undo. `act` = false while the fist is busy with something else.
  function updateFist(s: Slot, t: number, act: boolean) {
    if (s.balled) { s.fistFrames++; s.openFrames = 0; } else { s.openFrames++; s.fistFrames = 0; }
    if (!s.fist && s.fistFrames >= FIST_FRAMES) {
      s.fist = true; s.fistStart = t;
      if (!act || t < s.ignoreFistUntil) { s.fistIgnore = true; s.lastClenchEnd = -1e9; return; }
      dropYoungStroke(s, t);
      if (t - s.lastClenchEnd <= CLENCH_GAP_MS) { undo(); s.fistIgnore = true; s.lastClenchEnd = -1e9; }
    } else if (s.fist && s.openFrames >= FIST_FRAMES) {
      s.fist = false;
      const counts = act && !s.fistIgnore && t - s.fistStart <= CLENCH_MAX_MS;
      s.fistIgnore = false;
      s.lastClenchEnd = counts ? t : -1e9;
    }
  }

  // ---------------- flick ----------------
  // the hand was open (not drawing, not a fist) for a good part of the motion; blur makes single frames unreliable
  const flickPose = (trail: Slot["trail"]) =>
    !trail.some(p => p.pen) && trail.filter(p => p.open).length / trail.length >= 0.34;

  function flick(s: Slot) {
    if (shape || wheel || performance.now() - lastFlickT < FLICK_COOLDOWN_MS) return;
    lastFlickT = performance.now(); s.trail.length = 0;
    clearAll();
  }
  // a fast flick often carries the hand out of frame (or blurs it away) before it has travelled far enough
  function flickOnExit(s: Slot) {
    const b = s.trail.at(-1);
    if (!b) return;
    const recent = s.trail.filter(p => b.t - p.t <= 100); // the latest speed, not the run-up
    const a = recent[0];
    if (recent.length < 2 || b.t - a.t < 30) return;
    const vx = (b.x - a.x) / ((b.t - a.t) / 1000), vy = (b.y - a.y) / ((b.t - a.t) / 1000);
    if (Math.abs(vx) > FLICK_EXIT_SPEED && Math.abs(vx) >= Math.abs(vy) && flickPose(recent)) flick(s);
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
    if (!s.balled) w.idx = wheelIndex(w.theta);
    w.fistFrames = s.balled ? w.fistFrames + 1 : 0;
    if (w.fistFrames >= POSE_FRAMES) { // ✊ pick
      penColor = PALETTE[w.idx].color;
      toast(`🎨 ${PALETTE[w.idx].name}`);
      wheel = null;
      s.wheelBlockUntil = t + WHEEL_COOLDOWN_MS;
      s.fistIgnore = true; // opening the hand afterwards isn't half of an undo
    }
  }

  // ---------------- two-hand shapes ----------------
  function resetArming() { arming.line = 0; arming.circle = 0; arming.rectSince = 0; }

  function shapeGeometry(kind: ShapeKind, f: Fit, a: HandInfo, b: HandInfo): { pts: Pt[]; handles: Pt[] } {
    if (kind === "line") { // between the two pinch points
      const pts = [pinchPoint(f, a.lm), pinchPoint(f, b.lm)];
      return { pts, handles: pts };
    }
    if (kind === "rect") { // the two L corners (thumb–index webs) are opposite corners
      const [x1, y1] = crotch(f, a.lm);
      let [x2, y2] = crotch(f, b.lm);
      const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      if (Math.abs(w - h) < SQUARE_SNAP * Math.max(w, h)) { // near-square → square
        const side = (w + h) / 2;
        x2 = x1 + Math.sign(x2 - x1 || 1) * side; y2 = y1 + Math.sign(y2 - y1 || 1) * side;
      }
      return { pts: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], handles: [[x1, y1], [x2, y2]] };
    }
    // circle: held between the hands like a rubber band. Each hand grips it between its thumb and
    // index tips; while the O is closed it's the size of the O's hole.
    const gA = pinchPoint(f, a.lm), gB = pinchPoint(f, b.lm);
    const hole = dist(mid(px(f, a.lm[8]), px(f, b.lm[8])), mid(px(f, a.lm[4]), px(f, b.lm[4])));
    const c = mid(gA, gB), r = Math.max(dist(gA, gB), hole) / 2;
    return { pts: [c, [c[0] + r, c[1]]], handles: [gA, gB] };
  }

  function shapeHeld(kind: ShapeKind, a: Slot, b: Slot) {
    if (kind === "line") return a.pinched && b.pinched;
    if (kind === "rect") return a.lPose && b.lPose;
    return a.idxExt && b.idxExt && !a.balled && !b.balled; // circle: until a hand closes
  }

  const shapeSize = (kind: ShapeKind, pts: Pt[]) => {
    if (kind === "circle") return 2 * dist(pts[0], pts[1]);
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };

  function placeShape(t: number, hands: HandInfo[]) {
    const sh = shape!;
    shape = null;
    shapeBlockUntil = t + SHAPE_COOLDOWN_MS;
    // closing the hands to let go isn't half of an undo, even if the fist forms a moment later
    for (const { slot } of hands) slot.ignoreFistUntil = t + SHAPE_COOLDOWN_MS;
    if (shapeSize(sh.kind, sh.pts) < SHAPE_MIN_PX) return;
    addStroke({ pts: sh.pts, active: false, color: penColor, shape: sh.kind });
  }

  function updateShapes(f: Fit, hands: HandInfo[], t: number) {
    const two = hands.length === 2 && !wheel;
    if (shape) {
      if (two && shapeHeld(shape.kind, hands[0].slot, hands[1].slot)) {
        shape.releaseFrames = 0;
        Object.assign(shape, shapeGeometry(shape.kind, f, hands[0], hands[1])); // a remembered hand holds its last pose
      } else if (++shape.releaseFrames >= POSE_FRAMES) placeShape(t, hands); // the last held geometry
      return;
    }
    // a new shape needs both hands actually in view
    if (!two || hands.some(h => h.ghost) || t < shapeBlockUntil) { resetArming(); return; }

    const [a, b] = hands, A = a.slot, B = b.slot;
    const palm = (A.palm + B.palm) / 2;
    const tipGap = dist(px(f, a.lm[8]), px(f, b.lm[8])) / palm;
    const thumbGap = dist(px(f, a.lm[4]), px(f, b.lm[4])) / palm;
    const [ca, cb] = [crotch(f, a.lm), crotch(f, b.lm)];

    // ◯ index tips together and thumb tips together
    const circlePose = A.idxExt && B.idxExt && !A.pinched && !B.pinched && tipGap < TOUCH && thumbGap < TOUCH;
    arming.circle = circlePose ? arming.circle + 1 : 0;
    arming.line = A.pinched && B.pinched ? arming.line + 1 : 0;
    // ▭ two Ls on a diagonal (hands side by side making an O also pass through two Ls, but level)
    const rectPose = A.lPose && B.lPose && tipGap > RECT_MIN_GAP
      && Math.abs(ca[0] - cb[0]) > RECT_MIN_SIDE * palm && Math.abs(ca[1] - cb[1]) > RECT_MIN_SIDE * palm;
    arming.rectSince = rectPose ? arming.rectSince || t : 0;

    const kind: ShapeKind | null =
      arming.circle >= SHAPE_ARM_FRAMES ? "circle"
      : arming.line >= SHAPE_ARM_FRAMES ? "line"
      : arming.rectSince && t - arming.rectSince >= RECT_HOLD_MS ? "rect"
      : null;
    if (!kind) return;
    resetArming();
    for (const s of [A, B]) { dropYoungStroke(s, t); endStroke(s); s.lastClenchEnd = -1e9; }
    shape = { kind, ...shapeGeometry(kind, f, a, b), releaseFrames: 0 };
  }

  function process(result: HandLandmarkerResult, f: Fit, t: number): HandInfo[] {
    const hands = result.landmarks;
    const live = trackHands(hands.map(lm => px(f, lm[0])), f, t);
    const info = hands.map((lm, i) => analyse(f, lm, live[i], t));
    for (const s of slots) if (s.lostAt !== null) info.push({ lm: s.lm!, slot: s, ghost: true });
    updateShapes(f, info, t);
    return info;
  }

  // the first hand's index fingertip is the on-screen cursor (start screen buttons, back button)
  function trackPointer(result: HandLandmarkerResult, f: Fit, t: number, drawing: boolean) {
    const lm = result.landmarks[0];
    if (!lm || drawing) { cursorFx.reset(); cursorFy.reset(); onPointer?.(null); return; }
    const [x, y] = toScreen(f, cursorFx.filter(lm[8].x * f.vw, t), cursorFy.filter(lm[8].y * f.vh, t));
    onPointer?.({ x, y });
  }

  // ---------------- rendering ----------------
  const penWidth = (f: Fit) => PEN_SIZE * f.dh / 720;

  function traceShape(f: Fit, kind: ShapeKind, pts: Pt[]) {
    const P = pts.map(p => toScreen(f, p[0], p[1]));
    ctx.beginPath();
    if (kind === "circle") { ctx.arc(P[0][0], P[0][1], dist(P[0], P[1]), 0, 2 * Math.PI); return; }
    ctx.moveTo(P[0][0], P[0][1]);
    for (const p of P.slice(1)) ctx.lineTo(p[0], p[1]);
    if (kind === "rect") ctx.closePath();
  }

  function drawStrokes(f: Fit) {
    const w = penWidth(f);
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.lineWidth = w; ctx.shadowBlur = w * 1.2;
    for (const s of strokes) {
      if (!s.pts.length) continue;
      ctx.strokeStyle = ctx.fillStyle = ctx.shadowColor = s.color;
      if (s.shape) { traceShape(f, s.shape, s.pts); ctx.stroke(); continue; }
      const pts = s.pts.map(p => toScreen(f, p[0], p[1]));
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
    ctx.save();
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.lineWidth = penWidth(f); ctx.strokeStyle = penColor; ctx.globalAlpha = 0.85;
    ctx.setLineDash([penWidth(f) * 2, penWidth(f) * 2]);
    traceShape(f, shape.kind, shape.pts); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = "#fffdf5"; ctx.strokeStyle = "#1d1b16"; ctx.lineWidth = 2;
    for (const h of shape.handles) { // where the hands are holding it
      const [x, y] = toScreen(f, h[0], h[1]);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.fill(); ctx.stroke();
    }
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
    for (const { lm, slot, ghost } of info) {
      const P = lm.map(p => toScreen(f, ...px(f, p)));
      ctx.globalAlpha = ghost ? 0.3 : 1; // a remembered hand: faded where it was last seen
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 2;
      ctx.beginPath();
      for (const c of connections) { ctx.moveTo(...P[c.start]); ctx.lineTo(...P[c.end]); }
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.8)";
      for (const p of P) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 7); ctx.fill(); }
      ctx.globalAlpha = 1;
      if (ghost) continue;

      // pen: a ring where the pinch will land, filled while drawing
      if (slot.pen && !shape && wheel?.slot !== slot && !slot.balled) {
        const [x, y] = toScreen(f, ...slot.pen);
        const r = Math.max(penWidth(f) / 2 + 3, 6);
        ctx.lineWidth = 2.5; ctx.strokeStyle = slot.stroke ? "#fff" : penColor; ctx.fillStyle = penColor;
        ctx.beginPath(); ctx.arc(x, y, slot.stroke ? r : r + 4, 0, 7);
        if (slot.stroke) ctx.fill();
        ctx.stroke();
      }
      if (debug) {
        const tags = [slot.pinched && "PINCH", slot.fist && "FIST", slot.lPose && "L", slot.openPalm && "OPEN"].filter(Boolean).join(" ");
        const text = `index ${slot.dbg.index.toFixed(2)} · pinch ${slot.dbg.pinch.toFixed(2)}  ${tags}`;
        ctx.font = "600 13px ui-monospace, monospace"; ctx.textAlign = "center";
        ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.75)"; ctx.fillStyle = "#fffdf5";
        ctx.strokeText(text, P[0][0], P[0][1] + 24); ctx.fillText(text, P[0][0], P[0][1] + 24);
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
        if (mode === "draw") lastInfo = process(result, f, t);
        // no cursor while the first hand is drawing, so ink near the back button can't press it
        const first = mode === "draw" ? slots[0] : undefined;
        trackPointer(result, f, t, !!first && first.lostAt === null && (first.pinched || !!first.stroke));
      } catch (e) {
        onError("Hand tracking error: " + (e instanceof Error ? e.message : String(e)));
      }
      if (hook) {
        Object.assign(hook, {
          penColor, wheel: wheel?.idx ?? null, shape: shape?.kind ?? null,
          hands: slots.filter(s => s.lostAt === null).length, remembered: slots.filter(s => s.lostAt !== null).length,
        });
      }
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
