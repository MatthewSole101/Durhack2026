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
  // The doodle classifier compiles on the main thread while the page loads; with the mock hand
  // tracker the game is reachable before that is done, and a scene played meanwhile loses frames.
  await page.waitForFunction(() => window.__quickDraw.status.state === "ready", null, { timeout: 30_000 });
  await page.waitForTimeout(DRAW_ARM_MS); // the pen is held up briefly after starting
}

test("gestures: pinch to draw, thumb undo / redo, snap to clear", async ({ page }) => {
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

  // 6. 🫰 snap to clear: with the microphone on, the snap has to be heard and the hand seen snapping
  await page.evaluate(() => window.__airDraw.setMic("on"));
  await page.evaluate(() => window.__airDraw.snapSound()); // a click with no hand in view…
  await page.waitForTimeout(1000);
  await play(page, "snap"); // …or a snap that isn't heard…
  await play(page, "fistOpen", { soundAt: 420 }); // …or a fist opening, with a click: nothing
  expect(await strokeCount(page)).toBe(2);
  await play(page, "snap", { soundAt: 430 }); // seen and heard together: cleared
  expect(await strokeCount(page)).toBe(0);
  expect(await lastToast(page)).toBe("🫰 Cleared"); // the toast says what cleared it

  await play(page, "thumbLeft"); // 7. undo the clear
  expect(await strokeCount(page)).toBe(2);
  expect(await lastToast(page)).toBe("↩ Restored");

  // 7b. the snap itself is often a blur: set up for a snap + the sound is enough
  await play(page, "snapBlurred", { soundAt: 450 });
  expect(await strokeCount(page)).toBe(0);
  await play(page, "thumbLeft");
  expect(await strokeCount(page)).toBe(2);

  // 8. without a microphone a snap that is seen is enough; a fist opening is not a snap
  await page.evaluate(() => window.__airDraw.setMic("off"));
  await play(page, "fistOpen");
  expect(await strokeCount(page)).toBe(2);
  await play(page, "snap");
  expect(await strokeCount(page)).toBe(0);

  await page.keyboard.press("z"); // keyboard fallbacks
  expect(await strokeCount(page)).toBe(2);
  await page.keyboard.press("c");
  expect(await strokeCount(page)).toBe(0);
  await page.keyboard.press("z");
  await page.keyboard.press("y");
  expect(await strokeCount(page)).toBe(0);

  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual(
    ["↩ Undo", "↪ Redo", "🫰 Cleared", "↩ Restored", "🫰 Cleared", "↩ Restored", "🫰 Cleared", "↩ Restored", "✨ Cleared", "↩ Restored", "↪ Redo"]);
  expect(errors).toEqual([]);
});

test("clapping clears too, by sight alone", async ({ page }) => {
  const errors = trackErrors(page);
  await startDrawing(page);
  await play(page, "pinchDraw");
  expect(await strokeCount(page)).toBe(1);

  for (const mic of ["on", "off"] as const) { // the microphone makes no difference to a clap
    await page.evaluate(m => window.__airDraw.setMic(m), mic);
    await play(page, "handsMeet"); // two open hands drifting together slowly…
    await play(page, "fistBump"); // …or two fists knocked together: nothing
    expect(await strokeCount(page)).toBe(1);
    await play(page, "clap"); // two open hands brought together fast: cleared
    expect(await strokeCount(page)).toBe(0);
    expect(await lastToast(page)).toBe("👏 Cleared");
    await play(page, "thumbLeft"); // undo the clear
    expect(await strokeCount(page)).toBe(1);
    expect(await lastToast(page)).toBe("↩ Restored");
  }

  // hands that meet often blur or merge into one: closing fast, then lost, is enough
  await play(page, "clapBlurred");
  expect(await strokeCount(page)).toBe(0);
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("closing the hand stops the pen, and nothing clears the drawing by accident", async ({ page }) => {
  const errors = trackErrors(page);
  await startDrawing(page);
  const vw = await page.evaluate(() => document.querySelector("video")!.videoWidth);

  // 1. a stroke (0.1 of the frame wide), then the hand closes into a fist — thumb resting on the
  //    folded index finger, which used to read as a pinch — and travels twice as far again
  await play(page, "pinchThenFist");
  expect(await strokeCount(page)).toBe(1);
  const xs = (await lastStroke(page)).pts.map(p => p[0]);
  const span = (Math.max(...xs) - Math.min(...xs)) / vw;
  expect(span).toBeGreaterThan(0.07); // what was drawn while pinched is kept…
  expect(span).toBeLessThan(0.13); // …and the fist drew nothing (0.3 if it had)
  expect(await page.evaluate(() => window.__airDraw.strokes.every(s => !s.active))).toBe(true);

  // 2. a closed fist at rest, thumb across the middle finger, is not a hand set up to snap:
  //    a sharp noise in the room doesn't clear the drawing, and neither does taking the fist
  //    out of view (with no microphone a snap is judged by sight alone)
  for (const mic of ["on", "off"] as const) {
    await page.evaluate(m => window.__airDraw.setMic(m), mic);
    await play(page, "fistRest", { soundAt: 800 });
    expect(await strokeCount(page), `fist at rest, microphone ${mic}`).toBe(1);
  }

  // 3. a second "hand" that flickers in beside an open hand, slides towards it and is gone
  //    (a face or a sleeve mistaken for a hand) is not a clap
  await play(page, "phantom");
  expect(await strokeCount(page)).toBe(1);

  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual([]); // nothing cleared, undone or redone
  await expect(page.getByTestId("error-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the pen follows the pinch closely: open fingers stop drawing, a pad pinch draws", async ({ page }) => {
  await startDrawing(page);
  const vw = await page.evaluate(() => document.querySelector("video")!.videoWidth);
  // pinched for the first 400 ms of a 900 ms sweep, then fingers ~1.5 cm apart for the rest
  await play(page, "pinchThenOpen");
  expect(await strokeCount(page)).toBe(1);
  const xs = (await lastStroke(page)).pts.map(p => p[0]);
  const span = (Math.max(...xs) - Math.min(...xs)) / vw;
  expect(span).toBeGreaterThan(0.04); // drew while pinched (≈ 0.09 of the frame)…
  expect(span).toBeLessThan(0.13); // …and stopped once the fingers opened (the whole sweep is 0.2)

  await play(page, "pinchPad"); // thumb on the pad of the index fingertip, not tip to tip
  expect(await strokeCount(page)).toBe(2);
});

test("moving the hand around doesn't draw by accident", async ({ page }) => {
  await startDrawing(page);
  await play(page, "pinchBrush"); // thumb brushes the fingertip for a moment
  await play(page, "pinchFast"); // a fast sweep with the fingertips together
  await play(page, "thumbSide"); // a relaxed hand: thumb against the side of the index finger
  await play(page, "point"); // pointing
  expect(await strokeCount(page)).toBe(0);
  await play(page, "drawThenThumb"); // closing the hand after a stroke, thumb out: no 👉 redo / 👈 undo
  expect(await strokeCount(page)).toBe(1);
  expect(await page.evaluate(() => window.__airDraw.toasts)).toEqual([]);
  await page.keyboard.press("z");
  expect(await strokeCount(page)).toBe(0);
  await play(page, "pinchDraw"); // a real pinch still draws, from where it started
  expect(await strokeCount(page)).toBe(1);
  const xs = (await lastStroke(page)).pts.map(p => p[0]);
  const vw = await page.evaluate(() => document.querySelector("video")!.videoWidth);
  expect((Math.max(...xs) - Math.min(...xs)) / vw).toBeGreaterThan(0.08); // nearly the whole 0.1 sweep
});

test("two hands can draw at once; pinching both together makes a line instead", async ({ page }) => {
  await startDrawing(page);
  await play(page, "twoPinchDraw");
  expect(await strokeCount(page)).toBe(2);
  expect(await page.evaluate(() => window.__airDraw.strokes.map(s => s.shape ?? "ink"))).toEqual(["ink", "ink"]);

  await play(page, "line");
  expect(await strokeCount(page)).toBe(3); // no ink from the pinches, just the line
  expect(await lastStroke(page)).toMatchObject({ shape: "line" });

  await play(page, "lineStaggered"); // pinch one hand, then the other later, holding still: also a line
  expect(await strokeCount(page)).toBe(4);
  const s = await lastStroke(page);
  expect(s).toMatchObject({ shape: "line" });
  expect(Math.abs(s.pts[1][0] - s.pts[0][0])).toBeGreaterThan(200); // stretched out
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

  const ukrainian = langButton(page, /Українська/);
  await expect(ukrainian).toBeEnabled();
  await page.waitForFunction(() => window.__detectCalls > 3); // menu-mode tracking is running
  await expect(page.getByRole("button", { name: /Start/ })).toHaveCount(0); // no separate Start button

  // hover Ukrainian: a Ukrainian flag is painted in next to the finger, then the drawing page opens
  const cursor = page.getByTestId("hand-cursor");
  await hoverHand(page, ukrainian, 1700);
  await expect(cursor).toHaveAttribute("data-state", "dwell");
  await expect(cursor).toHaveAttribute("data-flag", "uk");
  await expect(page.getByTestId("hand-cursor-flag")).toBeVisible();
  await expect(ukrainian).toHaveAttribute("data-hand-hover", "");
  await expect(page.getByTestId("start-screen")).toBeHidden();
  const card = page.getByTestId("word-card");
  await expect(card).toHaveAttribute("data-lang", "uk");
  // the gesture cheat-sheet is open when the drawing page opens
  await expect(page.getByTestId("gesture-hints")).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId("gesture-hints")).toContainText("clap your hands");
  await expect(page.getByTestId("gesture-hints")).toContainText("snap your fingers");
  await page.waitForFunction(() => window.__sceneDone);
  // the finger that picked was still pointing, but the pen stays up for a moment
  expect(await strokeCount(page)).toBe(0);

  // the cheat-sheet's × and the "How to draw ?" pill are pressed by hand too
  const hints = page.getByTestId("gesture-hints");
  await hoverHand(page, page.getByRole("button", { name: "Hide hints" }), 1700);
  await expect(hints).toHaveAttribute("data-open", "false");
  await page.waitForFunction(() => window.__sceneDone);
  await hoverHand(page, page.getByRole("button", { name: "How to draw ?" }), 1700);
  await expect(hints).toHaveAttribute("data-open", "true");
  await page.waitForFunction(() => window.__sceneDone);

  // drawing (pinching) across the back button doesn't press it
  const back = page.getByRole("button", { name: "Back to languages" });
  await hoverHand(page, back, 1700, { pinch: true });
  await page.waitForFunction(() => window.__sceneDone);
  await expect(page.getByTestId("start-screen")).toBeHidden();
  await expect(cursor).toHaveAttribute("data-state", "hidden");

  // back button, pressed by hand (the cursor only shows up over it)
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
