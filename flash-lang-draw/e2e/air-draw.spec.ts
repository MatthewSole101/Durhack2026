import { expect, test, type Page } from "@playwright/test";
import { DRAW_ARM_MS, PALETTE } from "../features/air-draw/constants";
import { forgotten, hoverHand, installMock, langButton, play, testWord, trackErrors } from "./support/mock-hand";

const strokeCount = (page: Page) => page.evaluate(() => window.__airDraw.strokes.length);
const lastStroke = (page: Page) => page.evaluate(() => window.__airDraw.strokes.at(-1)!);
const lastToast = (page: Page) => page.evaluate(() => window.__airDraw.toasts.at(-1));

/** Open the page with the mock, pick a language with the mouse, wait until the pen is live. */
async function startDrawing(page: Page, lang = /Español/) {
  await page.addInitScript(installMock);
  // a word these scribbles can never be recognised as, so the round never ends mid-test
  await page.addInitScript(deck => { window.__gameDeck = deck; }, [testWord("mona-lisa", "The Mona Lisa")]);
  await page.goto("/");
  const btn = langButton(page, lang);
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(page.getByTestId("start-screen")).toBeHidden();
  await page.waitForFunction(() => window.__detectCalls > 3);
  await page.waitForTimeout(DRAW_ARM_MS); // the pen is held up briefly after starting
}

test("gestures: pinch to draw, thumb undo / redo, flick left to clear", async ({ page }) => {
  const errors = trackErrors(page);
  await startDrawing(page);

  await play(page, "pinchDraw"); // 1. pinch while moving: a stroke
  expect(await strokeCount(page)).toBe(1);
  expect(await page.evaluate(() => window.__airDraw.strokes[0].pts.length)).toBeGreaterThan(3);

  await play(page, "point"); // 2. pointing without a pinch draws nothing
  expect(await strokeCount(page)).toBe(1);

  await play(page, "pinchGlitchy", { forget: false }); // 3. a pinch flicker and a tracking dropout don't break the stroke
  expect(await strokeCount(page)).toBe(2);
  // the hand has gone, but it is remembered for a moment, still mid-stroke…
  expect(await page.evaluate(() => window.__airDraw.hands)).toEqual([0, 1]);
  expect(await page.evaluate(() => window.__airDraw.strokes[1].active)).toBe(true);
  await forgotten(page); // …then forgotten, which ends the stroke
  expect(await page.evaluate(() => window.__airDraw.strokes.every(s => !s.active))).toBe(true);

  await play(page, "thumbLeft"); // 4. 👈 undo (fires once, however long it's held)
  expect(await strokeCount(page)).toBe(1);
  expect(await lastToast(page)).toBe("↩ Undo");
  await expect(page.getByTestId("toast")).toHaveText("↩ Undo");

  await play(page, "thumbRight"); // 5. 👉 redo
  expect(await strokeCount(page)).toBe(2);
  expect(await lastToast(page)).toBe("↪ Redo");

  await play(page, "flickRight"); // 6. flicking right or swiping slowly doesn't clear…
  await play(page, "swipeLeftSlow");
  expect(await strokeCount(page)).toBe(2);
  await play(page, "flick"); // …a quick flick to the left does
  expect(await strokeCount(page)).toBe(0);
  expect(await lastToast(page)).toBe("✨ Cleared");

  await play(page, "thumbLeft"); // 7. undo the clear
  expect(await strokeCount(page)).toBe(2);
  expect(await lastToast(page)).toBe("↩ Restored");

  await page.keyboard.press("c"); // keyboard fallbacks
  expect(await strokeCount(page)).toBe(0);
  await page.keyboard.press("z");
  await page.keyboard.press("y");
  expect(await strokeCount(page)).toBe(0);

  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual(
    ["↩ Undo", "↪ Redo", "✨ Cleared", "↩ Restored", "✨ Cleared", "↩ Restored", "↪ Redo"]);
  expect(errors).toEqual([]);
});

test("two hands can draw at once; pinching both together makes a line instead", async ({ page }) => {
  await startDrawing(page);
  await play(page, "twoPinchDraw");
  expect(await strokeCount(page)).toBe(2);
  expect(await page.evaluate(() => window.__airDraw.strokes.map(s => s.shape ?? "ink"))).toEqual(["ink", "ink"]);

  await play(page, "line");
  expect(await strokeCount(page)).toBe(3); // no ink from the pinches, just the line
  expect(await lastStroke(page)).toMatchObject({ shape: "line" });
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

  await play(page, "rect");
  s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "rect" });
  expect(s.pts).toHaveLength(4);
  // corners are where each L's thumb and index lines meet (30 / 33 units in from the wrist), not the fingertips
  const [vw, vh] = await page.evaluate(() => [document.querySelector("video")!.videoWidth, document.querySelector("video")!.videoHeight]);
  const k = vh / 720;
  const near = (p: [number, number], x: number, y: number) => Math.hypot(p[0] - x, p[1] - y) < 12 * k + 2;
  expect(near(s.pts[0], 0.25 * vw + 30 * k, 0.85 * vh - 33 * k)).toBe(true);
  expect(near(s.pts[2], 0.75 * vw - 30 * k, 0.55 * vh - 33 * k)).toBe(true);

  await play(page, "circle");
  s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "circle" });
  expect(s.pts.length).toBeGreaterThan(30);
  const xs = s.pts.map(p => p[0]), ys = s.pts.map(p => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
  expect(w).toBeGreaterThan(300 * k); // grew as the hands parted (each hand's curve ends up ~190 units from the middle)
  expect(Math.abs(w - h)).toBeLessThan(4); // round
  expect(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - vw / 2)).toBeLessThan(6); // centred between the hands

  expect(await strokeCount(page)).toBe(4);
  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual([`🎨 ${coral.name}`]); // shape releases aren't undo / clear
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("start screen: hand-pick a language, go back, pick another", async ({ page }) => {
  const errors = trackErrors(page);
  await page.addInitScript(installMock);
  await page.goto("/");

  const russian = langButton(page, /Русский/);
  await expect(russian).toBeEnabled();
  await page.waitForFunction(() => window.__detectCalls > 3); // menu-mode tracking is running
  await expect(page.getByRole("button", { name: /Start/ })).toHaveCount(0); // no separate Start button

  // hover Russian: a Russian flag is painted in next to the finger, then the drawing page opens
  const cursor = page.getByTestId("hand-cursor");
  await hoverHand(page, russian, 1700);
  await expect(cursor).toHaveAttribute("data-state", "dwell");
  await expect(cursor).toHaveAttribute("data-flag", "ru");
  await expect(page.getByTestId("hand-cursor-flag")).toBeVisible();
  await expect(russian).toHaveAttribute("data-hand-hover", "");
  await expect(page.getByTestId("start-screen")).toBeHidden();
  const card = page.getByTestId("word-card");
  await expect(card).toHaveAttribute("data-lang", "ru");
  await expect(card).toContainText("Русский");
  // the gesture cheat-sheet is open when the drawing page opens
  await expect(page.getByTestId("gesture-hints")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("gesture-hints")).toContainText("thumb pointing left");
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
  await langButton(page, /Polski/).click();
  await expect(card).toHaveAttribute("data-lang", "pl");
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
