import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DRAW_ARM_MS } from "../features/air-draw/constants";
import { createDeck, isCorrect } from "../features/game/deck";
import { WORDS, type Word } from "../features/languages/words";
import { fixBatchSize } from "../features/quickdraw/flatbuffer";
import { BUILTIN_LABELS, parseLabels } from "../features/quickdraw/labels";
import { toProbabilities, topK } from "../features/quickdraw/model";
import { installMock, langButton, play, testWord, trackErrors } from "./support/mock-hand";

// ---------------------------------------------------------------------------------------------
// Pure logic (runs in Node)
// ---------------------------------------------------------------------------------------------

/**
 * A minimal TFLite-shaped flatbuffer: Model.subgraphs[0].tensors[*], each tensor with a `shape`
 * (field 0) and optionally a `shape_signature` (field 7). Returns the bytes and where every
 * int32 vector's elements start, so the test can read them back.
 */
function tinyModel(tensors: { shape: number[]; signature?: number[] }[]) {
  const buf = new Uint8Array(1024);
  const dv = new DataView(buf.buffer);
  let pos = 4; // [0..4) is the root offset
  const u16 = (v: number) => { dv.setUint16(pos, v, true); pos += 2; };
  const i32 = (v: number) => { dv.setInt32(pos, v, true); pos += 4; };
  const slot = () => { const at = pos; pos += 4; return at; }; // a uoffset to fill in later
  const point = (at: number, target: number) => dv.setUint32(at, target - at, true);
  /** vtable + table whose present fields are all 4-byte offsets; returns the offset slots by field id. */
  const table = (fieldCount: number, present: number[]) => {
    const vt = pos;
    u16(4 + 2 * fieldCount); u16(4 + 4 * present.length);
    for (let f = 0; f < fieldCount; f++) u16(present.includes(f) ? 4 + 4 * present.indexOf(f) : 0);
    const at = pos;
    i32(at - vt);
    return { at, slots: Object.fromEntries(present.map(f => [f, slot()])) };
  };
  const vector = (n: number) => { const at = pos; i32(n); return at; };

  const model = table(3, [2]); // Model.subgraphs = field 2
  point(0, model.at);
  const subgraphs = vector(1);
  point(model.slots[2], subgraphs);
  const subgraphSlot = slot();
  const subgraph = table(1, [0]); // SubGraph.tensors = field 0
  point(subgraphSlot, subgraph.at);
  const tensorVec = vector(tensors.length);
  point(subgraph.slots[0], tensorVec);
  const tensorSlots = tensors.map(slot);

  const vectors: { shape: number; signature?: number }[] = [];
  tensors.forEach((t, i) => {
    const tensor = table(8, t.signature ? [0, 7] : [0]); // Tensor.shape = 0, Tensor.shape_signature = 7
    point(tensorSlots[i], tensor.at);
    const write = (dims: number[], at: number) => { point(at, vector(dims.length)); const start = pos; dims.forEach(i32); return start; };
    const entry: { shape: number; signature?: number } = { shape: write(t.shape, tensor.slots[0]) };
    if (t.signature) entry.signature = write(t.signature, tensor.slots[7]);
    vectors.push(entry);
  });
  const read = (at: number, n: number) => Array.from({ length: n }, (_, i) => dv.getInt32(at + 4 * i, true));
  return { bytes: buf.slice(0, pos), vectors, read };
}

test.describe("fixBatchSize", () => {
  test("rewrites a leading -1 in shape and shape_signature to 1, in place", () => {
    const { bytes, vectors } = tinyModel([
      { shape: [-1, 28, 28, 1], signature: [-1, 28, 28, 1] }, // Keras input: flexible batch
      { shape: [1, 345], signature: [-1, 345] }, // only the signature is flexible
      { shape: [64], signature: [64] }, // a weight tensor: untouched
      { shape: [-1, 7] }, // no signature at all
      { shape: [3, -1, 2], signature: [3, -1, 2] }, // -1 that is not the batch dimension: untouched
      { shape: [] },
    ]);
    const before = bytes.slice();
    const out = fixBatchSize(bytes);
    expect(out).toBe(bytes); // patched in place…
    expect(out.byteLength).toBe(before.byteLength); // …without changing the size

    const dv = new DataView(out.buffer);
    const dims = (at: number, n: number) => Array.from({ length: n }, (_, i) => dv.getInt32(at + 4 * i, true));
    expect(dims(vectors[0].shape, 4)).toEqual([1, 28, 28, 1]);
    expect(dims(vectors[0].signature!, 4)).toEqual([1, 28, 28, 1]);
    expect(dims(vectors[1].shape, 2)).toEqual([1, 345]);
    expect(dims(vectors[1].signature!, 2)).toEqual([1, 345]);
    expect(dims(vectors[2].shape, 1)).toEqual([64]);
    expect(dims(vectors[3].shape, 2)).toEqual([1, 7]);
    expect(dims(vectors[4].shape, 3)).toEqual([3, -1, 2]);
    expect(dims(vectors[4].signature!, 3)).toEqual([3, -1, 2]);

    // exactly four int32s changed, nothing else
    const changed = [...out].filter((b, i) => b !== before[i]).length;
    expect(changed).toBe(4 * 4); // -1 (ff ff ff ff) → 1 (01 00 00 00) differs in all four bytes
  });

  test("is idempotent and leaves a static model alone", () => {
    const { bytes } = tinyModel([{ shape: [1, 28, 28, 1], signature: [1, 28, 28, 1] }]);
    const before = bytes.slice();
    expect(fixBatchSize(bytes)).toEqual(before);
  });

  test("does not throw on bytes that are not a flatbuffer", () => {
    const junk = new TextEncoder().encode("version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 8851924\n");
    expect(() => fixBatchSize(junk.slice())).not.toThrow();
    expect(() => fixBatchSize(new Uint8Array(3))).not.toThrow();
  });

  test("the shipped model has a flexible batch size, and the patch removes it", () => {
    const model = new Uint8Array(readFileSync(join(__dirname, "../public/models/quickdraw_model.tflite")));
    expect(model.byteLength).toBeGreaterThan(8_000_000); // the real binary, not a Git LFS pointer
    const patched = fixBatchSize(model.slice());
    expect(patched.byteLength).toBe(model.byteLength);
    const changed = [...patched].filter((b, i) => b !== model[i]).length;
    expect(changed).toBeGreaterThan(0);
    expect(changed % 4).toBe(0);
    expect(fixBatchSize(patched.slice())).toEqual(patched);
  });
});

test.describe("labels and scoring", () => {
  test("built-in labels match labels.txt, in ASCII order", () => {
    const file = parseLabels(readFileSync(join(__dirname, "../public/models/labels.txt"), "utf8"));
    expect(file).toEqual([...BUILTIN_LABELS]);
    expect(BUILTIN_LABELS).toHaveLength(345);
    expect(BUILTIN_LABELS.slice(0, 5)).toEqual(["The Eiffel Tower", "The Great Wall of China", "The Mona Lisa", "aircraft carrier", "airplane"]);
    expect(BUILTIN_LABELS.indexOf("baseball")).toBeLessThan(BUILTIN_LABELS.indexOf("baseball bat"));
    expect(BUILTIN_LABELS.indexOf("cell phone")).toBeLessThan(BUILTIN_LABELS.indexOf("cello"));
  });

  test("every flashcard word maps to Quick Draw classes; the top guess decides", () => {
    expect(new Set(WORDS.map(w => w.id)).size).toBe(WORDS.length);
    for (const w of WORDS) {
      expect(w.labels.length, w.id).toBeGreaterThan(0);
      for (const label of w.labels) expect(BUILTIN_LABELS, `${w.id} → ${label}`).toContain(label);
    }
    const apple = WORDS.find(w => w.id === "apple")!, boat = WORDS.find(w => w.id === "boat")!;
    expect(apple.es).toBe("la manzana");
    expect(isCorrect(apple, "apple")).toBe(true);
    expect(isCorrect(apple, "pear")).toBe(false);
    expect(isCorrect(apple, undefined)).toBe(false); // nothing drawn
    expect(isCorrect(boat, "sailboat")).toBe(true); // "boat" is not a class: any kind of boat counts
    expect(isCorrect(boat, "canoe")).toBe(true);
  });

  test("the deck deals every word once before repeating", () => {
    const deal = createDeck();
    const first = Array.from({ length: WORDS.length }, deal);
    expect(new Set(first).size).toBe(WORDS.length);
    expect(deal()).not.toBe(first.at(-1)); // no back-to-back repeat across the reshuffle
    const ordered = createDeck(WORDS.slice(0, 3), false);
    expect([ordered(), ordered(), ordered(), ordered()].map(w => w.id)).toEqual(["sun", "cat", "house", "sun"]);
  });

  test("a labels file is accepted only with exactly 345 non-empty lines", () => {
    expect(parseLabels(BUILTIN_LABELS.join("\r\n") + "\n\n")).toHaveLength(345);
    expect(parseLabels(BUILTIN_LABELS.slice(1).join("\n"))).toBeNull();
    expect(parseLabels([...BUILTIN_LABELS, "extra"].join("\n"))).toBeNull();
  });

  test("softmax safety net and top-k", () => {
    const probs = new Float32Array([0.1, 0.6, 0.3]);
    expect(toProbabilities(probs)).toBe(probs); // already probabilities: untouched
    const fromLogits = toProbabilities(new Float32Array([-1, 2, 0]));
    expect(fromLogits.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(fromLogits[1]).toBeGreaterThan(fromLogits[2]);
    expect(topK(probs, ["a", "b", "c"], 2)).toEqual([{ label: "b", prob: probs[1] }, { label: "c", prob: probs[2] }]);
  });
});

// ---------------------------------------------------------------------------------------------
// In the browser, against the real model (the hand tracker is mocked, so no network is needed)
// ---------------------------------------------------------------------------------------------

async function startGame(page: Page, deck: Word[] = [testWord("zebra", "zebra")]) {
  await page.addInitScript(installMock);
  await page.addInitScript(d => { window.__gameDeck = d; }, deck);
  await page.goto("/");
  await langButton(page, /Español/).click(); // picking a language starts the game
  await expect(page.getByTestId("start-screen")).toBeHidden();
  await page.waitForFunction(() => window.__quickDraw.status.state === "ready", null, { timeout: 30_000 });
  await page.waitForTimeout(DRAW_ARM_MS); // the pen is held up briefly after starting
}

const AT = (row: number, col: number) => row * 28 + col;

test.describe("classifier", () => {
  test("loads self-hosted: float32 [1,28,28,1] model, labels.txt, nothing from another origin", async ({ page, baseURL }) => {
    const errors = trackErrors(page);
    const requests: string[] = [];
    page.on("request", r => requests.push(r.url()));
    await startGame(page);

    await page.keyboard.press("d");
    await expect(page.getByTestId("quickdraw-status")).toHaveText(
      "Ready — quickdraw_model.tflite · [1, 28, 28, 1] float32 · labels: labels.txt");

    const external = requests.filter(u => /^https?:/.test(u) && !u.startsWith(baseURL!));
    expect(external).toEqual([]);
    const assets = requests.filter(u => /\.(wasm|tflite)$|litert_wasm|labels\.txt/.test(u)).map(u => new URL(u).pathname);
    expect(assets).toContain("/models/quickdraw_model.tflite");
    expect(assets).toContain("/models/labels.txt");
    expect(assets.some(p => /^\/wasm\/litert_wasm(_compat)?_internal\.wasm$/.test(p))).toBe(true);
    expect(assets.filter(p => /int8|threaded|jspi/.test(p))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("preprocessing: centred, white on black, 28×28", async ({ page }) => {
    await startGame(page);
    const toInput = (strokes: [number, number][][]) => page.evaluate(s => window.__quickDraw.toInput(s), strokes);

    expect(await toInput([])).toBeNull();
    expect(await toInput([[]])).toBeNull();

    // a vertical stroke at the far left of the pad lands in the centre columns
    const vertical = (await toInput([[[0.02, 0.1], [0.02, 0.9]]]))!;
    expect(vertical).toHaveLength(784);
    expect(Math.min(...vertical)).toBe(0); // background is 0.0…
    // …and the stroke is bright (INVERT = false). A 12 px line on the 256 canvas is ~1.3 px wide
    // at 28 × 28, so centred between two columns it lights each of them to about 0.65.
    expect(Math.max(...vertical)).toBeGreaterThan(0.6);
    for (const row of [4, 14, 23]) {
      expect(vertical[AT(row, 13)] + vertical[AT(row, 14)]).toBeGreaterThan(1.2);
      for (const col of [0, 5, 10, 17, 22, 27]) expect(vertical[AT(row, col)]).toBe(0);
    }
    // it fills the height: the 10 px padding leaves only the round cap's tip in the outer rows
    for (const row of [0, 27]) expect(vertical[AT(row, 13)]).toBeLessThan(vertical[AT(14, 13)]);

    // a horizontal stroke near the bottom lands in the centre rows, spanning the width
    const horizontal = (await toInput([[[0.2, 0.95], [0.6, 0.95]]]))!;
    for (const col of [4, 14, 23]) {
      expect(horizontal[AT(13, col)] + horizontal[AT(14, col)]).toBeGreaterThan(1.2);
      for (const row of [0, 5, 10, 17, 22, 27]) expect(horizontal[AT(row, col)]).toBe(0);
    }

    // where it was drawn on the pad does not matter, only its shape
    const moved = (await toInput([[[0.7, 0.05], [0.7, 0.45]]]))!;
    const scaled = (await toInput([[[0.5, 0.2], [0.5, 1.0]]]))!;
    expect(moved).toEqual(scaled);

    // a single point shows up as a centred dot
    const dot = (await toInput([[[0.9, 0.1]]]))!;
    expect(dot[AT(13, 13)] + dot[AT(13, 14)] + dot[AT(14, 13)] + dot[AT(14, 14)]).toBeGreaterThan(1);
    expect(dot[AT(3, 3)]).toBe(0);
    expect(dot.reduce((a, b) => a + b, 0)).toBeLessThan(12);

    // a square fills the box: lit on all four edges, empty in the middle
    const square = (await toInput([[[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5], [0.1, 0.1]]]))!;
    expect(square[AT(14, 14)]).toBe(0);
    for (const [r, c] of [[1, 14], [26, 14], [14, 1], [14, 26]]) expect(square[AT(r, c)]).toBeGreaterThan(0.5);
  });

  test("matches the reference interpreter on an identical input", async ({ page }) => {
    // written by scripts/quickdraw-verify/verify.py: one real Quick Draw bitmap and the Python output for it
    const fixture: { label: string; input: number[]; probs: number[] } =
      JSON.parse(readFileSync(join(__dirname, "fixtures/quickdraw-parity.json"), "utf8"));
    await startGame(page);

    const probs = await page.evaluate(input => window.__quickDraw.probabilities(input), fixture.input);
    expect(probs).toHaveLength(345);
    const worst = Math.max(...probs.map((p, i) => Math.abs(p - fixture.probs[i])));
    expect(worst).toBeLessThan(1e-3);
    expect(probs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(BUILTIN_LABELS[probs.indexOf(Math.max(...probs))]).toBe(fixture.label);
  });

  test("no wasm memory growth over many predictions and load / dispose cycles", async ({ page }) => {
    test.setTimeout(120_000);
    const errors = trackErrors(page);
    await startGame(page);
    const input = Array.from({ length: 784 }, (_, i) => (i % 28 === 14 ? 1 : 0));
    const predictMany = (n: number) => page.evaluate(async ({ input, n }) => {
      for (let i = 0; i < n; i++) await window.__quickDraw.probabilities(input);
      return window.__quickDraw.heapBytes();
    }, { input, n });
    const cycle = (n: number) => page.evaluate(async n => {
      for (let i = 0; i < n; i++) await window.__quickDraw.loadAndDispose();
      return window.__quickDraw.heapBytes();
    }, n);

    const warm = await predictMany(50);
    expect(await predictMany(1500)).toBe(warm); // tensors are deleted

    const afterFirstCycles = await cycle(2); // the allocator may grow once to fit a second model
    expect(await cycle(6)).toBe(afterFirstCycles); // disposed models are freed
    expect(errors).toEqual([]);
  });
});

test.describe("game", () => {
  test("shows the word; the round is won when it is the top guess, then the next word comes up", async ({ page }) => {
    const errors = trackErrors(page);
    await startGame(page, [testWord("line", "line"), testWord("zebra", "zebra")]);
    const card = page.getByTestId("word-card");

    await expect(page.getByTestId("word")).toHaveText("line");
    await expect(card).toHaveAttribute("data-solved", "false");
    await expect(card).toContainText("Draw this · Español");

    await play(page, "pointTucked"); // a straight horizontal stroke
    await page.waitForFunction(() => window.__quickDraw.prediction.guesses.length === 5);
    expect(await page.evaluate(() => window.__quickDraw.prediction.guesses[0].label)).toBe("line");
    await expect(card).toHaveAttribute("data-solved", "true");
    await expect(card).toContainText("Correct!");

    // next round: new word, clean canvas, guesses reset
    await expect(page.getByTestId("word")).toHaveText("zebra", { timeout: 5_000 });
    await expect(card).toHaveAttribute("data-solved", "false");
    expect(await page.evaluate(() => window.__airDraw.strokes.length)).toBe(0);
    expect(await page.evaluate(() => window.__quickDraw.prediction.guesses)).toEqual([]);

    // the same drawing is not a zebra: the word stays
    await play(page, "pointTucked");
    await page.waitForFunction(() => window.__quickDraw.prediction.guesses.length === 5);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("word")).toHaveText("zebra");
    await expect(card).toHaveAttribute("data-solved", "false");
    expect(await page.evaluate(() => window.__quickDraw.rounds)).toEqual(["line", "zebra"]);
    expect(errors).toEqual([]);
  });

  test("guesses follow the drawing: top 5 with percentages, cleared with the canvas, skip moves on", async ({ page }) => {
    await startGame(page, [testWord("cat", "cat"), testWord("zebra", "zebra")]);
    await page.keyboard.press("d");
    const guesses = page.getByTestId("quickdraw-guesses").getByRole("listitem");
    await expect(guesses).toHaveText(["Draw something…"]);

    await play(page, "pointTucked");
    await expect(guesses).toHaveCount(5);
    await expect(guesses.first()).toHaveText(/^1\. line\d+\.\d%$/);

    await page.keyboard.press("c"); // clear: no inference, guesses go away
    await expect(guesses).toHaveText(["Draw something…"]);
    await page.keyboard.press("z"); // undo the clear: judged again straight away
    await expect(guesses).toHaveCount(5);

    await expect(page.getByTestId("word")).toHaveText("cat");
    await page.getByRole("button", { name: "skip ›" }).click();
    await expect(page.getByTestId("word")).toHaveText("zebra");
    await expect(guesses).toHaveText(["Draw something…"]);

    await page.keyboard.press("d");
    await expect(page.getByTestId("quickdraw-debug")).toHaveCount(0);
  });

  test("two-hand shapes are judged too; going back to the languages ends the round", async ({ page }) => {
    await startGame(page, [testWord("line", "line"), testWord("zebra", "zebra"), testWord("cat", "cat")]);
    const card = page.getByTestId("word-card");
    await expect(page.getByTestId("word")).toHaveText("line");

    await play(page, "line"); // both hands pinch, pull apart, let go: a straight line is placed
    await expect(card).toHaveAttribute("data-solved", "true");
    await expect(page.getByTestId("word")).toHaveText("zebra", { timeout: 5_000 });

    await play(page, "pointTucked");
    await page.waitForFunction(() => window.__quickDraw.prediction.guesses.length === 5);
    await page.getByRole("button", { name: "Back to languages" }).click();
    await expect(page.getByTestId("start-screen")).toBeVisible();
    expect(await page.evaluate(() => window.__quickDraw.prediction.guesses)).toEqual([]);

    // picking again deals the next word on a clean canvas, in the new language
    await langButton(page, /Deutsch/).click();
    await expect(card).toHaveAttribute("data-lang", "de");
    await expect(card).toContainText("Draw this · Deutsch");
    await expect(page.getByTestId("word")).toHaveText("cat");
    await expect(card).toHaveAttribute("data-solved", "false");
    expect(await page.evaluate(() => window.__airDraw.strokes.length)).toBe(0);
    expect(await page.evaluate(() => window.__quickDraw.rounds)).toEqual(["line", "zebra", "cat"]);
  });
});
