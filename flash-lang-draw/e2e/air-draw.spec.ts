import { expect, test, type Page } from "@playwright/test";
import { DRAW_ARM_MS, PALETTE } from "../features/air-draw/constants";
import { hoverHand, installMock, langButton, play, testWord, trackErrors } from "./support/mock-hand";

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
