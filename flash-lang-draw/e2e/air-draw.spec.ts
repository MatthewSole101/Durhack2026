import { expect, test, type Locator, type Page } from "@playwright/test";
import { DRAW_ARM_MS, FLICK_COOLDOWN_MS, PALETTE } from "../features/air-draw/constants";

// There is no real hand in CI, so the gesture logic is driven by a mock landmarker that
// returns scripted synthetic hands. Scenes are timed inside the page (gestures are
// time-sensitive); the test just starts a scene and waits for it to finish.

type ShapeKind = "line" | "rect" | "circle";
type Pt = [number, number];
declare global {
  interface Window {
    __airDraw: {
      strokes: { pts: Pt[]; active: boolean; color: string; shape?: ShapeKind }[];
      toasts: string[];
      screenToVideo: (x: number, y: number) => Pt;
      penColor: string;
      wheel: number | null;
      shape: ShapeKind | null;
      hands: number;
      remembered: number;
    };
    __airDrawMock: unknown;
    __play: (scene: string) => void;
    __hover: (nx: number, ny: number, ms: number) => void;
    __sceneDone: boolean;
    __detectCalls: number;
    __maxRemembered: number; // most hands the engine was remembering at once during the scene
    __lastHands: { x: number; y: number }[][]; // landmarks of the last frame that had hands (normalised)
  }
}

function installMock() {
  type P = [number, number, number];
  type Thumb = "out" | "tucked" | "pinch" | P; // or an explicit thumb-tip position (units)
  type HandSpec = {
    ext: [boolean, boolean, boolean, boolean]; // index, middle, ring, pinky extended?
    thumb: Thumb;
    dx?: number; // shift of the default wrist position, fraction of frame width
    dy?: number; // …and of frame height
    tipAt?: [number, number]; // put the (pointing) index fingertip here, normalised video coords
    at?: [number, number]; // wrist position, normalised video coords…
    off?: [number, number]; // …plus this many units
    mirror?: boolean; // a left hand (thumb on the other side)
    rot?: number; // degrees, about the wrist (+ = clockwise in the video image)
  };

  const MCP: P[] = [[-30, -95, 0], [0, -100, 0], [28, -92, 0], [52, -80, 0]]; // index, middle, ring, pinky
  const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const ramp = (e: number, from: number, ms: number) => Math.min(Math.max((e - from) / ms, 0), 1);
  const video = () => document.querySelector("video")!;

  // Hand in "palm = 100 units" space, wrist at the origin, fingers pointing up (−y).
  function hand({ ext, thumb, dx = 0, dy = 0, tipAt, at, off = [0, 0], mirror, rot = 0 }: HandSpec, vw: number, vh: number) {
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
    const oy = (at ? at[1] * vh : tipAt ? tipAt[1] * vh + 185 * k : vh * (0.7 + dy)) + off[1] * k;
    return pts.map(([x0, y, z]) => {
      const x = x0 * m;
      return { x: (ox + (x * c - y * s) * k) / vw, y: (oy + (x * s + y * c) * k) / vh, z: (z * k) / vw, visibility: 0 };
    });
  }

  const POINT: HandSpec["ext"] = [true, false, false, false];
  const OPEN: HandSpec["ext"] = [true, true, true, true];
  const FIST: HandSpec["ext"] = [false, false, false, false];
  const open = (dx = 0, dy = 0): HandSpec => ({ ext: OPEN, thumb: "out", dx, dy });
  const fist = (at?: [number, number], mirror = false): HandSpec => ({ ext: FIST, thumb: "tucked", at, mirror });
  const pinch = (dx: number): HandSpec => ({ ext: OPEN, thumb: "pinch", dx }); // 👌 thumb on the index tip
  const L = (at: [number, number], mirror = false): HandSpec => ({ ext: POINT, thumb: "out", at, mirror });

  // scene(elapsed ms) → hands, or null when the scene is over (no hands in frame between scenes).
  // [] = no hands this frame, but the scene goes on.
  const scenes: Record<string, (e: number) => HandSpec[] | null> = {
    // 🤏 pinch and move
    pinchDraw: e => (e > 700 ? null : [pinch(0.1 * (e / 700))]),
    // ☝️ pointing no longer draws
    point: e => (e > 700 ? null : [{ ext: POINT, thumb: "tucked", dx: 0.1 * (e / 700) }]),
    // ✊ open ✊ open: two quick clenches
    doubleClench: e => (e > 1000 ? null : [(e >= 200 && e < 400) || (e >= 600 && e < 800) ? fist() : open()]),
    // two clenches too far apart: not an undo
    slowClenches: e => (e > 1600 ? null : [(e >= 200 && e < 400) || (e >= 1200 && e < 1400) ? fist() : open(0.02 * Math.sin(e / 100))]),
    // open hand: still for 200 ms, then 0.35 frame-widths in 150 ms
    flick: e => (e > 600 ? null : [open(0.35 * ramp(e, 200, 150))]),
    // a fast sideways swipe that loses the hand after only 0.12 frame-widths (short of a full flick)
    flickOut: e => (e > 300 ? null : [open(e < 200 ? 0 : 1.2 * (e - 200) / 1000)]),
    // the same speed, but downwards (dropping a hand out of view): not a flick
    dropOut: e => (e > 300 ? null : [open(0, e < 200 ? 0 : 1.2 * (e - 200) / 1000)]),
    // pinch-drawing; the hand is lost for 200 ms mid-stroke, then comes back still pinching
    pinchGap: e => (e > 900 ? null : e >= 300 && e < 500 ? [] : [pinch(0.15 * (e / 900))]),
    // …lost for 1 s: that's a new stroke
    pinchLongGap: e => (e > 1700 ? null : e >= 300 && e < 1300 ? [] : [pinch(0.15 * (e / 1700))]),
    // ✋ still (wheel opens at 700 ms) → tilt 60° to the user's left → hold → ✊ pick
    wheel: e => (e > 1700 ? null : [e < 1400
      ? { ext: OPEN, thumb: "out", rot: 60 * ramp(e, 900, 300) }
      : { ext: FIST, thumb: "tucked", rot: 60 }]),
    // both hands pinch → pull apart → let go
    line: e => {
      if (e > 1100) return null;
      const s = 0.15 * ramp(e, 300, 300), thumb: Thumb = e < 800 ? "pinch" : "out";
      return [{ ext: POINT, thumb, at: [0.4 - s, 0.75] }, { ext: POINT, thumb, at: [0.6 + s, 0.72], mirror: true }];
    },
    // the same, but one hand drops out of tracking for 250 ms while stretching
    lineGap: e => {
      if (e > 1300) return null;
      const s = 0.15 * ramp(e, 300, 600), thumb: Thumb = e < 1000 ? "pinch" : "out";
      const a: HandSpec = { ext: POINT, thumb, at: [0.4 - s, 0.75] };
      const b: HandSpec = { ext: POINT, thumb, at: [0.6 + s, 0.72], mirror: true };
      return e >= 500 && e < 750 ? [a] : [a, b];
    },
    // an L with each hand on a diagonal (held 500 ms; arms at 300) → pull apart → close the hands
    // (closing doesn't move landmarks 2 and 5, so the L corners stay put)
    rect: e => {
      if (e > 1300) return null;
      const s = 0.1 * ramp(e, 500, 300);
      return e < 1000 ? [L([0.35 - s, 0.85], true), L([0.65 + s, 0.55])] : [fist([0.25, 0.85], true), fist([0.75, 0.55])];
    },
    // two Ls whose corners are nearly (5% off) a square apart
    square: e => {
      if (e > 1000) return null;
      const { videoWidth: vw, videoHeight: vh } = video(), k = vh / 720;
      // each L corner sits 45 units in from its wrist, towards the other hand
      const ay = 0.85, by = 0.45, bx = 0.35 + (1.05 * (ay - by) * vh + 90 * k) / vw;
      return e < 700 ? [L([0.35, ay], true), L([bx, by])] : [fist([0.35, ay], true), fist([bx, by])];
    },
    // ◯ index tips + thumb tips touching (a left and a right hand, side by side) → pull apart → close
    circle: e => {
      if (e > 1500) return null;
      const s = 200 * ramp(e, 300, 400), held = e < 1200;
      const h = { ext: held ? POINT : FIST, thumb: (held ? [-30, -30, 0] : "tucked") as Thumb, at: [0.5, 0.8] as [number, number] };
      return [{ ...h, off: [-30 - s, 0], mirror: true }, { ...h, off: [30 + s, 0] }];
    },
  };

  let scene: ((e: number) => HandSpec[] | null) | null = null;
  let t0 = 0;
  window.__sceneDone = true;
  window.__detectCalls = 0;
  window.__maxRemembered = 0;
  window.__lastHands = [];
  window.__play = name => {
    scene = scenes[name]; t0 = performance.now(); window.__sceneDone = false; window.__maxRemembered = 0;
  };
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
          window.__maxRemembered = Math.max(window.__maxRemembered, window.__airDraw?.remembered ?? 0);
          const specs = scene?.(performance.now() - t0) ?? null;
          if (!specs) { scene = null; window.__sceneDone = true; }
          const landmarks = (specs ?? []).map(s => hand(s, video.videoWidth, video.videoHeight));
          if (landmarks.length) window.__lastHands = landmarks;
          return { landmarks, worldLandmarks: [], handedness: [], handednesses: [] };
        },
      }),
    },
  };
}

async function play(page: Page, scene: string) {
  await page.evaluate(s => window.__play(s), scene);
  await page.waitForFunction(() => window.__sceneDone);
  // the engine remembers a hand that has gone for a moment: wait until it's let go, so strokes
  // are closed, shapes placed, and the next scene's hand isn't taken for the same one
  await page.waitForFunction(() => window.__airDraw.remembered === 0);
  const n = await page.evaluate(() => window.__detectCalls);
  await page.waitForFunction(k => window.__detectCalls > k + 1, n);
}
// hold a pointing fingertip over the centre of an element for `ms` (scene runs in the page)
async function hoverHand(page: Page, target: Locator, ms: number) {
  const box = (await target.boundingBox())!;
  await page.evaluate(([x, y, ms]) => {
    const [nx, ny] = window.__airDraw.screenToVideo(x, y);
    window.__hover(nx, ny, ms);
  }, [box.x + box.width / 2, box.y + box.height / 2, ms]);
}
const strokeCount = (page: Page) => page.evaluate(() => window.__airDraw.strokes.length);
const lastStroke = (page: Page) => page.evaluate(() => window.__airDraw.strokes.at(-1)!);
const lastToast = (page: Page) => page.evaluate(() => window.__airDraw.toasts.at(-1));
const langButton = (page: Page, name: RegExp) => page.getByRole("button", { name });
const near = (a: Pt, b: Pt, tol = 2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}

/** Open the page with the mock, pick a language with the mouse, wait until the pen is live. */
async function startDrawing(page: Page, lang = /Español/) {
  await page.addInitScript(installMock);
  await page.goto("/");
  const btn = langButton(page, lang);
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(page.getByTestId("start-screen")).toBeHidden();
  await page.waitForFunction(() => window.__detectCalls > 3);
  await page.waitForTimeout(DRAW_ARM_MS); // the pen is held up briefly after starting
}

test("gestures: pinch to draw, double-clench undo, flick clear, restore", async ({ page }) => {
  const errors = trackErrors(page);
  await startDrawing(page);

  await play(page, "pinchDraw"); // 1. pinch and move
  expect(await strokeCount(page)).toBe(1);
  expect((await lastStroke(page)).pts.length).toBeGreaterThan(3);

  await play(page, "point"); // 2. pointing alone doesn't draw any more
  expect(await strokeCount(page)).toBe(1);

  await play(page, "pinchDraw"); // 3.
  expect(await strokeCount(page)).toBe(2);

  await play(page, "doubleClench"); // 4. ✊✊ undo
  expect(await strokeCount(page)).toBe(1);
  expect(await lastToast(page)).toBe("↩ Undo");
  await expect(page.getByTestId("toast")).toHaveText("↩ Undo");

  await play(page, "slowClenches"); // 5. two clenches far apart: nothing
  expect(await strokeCount(page)).toBe(1);

  await play(page, "flick"); // 6. 👋 clear
  expect(await strokeCount(page)).toBe(0);
  expect(await lastToast(page)).toBe("✨ Cleared");

  await play(page, "doubleClench"); // 7. undo the clear
  expect(await strokeCount(page)).toBe(1);
  expect(await lastToast(page)).toBe("↩ Restored");
  await page.waitForTimeout(FLICK_COOLDOWN_MS);

  await play(page, "dropOut"); // 8. a hand dropping out of view fast isn't a flick
  expect(await strokeCount(page)).toBe(1);

  await play(page, "flickOut"); // 9. a swipe that leaves the frame early still clears
  expect(await strokeCount(page)).toBe(0);
  expect(await lastToast(page)).toBe("✨ Cleared");

  await page.keyboard.press("z"); // keyboard fallbacks
  expect(await strokeCount(page)).toBe(1);
  await page.keyboard.press("c");
  expect(await strokeCount(page)).toBe(0);

  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual(
    ["↩ Undo", "✨ Cleared", "↩ Restored", "✨ Cleared", "↩ Restored", "✨ Cleared"]);
  expect(errors).toEqual([]);
});

test("a hand lost for a moment is remembered", async ({ page }) => {
  const errors = trackErrors(page);
  await startDrawing(page);

  await play(page, "pinchGap"); // lost for 200 ms mid-stroke: the same stroke carries on
  expect(await page.evaluate(() => window.__maxRemembered)).toBe(1);
  expect(await strokeCount(page)).toBe(1);
  const s = await lastStroke(page);
  expect(s.pts.at(-1)![0] - s.pts[0][0]).toBeGreaterThan(80); // spans both sides of the gap

  await play(page, "pinchLongGap"); // lost for 1 s: forgotten, so a second stroke
  expect(await strokeCount(page)).toBe(3);

  await play(page, "lineGap"); // one hand drops out while stretching a line: still one line
  expect(await strokeCount(page)).toBe(4);
  const line = await lastStroke(page);
  expect(line).toMatchObject({ shape: "line" });
  expect(Math.abs(line.pts[1][0] - line.pts[0][0])).toBeGreaterThan(200);

  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual([]);
  expect(errors).toEqual([]);
});

test("colour wheel and two-hand shapes", async ({ page }) => {
  const errors = trackErrors(page);
  await startDrawing(page);
  const coral = PALETTE[0];
  expect(await page.evaluate(() => window.__airDraw.penColor)).not.toBe(coral.color);

  // ✋ hold still → wheel; tilt left → first colour; ✊ → picked
  await play(page, "wheel");
  expect(await page.evaluate(() => window.__airDraw.penColor)).toBe(coral.color);
  expect(await lastToast(page)).toBe(`🎨 ${coral.name}`);
  expect(await page.evaluate(() => window.__airDraw.wheel)).toBeNull();
  expect(await strokeCount(page)).toBe(0); // no ink while choosing

  await play(page, "pinchDraw"); // new ink uses the picked colour
  expect(await lastStroke(page)).toMatchObject({ color: coral.color });

  await play(page, "line");
  let s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "line", color: coral.color });
  expect(s.pts).toHaveLength(2);
  expect(Math.abs(s.pts[1][0] - s.pts[0][0])).toBeGreaterThan(200); // stretched out
  expect(await strokeCount(page)).toBe(2); // the pinches that started it left no dots

  // ▭ the corners are where thumb meets index (between landmarks 2 and 5) on each hand
  const crotches = async () => page.evaluate(() => {
    const v = document.querySelector("video")!;
    return window.__lastHands.map(h => [(h[2].x + h[5].x) / 2 * v.videoWidth, (h[2].y + h[5].y) / 2 * v.videoHeight] as Pt);
  });
  await play(page, "rect");
  const [c1, c2] = await crotches();
  s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "rect" });
  expect(s.pts).toHaveLength(4);
  expect(near(s.pts[0], c1) || near(s.pts[0], c2)).toBe(true);
  expect(near(s.pts[2], c1) || near(s.pts[2], c2)).toBe(true);
  const side = (p: Pt[]) => [Math.abs(p[1][0] - p[0][0]), Math.abs(p[2][1] - p[1][1])];
  const [w, h] = side(s.pts);
  expect(Math.abs(w - h)).toBeGreaterThan(20); // a real rectangle, not snapped

  await play(page, "square"); // nearly square → snapped to a square
  s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "rect" });
  const [sw, sh] = side(s.pts);
  expect(Math.abs(sw - sh)).toBeLessThan(1);

  await play(page, "circle");
  s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "circle" });
  const [[cx, cy], rim] = s.pts;
  const r = Math.hypot(rim[0] - cx, rim[1] - cy);
  const vw = await page.evaluate(() => document.querySelector("video")!.videoWidth);
  expect(r).toBeGreaterThan(100); // grew as the hands parted
  expect(Math.abs(cx - vw / 2)).toBeLessThan(5); // centred between the hands

  expect(await strokeCount(page)).toBe(5);
  // closing the hands to place shapes never counted as undo clenches
  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual([`🎨 ${coral.name}`]);
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("start screen: hand-pick a language, go back, pick another", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(installMock);
  await page.goto("/");

  const french = langButton(page, /Français/);
  await expect(french).toBeEnabled();
  await page.waitForFunction(() => window.__detectCalls > 3); // menu-mode tracking is running
  await expect(page.getByRole("button", { name: /Start/ })).toHaveCount(0); // no separate Start button

  // hover French: a French flag is painted in next to the finger, then the drawing page opens
  const cursor = page.getByTestId("hand-cursor");
  await hoverHand(page, french, 1700);
  await expect(cursor).toHaveAttribute("data-state", "dwell");
  await expect(cursor).toHaveAttribute("data-flag", "fr");
  await expect(page.getByTestId("hand-cursor-flag")).toBeVisible();
  await expect(french).toHaveAttribute("data-hand-hover", "");
  await expect(page.getByTestId("start-screen")).toBeHidden();
  const card = page.getByTestId("word-card");
  await expect(card).toHaveAttribute("data-lang", "fr");
  await expect(card).toContainText("Français");
  // the gesture cheat-sheet is open when the drawing page opens
  await expect(page.getByTestId("gesture-hints")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("gesture-hints")).toContainText("clench a fist twice");
  await page.waitForFunction(() => window.__sceneDone);
  expect(await strokeCount(page)).toBe(0);

  // back button, pressed by hand (the cursor only shows up over it)
  const back = page.getByRole("button", { name: "Back to languages" });
  await hoverHand(page, back, 1700);
  await expect(cursor).toHaveAttribute("data-state", "dwell");
  await expect(cursor).not.toHaveAttribute("data-flag");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await page.waitForFunction(() => window.__sceneDone);

  // mouse works too; Esc goes back
  await langButton(page, /Deutsch/).click();
  await expect(card).toHaveAttribute("data-lang", "de");
  expect(await strokeCount(page)).toBe(0); // fresh canvas for the new card
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  expect(errors).toEqual([]);
});

// Uses the self-hosted runtime + model (scripts/setup-mediapipe.mjs), or the CDNs if they're missing.
test("real MediaPipe model loads and runs on camera frames", async ({ page }) => {
  const errors = trackErrors(page);
  const info: string[] = [];
  page.on("console", m => { if (m.text().startsWith("[air-draw]")) info.push(m.text()); });
  await page.goto("/");

  const spanish = langButton(page, /Español/);
  await expect(page.getByText("Loading hand tracking…")).toBeVisible();
  await expect(spanish).toBeDisabled();
  await expect(spanish).toBeEnabled({ timeout: 45_000 });
  console.log(info.join("\n")); // load-time breakdown
  await spanish.click();
  await expect(page.getByTestId("start-screen")).toBeHidden();

  await page.waitForTimeout(1500); // a few dozen frames through detectForVideo
  await expect(page.getByTestId("error-banner")).toHaveCount(0); // no "Hand tracking error" banner
  // the mirrored camera frame is on the canvas (fake camera is not black)
  const lit = await page.evaluate(() => {
    const c = document.querySelector("canvas")!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 997) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
    return n;
  });
  expect(lit).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});
