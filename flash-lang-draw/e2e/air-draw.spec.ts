import { expect, test, type Page } from "@playwright/test";

// There is no real hand in CI, so the gesture logic is driven by a mock landmarker that
// returns scripted synthetic hands. Scenes are timed inside the page (gestures are
// time-sensitive); the test just starts a scene and waits for it to finish.

declare global {
  interface Window {
    __airDraw: { strokes: { pts: [number, number][]; active: boolean }[]; toasts: string[] };
    __airDrawMock: unknown;
    __play: (scene: string) => void;
    __sceneDone: boolean;
    __detectCalls: number;
  }
}

function installMock() {
  type Thumb = "out" | "tucked" | "pinch";
  type P = [number, number, number];
  type HandSpec = { ext: [boolean, boolean, boolean, boolean]; thumb: Thumb; dx?: number };

  const MCP: P[] = [[-30, -95, 0], [0, -100, 0], [28, -92, 0], [52, -80, 0]]; // index, middle, ring, pinky
  const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

  // Hand in "palm = 100 units" space, wrist at the origin, fingers pointing up (−y).
  function hand({ ext, thumb, dx = 0 }: HandSpec, vw: number, vh: number) {
    const pts: P[] = [[0, 0, 0], [-35, -25, 0], [-60, -50, 0], [-80, -70, 0], [0, 0, 0]];
    MCP.forEach((m, i) => {
      pts.push(m);
      if (ext[i]) pts.push(add(m, [0, -40, 0]), add(m, [0, -65, 0]), add(m, [0, -90, 0])); // straight line above the MCP
      else pts.push(add(m, [0, -30, -10]), add(m, [0, -25, -35]), add(m, [0, 10, -30])); // tip folded back below the MCP
    });
    pts[4] = thumb === "out" ? [-130, -90, 0] : thumb === "tucked" ? [-8, -92, -30] : pts[8]; // pinch = on the index tip
    const k = vh / 720; // 100 units ≈ 100 px on a 720p frame
    const ox = vw * (0.3 + dx), oy = vh * 0.7;
    return pts.map(([x, y, z]) => ({ x: (ox + x * k) / vw, y: (oy + y * k) / vh, z: (z * k) / vw, visibility: 0 }));
  }

  const POINT: HandSpec["ext"] = [true, false, false, false];
  const OPEN: HandSpec["ext"] = [true, true, true, true];
  const doublePinch = (e: number): HandSpec[] | null =>
    e > 1150 ? null : [{ ext: OPEN, thumb: (e >= 250 && e < 450) || (e >= 700 && e < 900) ? "pinch" : "out" }];

  // scene(elapsed ms) → hands, or null when the scene is over (no hands in frame between scenes)
  const scenes: Record<string, (e: number) => HandSpec[] | null> = {
    pointTucked: e => (e > 700 ? null : [{ ext: POINT, thumb: "tucked", dx: 0.1 * (e / 700) }]),
    pointThumbOut: e => (e > 700 ? null : [{ ext: POINT, thumb: "out", dx: 0.1 * (e / 700) }]),
    doublePinch,
    // open hand: still for 200 ms, then 0.35 frame-widths in 150 ms
    flick: e => (e > 600 ? null : [{ ext: OPEN, thumb: "out", dx: 0.35 * Math.min(Math.max((e - 200) / 150, 0), 1) }]),
  };

  let scene: ((e: number) => HandSpec[] | null) | null = null;
  let t0 = 0;
  window.__sceneDone = true;
  window.__detectCalls = 0;
  window.__play = name => { scene = scenes[name]; t0 = performance.now(); window.__sceneDone = false; };

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
const strokeCount = (page: Page) => page.evaluate(() => window.__airDraw.strokes.length);
const lastToast = (page: Page) => page.evaluate(() => window.__airDraw.toasts.at(-1));

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  return errors;
}

test("gestures: draw, thumb-out guard, double-pinch undo, flick clear, restore", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(installMock);
  await page.goto("/");

  const startBtn = page.getByRole("button", { name: "Start camera" });
  await expect(startBtn).toBeEnabled();
  await startBtn.click();
  await expect(page.getByTestId("start-screen")).toBeHidden();
  await page.waitForFunction(() => window.__detectCalls > 3);

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

// Needs network: downloads the real WASM runtime and model from the CDN.
test("real MediaPipe model loads and runs on camera frames", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");

  const startBtn = page.getByRole("button", { name: /Loading model|Start camera/ });
  await expect(startBtn).toHaveText("Loading model…");
  await expect(startBtn).toBeDisabled();
  await expect(startBtn).toHaveText("Start camera", { timeout: 45_000 });
  await startBtn.click();
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
