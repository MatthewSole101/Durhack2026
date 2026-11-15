import type { Locator, Page } from "@playwright/test";
import type { QuickDrawTestHook } from "../../features/air-draw/AirDraw";
import type { Word } from "../../features/languages/words";

// There is no real hand in CI, so the gesture logic is driven by a mock landmarker that
// returns scripted synthetic hands. Scenes are timed inside the page (gestures are
// time-sensitive); the test just starts a scene and waits for it to finish.

type ShapeKind = "line" | "rect" | "circle";
declare global {
  interface Window {
    __airDraw: {
      strokes: { pts: [number, number][]; active: boolean; color: string; shape?: ShapeKind }[];
      toasts: string[];
      screenToVideo: (x: number, y: number) => [number, number];
      penColor: string;
      wheel: number | null;
      shape: ShapeKind | null;
      hands: [number, number]; // [live, remembered]
    };
    __gameDeck: Word[];
    __quickDraw: QuickDrawTestHook;
    __airDrawMock: unknown;
    __play: (scene: string) => void;
    __hover: (nx: number, ny: number, ms: number) => void;
    __sceneDone: boolean;
    __detectCalls: number;
  }
}

/** Init script: replaces MediaPipe with a landmarker that returns scripted hands. Must stay self-contained. */
export function installMock() {
  type P = [number, number, number];
  type Thumb = "out" | "tucked" | "pinch" | P; // or an explicit thumb-tip position (units)
  type HandSpec = {
    ext: [boolean, boolean, boolean, boolean]; // index, middle, ring, pinky extended?
    thumb: Thumb;
    dx?: number; // shift of the default wrist position, fraction of frame width
    tipAt?: [number, number]; // put the (pointing) index fingertip here, normalised video coords
    at?: [number, number]; // wrist position, normalised video coords…
    off?: [number, number]; // …plus this many units
    mirror?: boolean; // a left hand (thumb on the other side)
    rot?: number; // degrees, about the wrist (+ = clockwise in the video image)
  };

  const MCP: P[] = [[-30, -95, 0], [0, -100, 0], [28, -92, 0], [52, -80, 0]]; // index, middle, ring, pinky
  const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const ramp = (e: number, from: number, ms: number) => Math.min(Math.max((e - from) / ms, 0), 1);

  // Hand in "palm = 100 units" space, wrist at the origin, fingers pointing up (−y).
  function hand({ ext, thumb, dx = 0, tipAt, at, off = [0, 0], mirror, rot = 0 }: HandSpec, vw: number, vh: number) {
    const pts: P[] = [[0, 0, 0], [-35, -25, 0], [-60, -50, 0], [-80, -70, 0], [0, 0, 0]];
    MCP.forEach((m, i) => {
      pts.push(m);
      if (ext[i]) pts.push(add(m, [0, -40, 0]), add(m, [0, -65, 0]), add(m, [0, -90, 0])); // straight line above the MCP
      else pts.push(add(m, [0, -30, -10]), add(m, [0, -25, -35]), add(m, [0, 10, -30])); // tip folded back below the MCP
    });
    pts[4] = Array.isArray(thumb) ? thumb
      : thumb === "out" ? [-130, -90, 0] : thumb === "tucked" ? [-8, -92, -30] : pts[8]; // pinch = on the index tip
    const k = vh / 720; // 100 units ≈ 100 px on a 720p frame
    const c = Math.cos(rot * Math.PI / 180), s = Math.sin(rot * Math.PI / 180), m = mirror ? -1 : 1;
    // extended index tip sits at (-30, -185) units from the wrist
    const ox = (at ? at[0] * vw : tipAt ? tipAt[0] * vw + 30 * k : vw * (0.3 + dx)) + off[0] * k;
    const oy = (at ? at[1] * vh : tipAt ? tipAt[1] * vh + 185 * k : vh * 0.7) + off[1] * k;
    return pts.map(([x0, y, z]) => {
      const x = x0 * m;
      return { x: (ox + (x * c - y * s) * k) / vw, y: (oy + (x * s + y * c) * k) / vh, z: (z * k) / vw, visibility: 0 };
    });
  }

  const POINT: HandSpec["ext"] = [true, false, false, false];
  const OPEN: HandSpec["ext"] = [true, true, true, true];
  const FIST: HandSpec["ext"] = [false, false, false, false];
  // a fist with the thumb straight out to the side; a right hand's thumb points right on screen
  const THUMB_SIDE: Thumb = [-150, -55, 0];

  // scene(elapsed ms) → hands, or null when the scene is over (no hands in frame between scenes)
  // (an empty list is a frame where the hand isn't detected, e.g. partly off-screen)
  const scenes: Record<string, (e: number) => HandSpec[] | null> = {
    // 🤏 pinch while moving: one stroke
    pinchDraw: e => (e > 700 ? null : [{ ext: POINT, thumb: "pinch", dx: 0.1 * (e / 700) }]),
    // ☝️ pointing without a pinch draws nothing
    point: e => (e > 700 ? null : [{ ext: POINT, thumb: "tucked", dx: 0.1 * (e / 700) }]),
    // a pinched stroke with an 80 ms pinch flicker and a 150 ms tracking dropout: still one stroke
    pinchGlitchy: e => {
      if (e > 1100) return null;
      if (e >= 650 && e < 800) return [];
      return [{ ext: POINT, thumb: e >= 400 && e < 480 ? "out" : "pinch", dx: 0.15 * (e / 1100) }];
    },
    // two hands drawing: the second starts pinching well after the first, so it's not a line
    twoPinchDraw: e => {
      if (e > 900) return null;
      const a: HandSpec = { ext: POINT, thumb: "pinch", at: [0.25 + 0.1 * (e / 900), 0.7] };
      const b: HandSpec = { ext: POINT, thumb: e >= 450 ? "pinch" : "tucked", at: [0.7 + 0.08 * (e / 900), 0.7], mirror: true };
      return [a, b];
    },
    // 👈 / 👉 (as seen on screen; the mirrored hand is a left hand)
    thumbLeft: e => (e > 600 ? null : [{ ext: FIST, thumb: THUMB_SIDE, mirror: true }]),
    thumbRight: e => (e > 600 ? null : [{ ext: FIST, thumb: THUMB_SIDE }]),
    // open hand: still for 200 ms, then flicked 0.2 frame widths in 80 ms — to the user's left
    // (+x in the camera image is left on the mirrored screen), to the right, or a slow swipe left
    flick: e => (e > 450 ? null : [{ ext: OPEN, thumb: "out", dx: 0.2 * ramp(e, 200, 80) }]),
    flickRight: e => (e > 450 ? null : [{ ext: OPEN, thumb: "out", dx: 0.3 - 0.2 * ramp(e, 200, 80) }]),
    swipeLeftSlow: e => (e > 900 ? null : [{ ext: OPEN, thumb: "out", dx: 0.3 * ramp(e, 200, 600) }]),
    // ✋ still (wheel opens at 700 ms) → tilt 60° to the user's left → hold → ✊ pick
    wheel: e => (e > 1700 ? null : [e < 1400
      ? { ext: OPEN, thumb: "out", rot: 60 * ramp(e, 900, 300) }
      : { ext: FIST, thumb: "tucked", rot: 60 }]),
    // both hands pinch at once → pull apart → let go
    line: e => {
      if (e > 1100) return null;
      const s = 0.15 * ramp(e, 300, 300), thumb: Thumb = e < 800 ? "pinch" : "out";
      return [{ ext: POINT, thumb, at: [0.4 - s, 0.75] }, { ext: POINT, thumb, at: [0.6 + s, 0.72], mirror: true }];
    },
    // both hands in an L (arms after 350 ms) → pull apart → close the hands
    rect: e => {
      if (e > 1500) return null;
      const s = 0.1 * ramp(e, 700, 300), held = e < 1200;
      const h = { ext: held ? POINT : FIST, thumb: (held ? "out" : "tucked") as Thumb };
      return [{ ...h, at: [0.35 - s, 0.85], mirror: true }, { ...h, at: [0.65 + s, 0.55] }];
    },
    // an O: a left and a right hand side by side, index tips together on top and thumb tips together
    // underneath, a gap between each hand's thumb and index → pull apart → close the hands
    circle: e => {
      if (e > 1500) return null;
      const s = 200 * ramp(e, 300, 400), held = e < 1200;
      const h = { ext: held ? POINT : FIST, thumb: (held ? [-30, -60, 0] : "tucked") as Thumb, at: [0.5, 0.8] as [number, number] };
      return [{ ...h, off: [-30 - s, 0], mirror: true }, { ...h, off: [30 + s, 0] }];
    },
  };

  let scene: ((e: number) => HandSpec[] | null) | null = null;
  let t0 = 0;
  window.__sceneDone = true;
  window.__detectCalls = 0;
  window.__play = name => { scene = scenes[name]; t0 = performance.now(); window.__sceneDone = false; };
  window.__hover = (nx, ny, ms) => {
    scene = e => (e > ms ? null : [{ ext: POINT, thumb: "tucked", tipAt: [nx, ny] }]);
    t0 = performance.now(); window.__sceneDone = false;
  };

  window.__airDrawMock = {
    FilesetResolver: { forVisionTasks: async () => ({}) },
    HandLandmarker: {
      HAND_CONNECTIONS: [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
        [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]].map(([start, end]) => ({ start, end })),
      createFromOptions: async () => ({
        close() {},
        detectForVideo(video: HTMLVideoElement) {
          window.__detectCalls++;
          const specs = scene?.(performance.now() - t0) ?? null;
          if (!specs) { scene = null; window.__sceneDone = true; }
          const landmarks = (specs ?? []).map(s => hand(s, video.videoWidth, video.videoHeight));
          return { landmarks, worldLandmarks: [], handedness: [], handednesses: [] };
        },
      }),
    },
  };
}

/**
 * Run a scene to its end. Hands that leave are remembered for a moment (HAND_MEMORY_MS) and a
 * new hand nearby would pick up their state, so by default this also waits until they're
 * forgotten: every scene starts from a clean slate. Pass { forget: false } to look at the
 * remembered state instead.
 */
export async function play(page: Page, scene: string, { forget = true } = {}) {
  await page.evaluate(s => window.__play(s), scene);
  await page.waitForFunction(() => window.__sceneDone);
  // let one more empty frame through
  const n = await page.evaluate(() => window.__detectCalls);
  await page.waitForFunction(k => window.__detectCalls > k + 1, n);
  if (forget) await forgotten(page);
}
export const forgotten = (page: Page) =>
  page.waitForFunction(() => window.__airDraw.hands[0] + window.__airDraw.hands[1] === 0);
// hold a pointing fingertip over the centre of an element for `ms` (scene runs in the page)
export async function hoverHand(page: Page, target: Locator, ms: number) {
  const box = (await target.boundingBox())!;
  await page.evaluate(([x, y, ms]) => {
    const [nx, ny] = window.__airDraw.screenToVideo(x, y);
    window.__hover(nx, ny, ms);
  }, [box.x + box.width / 2, box.y + box.height / 2, ms]);
}
export const langButton = (page: Page, name: RegExp) => page.getByRole("button", { name });

/** A flashcard for tests: the same text in every language, won by the given Quick Draw classes. */
export function testWord(id: string, ...labels: string[]): Word {
  return { id, en: id, labels, t: { es: id, ru: id, pl: id, id: id, te: id, yo: id, ja: id } };
}

export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}
