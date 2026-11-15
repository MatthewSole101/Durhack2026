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
      mic: "on" | "starting" | "click" | "off";
      setMic: (s: "on" | "starting" | "click" | "off") => void;
      snapSound: () => void;
    };
    __gameDeck: Word[];
    __quickDraw: QuickDrawTestHook;
    __airDrawMock: unknown;
    __play: (scene: string) => void;
    __hover: (nx: number, ny: number, ms: number, pinch?: boolean) => void;
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
    fold?: boolean; // curled fingers are folded right into the palm, fingertip by the knuckle: a closed fist
    rot?: number; // degrees, about the wrist (+ = clockwise in the video image)
  };

  const MCP: P[] = [[-30, -95, 0], [0, -100, 0], [28, -92, 0], [52, -80, 0]]; // index, middle, ring, pinky
  const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const ramp = (e: number, from: number, ms: number) => Math.min(Math.max((e - from) / ms, 0), 1);

  // Hand in "palm = 100 units" space, wrist at the origin, fingers pointing up (−y).
  function hand({ ext, thumb, dx = 0, tipAt, at, off = [0, 0], mirror, rot = 0, fold }: HandSpec, vw: number, vh: number) {
    const pts: P[] = [[0, 0, 0], [-35, -25, 0], [-60, -50, 0], [-80, -70, 0], [0, 0, 0]];
    MCP.forEach((m, i) => {
      pts.push(m);
      if (ext[i]) pts.push(add(m, [0, -40, 0]), add(m, [0, -65, 0]), add(m, [0, -90, 0])); // straight line above the MCP
      else if (fold) pts.push(add(m, [0, -30, -10]), add(m, [0, -22, -36]), add(m, [0, 2, -22])); // tip tucked in by the MCP
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
  // 🫰 ready to snap: thumb tip pressed on the middle fingertip, middle finger out
  const SNAP_READY: HandSpec = { ext: [false, true, false, false], thumb: [0, -190, 0] };
  // 👏 two hands facing each other, `gap` units between their wrists (palm = 100; palm centres
  // are 20 further apart than the wrists)
  const pair = (h: Pick<HandSpec, "ext" | "thumb">, gap: number): HandSpec[] =>
    [{ ...h, at: [0.5, 0.7], off: [-gap / 2, 0], mirror: true }, { ...h, at: [0.5, 0.7], off: [gap / 2, 0] }];
  const FLAT = { ext: OPEN, thumb: "out" as Thumb };
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
      if (e > 1100) return null; // B starts pinching 650 ms after A: well outside the 350 ms "together → line" window
      const a: HandSpec = { ext: POINT, thumb: "pinch", at: [0.25 + 0.1 * (e / 1100), 0.7] };
      const b: HandSpec = { ext: POINT, thumb: e >= 650 ? "pinch" : "tucked", at: [0.7 + 0.08 * (e / 1100), 0.7], mirror: true };
      return [a, b];
    },
    // 👈 / 👉 (as seen on screen; the mirrored hand is a left hand)
    thumbLeft: e => (e > 600 ? null : [{ ext: FIST, thumb: THUMB_SIDE, mirror: true }]),
    thumbRight: e => (e > 600 ? null : [{ ext: FIST, thumb: THUMB_SIDE }]),
    // draw a stroke, then close the hand with the thumb sticking out sideways (not meant as 👉)
    drawThenThumb: e => (e > 1200 ? null : [e < 500 ? { ext: POINT, thumb: "pinch", dx: 0.1 * (e / 500) } : { ext: FIST, thumb: THUMB_SIDE, dx: 0.1 }]),
    // 🫰 thumb pressed on the middle fingertip for 400 ms, then snapped: the middle finger drops
    // into the palm and the thumb slides off towards the index
    snap: e => (e > 700 ? null : [e < 400 ? SNAP_READY : { ext: FIST, thumb: [-60, -130, 0] }]),
    // set up for a snap, then gone (motion blur) for the snap itself, back a moment later
    snapBlurred: e => (e > 800 ? null : e < 400 ? [SNAP_READY] : e < 520 ? [] : [{ ext: FIST, thumb: [-60, -130, 0] }]),
    // a fist (tucked thumb resting on the curled middle finger) opening: not a snap
    fistOpen: e => (e > 700 ? null : [e < 400 ? { ext: FIST, thumb: "tucked" } : { ext: OPEN, thumb: "out" }]),
    // 👏 two open hands apart, brought together in 150 ms, held for a moment, apart again
    clap: e => (e > 900 ? null : pair(FLAT, 300 * (1 - ramp(e, 450, 150) + ramp(e, 700, 150)))),
    // the same, but both hands are lost (blurred / merged) for the last third of the way in and the clap itself
    clapBlurred: e => (e > 900 ? null : e >= 550 && e < 700 ? [] : pair(FLAT, e < 550 ? 300 * (1 - ramp(e, 450, 150)) : 300)),
    // two open hands drifting together over 2.5 s and resting there: not a clap
    handsMeet: e => (e > 3000 ? null : pair(FLAT, 300 * (1 - ramp(e, 200, 2500)))),
    // two fists knocked together as fast as a clap: not a clap
    fistBump: e => (e > 900 ? null : pair({ ext: FIST, thumb: "tucked" }, 300 * (1 - ramp(e, 450, 150) + ramp(e, 700, 150)))),
    // 🤏 → ✊ a stroke, then the hand closes into a fist (thumb resting on the folded index finger)
    // and keeps moving: closing the hand is how many people stop drawing
    pinchThenFist: e => (e > 1100 ? null : [e < 500
      ? { ext: POINT, thumb: "pinch", dx: 0.1 * (e / 500) }
      : { ext: FIST, fold: true, thumb: [-38, -118, -18], dx: 0.1 + 0.2 * ((e - 500) / 600) }]),
    // ✊ a closed fist at rest, thumb lying across the middle finger (it looks a little like a hand set up to snap)
    fistRest: e => (e > 1500 ? null : [{ ext: FIST, fold: true, thumb: [-10, -105, -25] }]),
    // ✋ an open hand, and a second "hand" that shows up for 100 ms at a time, sliding 0.7 palm
    // towards it before it is gone again: a face or a sleeve mistaken for a hand, never there for long
    phantom: e => {
      if (e > 1600) return null;
      const real: HandSpec = { ...FLAT, at: [0.35, 0.7] };
      const seen = e % 200; // 100 ms seen, 100 ms gone
      return seen < 100 ? [real, { ...FLAT, at: [0.35, 0.7], off: [240 - 70 * (seen / 100), -20], mirror: true }] : [real];
    },
    // 🤏 pinched for 400 ms, then the fingers open ~1.5 cm (gap ≈ 0.5 palm) while the hand keeps moving
    pinchThenOpen: e => (e > 900 ? null : [{ ext: POINT, thumb: e < 400 ? "pinch" : [-80, -170, 0], dx: 0.2 * (e / 900) }]),
    // 🤏 pinched with the pad of the index finger: thumb beside its last segment, not on the tip
    pinchPad: e => (e > 700 ? null : [{ ext: POINT, thumb: [-52, -172, 0], dx: 0.1 * (e / 700) }]),
    // ✋ moving the hand around without meaning to draw:
    // the thumb brushes the index fingertip for 100 ms on the way…
    pinchBrush: e => (e > 700 ? null : [{ ext: POINT, thumb: e >= 300 && e < 400 ? "pinch" : "out", dx: 0.15 * (e / 700) }]),
    // …a fast sweep with the fingertips together (motion blur)…
    pinchFast: e => (e > 300 ? null : [{ ext: POINT, thumb: "pinch", dx: 0.45 * (e / 300) }]),
    // …a relaxed hand, thumb resting against the side of the index finger
    thumbSide: e => (e > 700 ? null : [{ ext: POINT, thumb: [-45, -135, 0], dx: 0.1 * (e / 700) }]),
    // ✋ still (wheel opens at 0.65 s) → tilt 60° to the user's left → hold → ✊ pick
    wheel: e => (e > 2000 ? null : [e < 1700
      ? { ext: OPEN, thumb: "out", rot: 60 * ramp(e, 1200, 300) }
      : { ext: FIST, thumb: "tucked", rot: 60 }]),
    // one hand pinches and waits, the other pinches 0.7 s later, both still → pull apart → let go
    lineStaggered: e => {
      if (e > 1700) return null;
      const s = 0.15 * ramp(e, 1000, 300), thumbA: Thumb = e < 1400 ? "pinch" : "out", thumbB: Thumb = e >= 700 && e < 1400 ? "pinch" : "tucked";
      return [{ ext: POINT, thumb: thumbA, at: [0.4 - s, 0.75] }, { ext: POINT, thumb: thumbB, at: [0.6 + s, 0.72], mirror: true }];
    },
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
  window.__hover = (nx, ny, ms, pinch = false) => {
    scene = e => (e > ms ? null : [{ ext: POINT, thumb: pinch ? "pinch" : "tucked", tipAt: [nx, ny] }]);
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
export async function play(page: Page, scene: string, { forget = true, soundAt }: { forget?: boolean; soundAt?: number } = {}) {
  await page.evaluate(([s, ms]) => {
    window.__play(s as string);
    if (ms !== undefined) setTimeout(() => window.__airDraw.snapSound(), ms as number); // 🫰 heard at this point in the scene
  }, [scene, soundAt] as const);
  await page.waitForFunction(() => window.__sceneDone);
  // let one more empty frame through
  const n = await page.evaluate(() => window.__detectCalls);
  await page.waitForFunction(k => window.__detectCalls > k + 1, n);
  if (forget) await forgotten(page);
}
export const forgotten = (page: Page) =>
  page.waitForFunction(() => window.__airDraw.hands[0] + window.__airDraw.hands[1] === 0);
// hold a pointing fingertip over the centre of an element for `ms` (scene runs in the page)
export async function hoverHand(page: Page, target: Locator, ms: number, { pinch = false } = {}) {
  const box = (await target.boundingBox())!;
  await page.evaluate(([x, y, ms, pinch]) => {
    const [nx, ny] = window.__airDraw.screenToVideo(x as number, y as number);
    window.__hover(nx, ny, ms as number, pinch as boolean);
  }, [box.x + box.width / 2, box.y + box.height / 2, ms, pinch] as const);
}
export const langButton = (page: Page, name: RegExp) => page.getByRole("button", { name });

/** A flashcard for tests: the same text in every language (and in English), won by the given Quick Draw classes. */
export function testWord(id: string, ...labels: string[]): Word {
  return { id, en: id, labels, t: { es: id, uk: id, pl: id, id: id, te: id, yo: id, ja: id } };
}

export function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}
