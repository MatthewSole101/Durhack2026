import { expect, test, type Locator, type Page } from "@playwright/test";
import { DRAW_ARM_MS, PALETTE } from "../features/air-draw/constants";

// There is no real hand in CI, so the gesture logic is driven by a mock landmarker that
// returns scripted synthetic hands. Scenes are timed inside the page (gestures are
// time-sensitive); the test just starts a scene and waits for it to finish.

type ShapeKind = "line" | "rect" | "tri";
declare global {
  interface Window {
    __airDraw: {
      strokes: { pts: [number, number][]; active: boolean; color: string; shape?: ShapeKind }[];
      toasts: string[];
      screenToVideo: (x: number, y: number) => [number, number];
      penColor: string;
      wheel: number | null;
      shape: ShapeKind | null;
    };
    __airDrawMock: unknown;
    __play: (scene: string) => void;
    __hover: (nx: number, ny: number, ms: number) => void;
    __sceneDone: boolean;
    __detectCalls: number;
  }
}

function installMock() {
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
  const doublePinch = (e: number): HandSpec[] | null =>
    e > 1150 ? null : [{ ext: OPEN, thumb: (e >= 250 && e < 450) || (e >= 700 && e < 900) ? "pinch" : "out" }];

  // scene(elapsed ms) → hands, or null when the scene is over (no hands in frame between scenes)
  const scenes: Record<string, (e: number) => HandSpec[] | null> = {
    pointTucked: e => (e > 700 ? null : [{ ext: POINT, thumb: "tucked", dx: 0.1 * (e / 700) }]),
    pointThumbOut: e => (e > 700 ? null : [{ ext: POINT, thumb: "out", dx: 0.1 * (e / 700) }]),
    doublePinch,
    // open hand: still for 200 ms, then 0.35 frame-widths in 150 ms
    flick: e => (e > 600 ? null : [{ ext: OPEN, thumb: "out", dx: 0.35 * ramp(e, 200, 150) }]),
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
    // both hands in an L (held 700 ms; arms at 500) → pull apart → close the hands
    rect: e => {
      if (e > 1500) return null;
      const s = 0.1 * ramp(e, 700, 300), held = e < 1200;
      const h = { ext: held ? POINT : FIST, thumb: (held ? "out" : "tucked") as Thumb };
      return [{ ...h, at: [0.35 - s, 0.85], mirror: true }, { ...h, at: [0.65 + s, 0.55] }];
    },
    // index tips + thumb tips touching (a left and a right hand, side by side) → pull apart → close
    tri: e => {
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

async function play(page: Page, scene: string) {
  await page.evaluate(s => window.__play(s), scene);
  await page.waitForFunction(() => window.__sceneDone);
  // let one more empty frame through so strokes are closed
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

test("gestures: draw, thumb-out guard, double-pinch undo, flick clear, restore", async ({ page }) => {
  const errors = trackErrors(page);
  await startDrawing(page);

  await play(page, "pointTucked"); // 1. point with thumb tucked while moving
  expect(await strokeCount(page)).toBe(1);
  expect(await page.evaluate(() => window.__airDraw.strokes[0].pts.length)).toBeGreaterThan(3);

  await play(page, "pointThumbOut"); // 2. thumb out: no new stroke
  expect(await strokeCount(page)).toBe(1);

  await play(page, "pointTucked"); // 3. thumb tucked again
  expect(await strokeCount(page)).toBe(2);

  await play(page, "doublePinch"); // 4. undo
  expect(await strokeCount(page)).toBe(1);
  expect(await lastToast(page)).toBe("↩ Undo");
  await expect(page.getByTestId("toast")).toHaveText("↩ Undo");

  await play(page, "flick"); // 5. clear
  expect(await strokeCount(page)).toBe(0);
  expect(await lastToast(page)).toBe("✨ Cleared");

  await play(page, "doublePinch"); // 6. undo the clear
  expect(await strokeCount(page)).toBe(1);
  expect(await lastToast(page)).toBe("↩ Restored");

  await page.keyboard.press("c"); // keyboard fallbacks
  expect(await strokeCount(page)).toBe(0);
  await page.keyboard.press("z");
  expect(await strokeCount(page)).toBe(1);

  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual(
    ["↩ Undo", "✨ Cleared", "↩ Restored", "✨ Cleared", "↩ Restored"]);
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

  await play(page, "pointTucked"); // new ink uses the picked colour
  expect(await lastStroke(page)).toMatchObject({ color: coral.color });

  await play(page, "line");
  let s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "line", color: coral.color });
  expect(s.pts).toHaveLength(2);
  expect(Math.abs(s.pts[1][0] - s.pts[0][0])).toBeGreaterThan(200); // stretched out

  await play(page, "rect");
  s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "rect" });
  expect(s.pts).toHaveLength(4);

  await play(page, "tri");
  s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "tri" });
  expect(s.pts).toHaveLength(3);
  expect(s.pts[2][1]).toBeLessThan(s.pts[0][1]); // apex above the base
  expect(Math.abs(s.pts[1][0] - s.pts[0][0])).toBeGreaterThan(200); // grew as the hands parted

  expect(await strokeCount(page)).toBe(4);
  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual([`🎨 ${coral.name}`]); // shape releases aren't undo taps
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
  await expect(page.getByTestId("gesture-hints")).toContainText("pinch twice quickly");
  await page.waitForFunction(() => window.__sceneDone);
  // the finger that picked was still pointing, but the pen stays up for a moment
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

// Needs network: downloads the real WASM runtime and model from the CDN.
test("real MediaPipe model loads and runs on camera frames", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");

  const spanish = langButton(page, /Español/);
  await expect(page.getByText("Loading hand tracking…")).toBeVisible();
  await expect(spanish).toBeDisabled();
  await expect(spanish).toBeEnabled({ timeout: 45_000 });
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
