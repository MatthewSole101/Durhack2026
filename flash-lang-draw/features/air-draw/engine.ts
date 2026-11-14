// Air Draw engine: hand tracking, gesture recognition and Canvas 2D rendering.
// Framework-free on purpose — AirDraw.tsx owns the DOM and UI state, this owns the frame loop.

import type { HandLandmarker, HandLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  CURL_MAX, CURL_OFF, DOUBLE_GAP_MS, EXT_OFF, EXT_ON, FLICK_COOLDOWN_MS, FLICK_DIST, FLICK_WINDOW_MS,
  MODEL_URL, PEN_COLOR, PEN_SIZE, PINCH_OFF, PINCH_ON, POSE_FRAMES, TAP_MAX_MS, THUMB_CLOSED, THUMB_OPEN,
  WASM_BASE,
} from "./constants";

type Vision = Pick<typeof import("@mediapipe/tasks-vision"), "FilesetResolver" | "HandLandmarker">;
type Pt = [number, number];
type Pt3 = [number, number, number];
type Fit = { vw: number; vh: number; s: number; dw: number; dh: number; ox: number; oy: number };
type Stroke = { pts: Pt[]; active: boolean }; // pts in un-mirrored video px
type HistoryEntry = { type: "stroke"; stroke: Stroke } | { type: "clear"; saved: Stroke[] };
type CurlFinger = "middle" | "ring" | "pinky";
type Slot = {
  wrist: Pt;
  pointFrames: number; relaxFrames: number; pointing: boolean; stroke: Stroke | null;
  fx: OneEuro; fy: OneEuro; tip: Pt | null;
  pinched: boolean; pinchStart: number; lastTapEnd: number;
  idxExt: boolean; thumbIn: boolean; curled: Record<CurlFinger, boolean>;
  trail: { t: number; x: number; y: number; open: boolean }[];
};
type HandInfo = { lm: NormalizedLandmark[]; slot: Slot };

// Test builds only (NEXT_PUBLIC_AIR_DRAW_TEST=1): a mock landmarker can be injected and state is observable.
const TEST_BUILD = process.env.NEXT_PUBLIC_AIR_DRAW_TEST === "1";
type TestWindow = Window & {
  __airDrawMock?: Vision;
  __airDraw?: { strokes: Stroke[]; toasts: string[] };
};

const FINGERS = { index: [5, 6, 8], middle: [9, 10, 12], ring: [13, 14, 16], pinky: [17, 18, 20] } as const; // mcp, pip, tip
const CURL_FINGERS: CurlFinger[] = ["middle", "ring", "pinky"];

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

function newSlot(): Slot {
  return {
    wrist: [0, 0], pointFrames: 0, relaxFrames: 0, pointing: false, stroke: null,
    fx: new OneEuro(), fy: new OneEuro(), tip: null,
    pinched: false, pinchStart: 0, lastTapEnd: -1e9,
    idxExt: false, thumbIn: false, curled: { middle: false, ring: false, pinky: false },
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

export type AirDrawOptions = {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  onToast: (msg: string) => void;
  onError: (msg: string) => void;
};

export type AirDrawEngine = {
  /** Download the WASM runtime + model. Resolves when the landmarker is ready. */
  load: () => Promise<void>;
  /** Ask for the camera and begin the frame loop. Rejects if the camera is unavailable. */
  start: () => Promise<void>;
  undo: () => void;
  clearAll: () => void;
  destroy: () => void;
};

export function createAirDraw({ video, canvas, onToast, onError }: AirDrawOptions): AirDrawEngine {
  const ctx = canvas.getContext("2d")!;
  let landmarker: HandLandmarker | null = null;
  let connections: { start: number; end: number }[] = [];
  let stream: MediaStream | null = null;
  let raf = 0, destroyed = false;
  let W = 0, H = 0;

  const strokes: Stroke[] = [];
  const history: HistoryEntry[] = [];
  let slots: Slot[] = [];
  let lastInfo: HandInfo[] | null = null, lastVideoTime = -1, lastFlickT = -1e9;

  let toast = onToast;
  if (TEST_BUILD) {
    const hook = { strokes, toasts: [] as string[] };
    (window as TestWindow).__airDraw = hook;
    toast = msg => { hook.toasts.push(msg); onToast(msg); };
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function onKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
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

  async function start() {
    if (stream) return;
    const s = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false,
    });
    if (destroyed) { s.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = s;
    await new Promise<void>(r => {
      if (video.readyState >= 1) r();
      else video.addEventListener("loadedmetadata", () => r(), { once: true });
    });
    await video.play();
    stream = s;
    raf = requestAnimationFrame(loop);
  }

  // ---------------- drawing actions ----------------
  function beginStroke(): Stroke {
    const s: Stroke = { pts: [], active: true };
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
  }

  function analyse(f: Fit, lm: NormalizedLandmark[], s: Slot, t: number): HandInfo {
    const wrist = p3(f, lm[0]);
    const extScore = ([, pip, tip]: readonly number[]) => dist(wrist, p3(f, lm[tip])) / (dist(wrist, p3(f, lm[pip])) || 1);

    // finger states with hysteresis
    const sc = { index: extScore(FINGERS.index), middle: extScore(FINGERS.middle), ring: extScore(FINGERS.ring), pinky: extScore(FINGERS.pinky) };
    s.idxExt = s.idxExt ? sc.index > EXT_OFF : sc.index > EXT_ON;
    for (const k of CURL_FINGERS) s.curled[k] = s.curled[k] ? sc[k] < CURL_OFF : sc[k] < CURL_MAX;
    const openCount = Object.values(sc).filter(v => v > EXT_ON).length;
    const palm = dist(wrist, p3(f, lm[9])) || 1;

    // thumb: tucked if its tip sits near the index/middle knuckles or middle-finger PIP
    const thumbTip = p3(f, lm[4]);
    const thumbR = Math.min(...[5, 6, 9, 10].map(i => dist(thumbTip, p3(f, lm[i])))) / palm;
    s.thumbIn = s.thumbIn ? thumbR < THUMB_OPEN : thumbR < THUMB_CLOSED;

    // pinch (thumb tip ↔ index tip, relative to palm size)
    const pinchR = dist(thumbTip, p3(f, lm[8])) / palm;
    const wasPinched = s.pinched;
    s.pinched = s.pinched ? pinchR < PINCH_OFF : pinchR < PINCH_ON;

    // ☝️ pointing pose → pen down after POSE_FRAMES, pen up after POSE_FRAMES without it
    const pose = s.idxExt && s.thumbIn && s.curled.middle && s.curled.ring && s.curled.pinky && !s.pinched;
    if (pose) { s.pointFrames++; s.relaxFrames = 0; } else { s.relaxFrames++; s.pointFrames = 0; }
    if (!s.pointing && s.pointFrames >= POSE_FRAMES) s.pointing = true;
    if (s.pointing && s.relaxFrames >= POSE_FRAMES) { s.pointing = false; endStroke(s); }

    const tip = px(f, lm[8]);
    s.tip = [s.fx.filter(tip[0], t), s.fy.filter(tip[1], t)];
    if (s.pointing && pose) {
      s.stroke ??= beginStroke();
      const last = s.stroke.pts.at(-1);
      if (!last || dist(s.tip, last) > 1.5) s.stroke.pts.push(s.tip);
    }

    // 🤏🤏 double pinch → undo
    if (!wasPinched && s.pinched) s.pinchStart = t;
    if (wasPinched && !s.pinched) {
      const dur = t - s.pinchStart;
      if (dur <= TAP_MAX_MS) {
        if (s.pinchStart - s.lastTapEnd <= DOUBLE_GAP_MS) { undo(); s.lastTapEnd = -1e9; }
        else s.lastTapEnd = t;
      } else s.lastTapEnd = -1e9;
    }

    // 👋 flick → clear: fast travel of the hand centre while the hand is open
    let cx = 0, cy = 0;
    for (const p of lm) { cx += p.x / 21; cy += p.y / 21; }
    s.trail.push({ t, x: cx, y: cy * f.vh / f.vw, open: openCount >= 3 });
    while (s.trail.length && t - s.trail[0].t > FLICK_WINDOW_MS) s.trail.shift();
    if (t - lastFlickT > FLICK_COOLDOWN_MS && s.trail.length >= 3) {
      const a = s.trail[0], b = s.trail.at(-1)!;
      const travel = Math.hypot(b.x - a.x, b.y - a.y);
      const openShare = s.trail.filter(p => p.open).length / s.trail.length;
      if (travel > FLICK_DIST && openShare >= 0.5) {
        lastFlickT = t; s.trail.length = 0;
        clearAll();
      }
    }
    return { lm, slot: s };
  }

  function process(result: HandLandmarkerResult, f: Fit, t: number): HandInfo[] {
    const hands = result.landmarks;
    trackHands(hands.map(lm => px(f, lm[0])));
    return hands.map((lm, i) => analyse(f, lm, slots[i], t));
  }

  // ---------------- rendering ----------------
  function drawStrokes(f: Fit) {
    const w = PEN_SIZE * f.dh / 720;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle = PEN_COLOR;
    ctx.shadowColor = PEN_COLOR; ctx.shadowBlur = w * 1.2;
    ctx.lineWidth = w;
    for (const s of strokes) {
      if (!s.pts.length) continue;
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

  function drawHands(f: Fit, info: HandInfo[]) {
    for (const { lm, slot } of info) {
      const P = lm.map(p => toScreen(f, ...px(f, p)));
      ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 2;
      ctx.beginPath();
      for (const c of connections) { ctx.moveTo(...P[c.start]); ctx.lineTo(...P[c.end]); }
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.8)";
      for (const p of P) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.5, 0, 7); ctx.fill(); }

      if (slot.pinched) { // pinch feedback
        const m = [(P[4][0] + P[8][0]) / 2, (P[4][1] + P[8][1]) / 2];
        ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(m[0], m[1], 12, 0, 7); ctx.stroke();
      }
      if (slot.pointing && slot.tip) { // pen cursor
        const [x, y] = toScreen(f, ...slot.tip);
        const w = PEN_SIZE * f.dh / 720;
        ctx.fillStyle = PEN_COLOR; ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
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
        lastInfo = process(landmarker.detectForVideo(video, t), f, t);
      } catch (e) {
        onError("Hand tracking error: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    ctx.save(); ctx.translate(f.ox + f.dw, f.oy); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, f.dw, f.dh); ctx.restore();

    drawStrokes(f);
    if (lastInfo) drawHands(f, lastInfo);
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

  return { load, start, undo, clearAll, destroy };
}
