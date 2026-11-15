import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DRAW_ARM_MS } from "../features/air-draw/constants";
import { createDeck, isCorrect } from "../features/game/deck";
import { hintLetters, maskWord } from "../features/game/hint";
import { LANGUAGES } from "../features/languages/languages";
import { translate, WORDS, wordForLabel, type Word } from "../features/languages/words";
import { fixBatchSize } from "../features/quickdraw/flatbuffer";
import { createRanker } from "../features/quickdraw/guesses";
import { BUILTIN_LABELS, labelKey, parseLabels } from "../features/quickdraw/labels";
import { toProbabilities } from "../features/quickdraw/model";
import { installMock, langButton, play, testWord, trackErrors } from "./support/mock-hand";

/** Is this Quick Draw class one of the flashcard words? (The same rule the game uses to prune its guesses.) */
const isWord = (label: string) => wordForLabel(label) !== undefined;
/** The model's own top classes over all 345, nothing pruned: what the game used to rank on. */
const rawTop = (probs: ArrayLike<number>, k = 5) =>
  Array.from(probs, (prob, i) => ({ label: BUILTIN_LABELS[i], prob })).sort((a, b) => b.prob - a.prob).slice(0, k);
const total = (guesses: { prob: number }[]) => guesses.reduce((sum, g) => sum + g.prob, 0);

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
    expect(WORDS).toHaveLength(214);
    expect(new Set(WORDS.map(w => w.id)).size).toBe(WORDS.length);
    for (const w of WORDS) {
      expect(w.labels.length, w.id).toBeGreaterThan(0);
      for (const label of w.labels) expect(BUILTIN_LABELS, `${w.id} → ${label}`).toContain(label);
    }
    // no class is claimed by two words (the later one would silently win in wordForLabel)
    const claimed = WORDS.flatMap(w => w.labels);
    expect(new Set(claimed).size).toBe(claimed.length);
    const apple = WORDS.find(w => w.id === "apple")!, sailboat = WORDS.find(w => w.id === "sailboat")!;
    expect(apple.t.es).toBe("la manzana");
    expect(isCorrect(apple, "apple")).toBe(true);
    expect(isCorrect(apple, "pear")).toBe(false);
    expect(isCorrect(apple, undefined)).toBe(false); // nothing drawn
    expect(isCorrect(sailboat, "sailboat")).toBe(true);
    expect(isCorrect(sailboat, "canoe")).toBe(false); // each kind of boat is its own word
  });

  test("every word is translated into every language on the start screen", () => {
    expect(LANGUAGES.map(l => l.code)).toEqual(["es", "uk", "pl", "id", "te", "yo", "ja"]);
    for (const w of WORDS) {
      expect(Object.keys(w.t).sort(), w.id).toEqual(LANGUAGES.map(l => l.code).sort());
      for (const l of LANGUAGES) expect(w.t[l.code].trim(), `${w.id}.${l.code}`).not.toBe("");
    }
    const sun = WORDS.find(w => w.id === "sun")!;
    expect(sun.id).toBe("sun"); // the word's id, not its Indonesian translation
    expect(sun.t).toEqual({ es: "el sol", uk: "сонце", pl: "słońce", id: "matahari", te: "సూర్యుడు", yo: "oòrùn", ja: "たいよう" });
  });

  test("wordForLabel maps every class of a word back to it, and misses non-dictionary labels", () => {
    // every label of every word resolves to that word (the reverse of the deck mapping)
    for (const w of WORDS) for (const label of w.labels) expect(wordForLabel(label), label).toBe(w);
    // a label with a space in it: the id is hyphenated, the label and the English are not
    const alarm = wordForLabel("alarm clock")!;
    expect(alarm.id).toBe("alarm-clock");
    expect(alarm.en).toBe("alarm clock");
    expect(alarm.t.es).toBe("el despertador");
    expect(alarm.t.ja).toBe("めざましどけい");
    // classes that are not flashcard words have no entry (they are pruned before ranking)
    expect(wordForLabel("squiggle")).toBeUndefined();
    expect(wordForLabel("The Eiffel Tower")).toBeUndefined();
  });

  test("labels are matched in canonical form: case, spacing, underscores and hyphens don't matter", () => {
    expect(labelKey("  Alarm_Clock ")).toBe("alarm clock");
    expect(labelKey("alarm   clock")).toBe("alarm clock");
    expect(labelKey("T-Shirt")).toBe("t shirt");
    // no two of the model's 345 classes collapse into one key
    expect(new Set(BUILTIN_LABELS.map(labelKey)).size).toBe(BUILTIN_LABELS.length);
    const alarm = wordForLabel("alarm clock")!, tshirt = wordForLabel("t-shirt")!;
    for (const variant of ["alarm_clock", "Alarm Clock", " alarm  clock ", "ALARM-CLOCK"]) expect(wordForLabel(variant), variant).toBe(alarm);
    for (const variant of ["t_shirt", "T-Shirt", "t shirt"]) expect(wordForLabel(variant), variant).toBe(tshirt);
    expect(isCorrect(alarm, "alarm_clock")).toBe(true); // the win check uses the same form
    expect(isCorrect(alarm, "Alarm Clock")).toBe(true);
    expect(isCorrect(alarm, "clock")).toBe(false);
    // a label list written another way still finds all 214 words, at the same indices
    const underscored = BUILTIN_LABELS.map(l => l.replace(/ /g, "_").toUpperCase());
    const ranked = createRanker(underscored)(BUILTIN_LABELS.map(() => 1), 345);
    expect(ranked).toHaveLength(WORDS.length);
    for (const g of ranked) expect(g.word, g.label).toBe(wordForLabel(BUILTIN_LABELS[underscored.indexOf(g.label)]));
  });

  test("every flashcard word resolves to a translation in every language, never falling back to English", () => {
    const warnings: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      // through the same path the feed takes: model label → guess → its word → translate()
      const guesses = createRanker(BUILTIN_LABELS)(BUILTIN_LABELS.map(() => 1), 345);
      expect(guesses).toHaveLength(WORDS.length); // every subset word has a model class (no warning about a missing one)
      for (const g of guesses) for (const l of LANGUAGES) expect(translate(g.word, l.code), `${g.label}.${l.code}`).toBe(g.word.t[l.code]);
      expect(warnings).toEqual([]);

      // a word that lost a translation falls back to English, and says so (once) in dev
      const broken = { ...testWord("ghost", "ghost"), en: "ghost (English)" };
      (broken.t as Record<string, string>).ja = " ";
      expect(translate(broken, "es")).toBe("ghost");
      expect(translate(broken, "ja")).toBe("ghost (English)");
      expect(translate(broken, "ja")).toBe("ghost (English)");
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0][0])).toContain('No "ja" translation for the word "ghost"');
    } finally {
      console.warn = warn;
    }
  });

  test("a hint shows 2–3 random letters of the word and stars out the rest", () => {
    const shown = (hint: string) => [...hint].filter(c => /\p{L}/u.test(c)).length; // letters left readable
    for (const [word, n] of [["word", 2], ["bucket", 2], ["backpack", 3], ["bed", 1], ["alarm clock", 3]] as const) {
      const hint = maskWord(word);
      expect(hint, word).toHaveLength(word.length);
      expect(shown(hint), word).toBe(n);
      [...hint].forEach((c, i) => expect(c === "*" || c === word[i], `${word} → ${hint}`).toBe(true)); // letters stay in place
    }
    expect(maskWord("alarm clock")[5]).toBe(" "); // spaces and hyphens are kept, not starred or counted
    expect(maskWord("t-shirt")[1]).toBe("-");
    expect(maskWord("word", () => 0)).toBe("wo**"); // which letters is up to the random source…
    expect(maskWord("word", () => 0.999)).toBe("w**d");
    expect(new Set(Array.from({ length: 60 }, () => maskWord("backpack"))).size).toBeGreaterThan(3); // …so hints vary
    for (const w of WORDS) expect(shown(maskWord(w.en)), w.en).toBe(hintLetters(w.en.replace(/[^\p{L}]/gu, "").length));
  });

  test("the deck deals every word once before repeating", () => {
    const deal = createDeck();
    const first = Array.from({ length: WORDS.length }, deal);
    expect(new Set(first).size).toBe(WORDS.length);
    expect(deal()).not.toBe(first.at(-1)); // no back-to-back repeat across the reshuffle
    const ordered = createDeck(WORDS.slice(0, 3), false);
    expect([ordered(), ordered(), ordered(), ordered()].map(w => w.id)).toEqual(["airplane", "alarm-clock", "ambulance", "airplane"]);
  });

  test("a labels file is accepted only with exactly 345 non-empty lines", () => {
    expect(parseLabels(BUILTIN_LABELS.join("\r\n") + "\n\n")).toHaveLength(345);
    expect(parseLabels(BUILTIN_LABELS.slice(1).join("\n"))).toBeNull();
    expect(parseLabels([...BUILTIN_LABELS, "extra"].join("\n"))).toBeNull();
  });

  test("softmax safety net", () => {
    const probs = new Float32Array([0.1, 0.6, 0.3]);
    expect(toProbabilities(probs)).toBe(probs); // already probabilities: untouched
    const fromLogits = toProbabilities(new Float32Array([-1, 2, 0]));
    expect(fromLogits.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(fromLogits[1]).toBeGreaterThan(fromLogits[2]);
  });

  test("every flashcard word has a Quick Draw doodle to show when it is skipped", () => {
    const doodles: Record<string, string[]> = JSON.parse(readFileSync(join(__dirname, "../public/doodles/quickdraw.json"), "utf8"));
    expect(Object.keys(doodles).sort()).toEqual(WORDS.map(w => w.labels[0]).sort()); // one each, no strays
    for (const [label, strokes] of Object.entries(doodles)) {
      expect(strokes.length, label).toBeGreaterThan(0);
      for (const d of strokes) {
        expect(d, label).toMatch(/^M\d+ \d+(L\d+ \d+)+$|^M\d+ \d+h0\.01$/); // a polyline, or a dot
        for (const n of d.match(/\d+/g)!.map(Number)) expect(n, label).toBeLessThanOrEqual(255); // inside the 0..255 box
      }
    }
  });

  test("guesses are pruned to the flashcard words, then re-normalised, then cut to the top k", () => {
    expect(BUILTIN_LABELS.filter(isWord)).toHaveLength(WORDS.length); // 214 words; the other 131 classes are never guessed
    const rank = createRanker(BUILTIN_LABELS);
    // a drawing the model mostly takes for things that are not flashcard words
    const probs = BUILTIN_LABELS.map(() => 0);
    const likely = { squiggle: 0.4, "The Eiffel Tower": 0.2, line: 0.15, zigzag: 0.1, snake: 0.06, river: 0.04, rain: 0.03, grass: 0.02 };
    for (const [label, p] of Object.entries(likely)) probs[BUILTIN_LABELS.indexOf(label)] = p;
    expect(rawTop(probs).map(g => g.label)).toEqual(["squiggle", "The Eiffel Tower", "line", "zigzag", "snake"]);

    // squiggle, The Eiffel Tower and zigzag are pruned before ranking; 0.30 of the mass survives and becomes 1
    const top = rank(probs);
    expect(top.map(g => g.label)).toEqual(["line", "snake", "river", "rain", "grass"]);
    [0.15, 0.06, 0.04, 0.03, 0.02].forEach((raw, i) => expect(top[i].prob).toBeCloseTo(raw / 0.3, 10));
    expect(total(top)).toBeCloseTo(1, 10);
    for (const g of top) expect(g.word, g.label).toBe(wordForLabel(g.label)); // each guess carries its dictionary entry
    expect(rank(probs, 2).map(g => g.label)).toEqual(["line", "snake"]);

    // the whole surviving distribution sums to 1, whatever share of the model's mass it had
    const uneven = BUILTIN_LABELS.map((_, i) => (i % 7) + 1);
    const all = rank(uneven, 345);
    expect(all).toHaveLength(WORDS.length);
    expect(total(all)).toBeCloseTo(1, 10);
    for (const g of all) expect(isWord(g.label), g.label).toBe(true);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].prob).toBeGreaterThanOrEqual(all[i].prob); // best first
    // the output index still means labels[i]: a class keeps its own score, divided by the surviving mass
    const mass = BUILTIN_LABELS.reduce((sum, l, i) => sum + (isWord(l) ? uneven[i] : 0), 0);
    for (const g of all) expect(g.prob).toBeCloseTo(uneven[BUILTIN_LABELS.indexOf(g.label)] / mass, 10);

    // no mass on any flashcard word (or a broken output): no guesses, rather than a division by zero
    expect(rank(BUILTIN_LABELS.map(l => (isWord(l) ? 0 : 1 / 131)))).toEqual([]);
    expect(rank(BUILTIN_LABELS.map(() => NaN))).toEqual([]);
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
    await expect(card).toHaveAttribute("data-lang", "es");
    // the language being learnt, then the word in it. Never the English.
    await expect(page.getByTestId("word-card-heading")).toHaveText("Español · Draw this");
    await expect(card).toHaveText("Español · Draw thisline");
    await expect(page.getByTestId("word-card-heading").locator("svg")).toBeVisible(); // the flag

    await play(page, "pinchDraw"); // a straight horizontal stroke
    await page.waitForFunction(() => window.__quickDraw.prediction.guesses.length === 5);
    expect(await page.evaluate(() => window.__quickDraw.prediction.guesses[0].label)).toBe("line");
    await expect(card).toHaveAttribute("data-solved", "true");
    await expect(page.getByTestId("word-card-heading")).toHaveText("Español · Correct!");
    await expect(page.getByRole("button", { name: /Skip/ })).toHaveCount(0); // nothing to skip once solved

    // next round: new word, clean canvas, guesses reset
    await expect(page.getByTestId("word")).toHaveText("zebra", { timeout: 5_000 });
    await expect(card).toHaveAttribute("data-solved", "false");
    expect(await page.evaluate(() => window.__airDraw.strokes.length)).toBe(0);
    expect(await page.evaluate(() => window.__quickDraw.prediction.guesses)).toEqual([]);

    // the same drawing is not a zebra: the word stays
    await play(page, "pinchDraw");
    await page.waitForFunction(() => window.__quickDraw.prediction.guesses.length === 5);
    await page.waitForTimeout(300);
    await expect(page.getByTestId("word")).toHaveText("zebra");
    await expect(card).toHaveAttribute("data-solved", "false");
    expect(await page.evaluate(() => window.__quickDraw.rounds)).toEqual(["line", "zebra"]);
    expect(errors).toEqual([]);
  });

  test("the round is won whenever the word is the top guess, however sure the model is", async ({ page }) => {
    await startGame(page, [testWord("camera", "camera"), testWord("zebra", "zebra")]);
    const card = page.getByTestId("word-card");

    await play(page, "circle");
    await page.waitForFunction(() => window.__quickDraw.prediction.guesses[0]?.label === "circle");
    await expect(card).toHaveAttribute("data-solved", "false"); // a circle alone is a "circle", not a camera

    // a rectangle over it: "camera" is now the top guess, but the model is only about a third sure
    // (pillow, belt, flashlight… share the rest)
    await play(page, "rect");
    const top = await (await page.waitForFunction(() => {
      const g = window.__quickDraw.prediction.guesses[0];
      return g?.label === "camera" ? g.prob : false;
    })).jsonValue() as number;
    expect(top).toBeGreaterThan(0.2);
    expect(top).toBeLessThan(0.5);
    await expect(page.getByTestId("guess-feed-item").first()).toHaveAttribute("data-label", "camera"); // ★ in the feed…
    await expect(card).toHaveAttribute("data-solved", "true"); // …so it is correct
    await expect(page.getByTestId("word-card-heading")).toHaveText("Español · Correct!");
    await expect(page.getByTestId("word")).toHaveText("zebra", { timeout: 5_000 });
    expect(await page.evaluate(() => window.__quickDraw.rounds)).toEqual(["camera", "zebra"]);
  });

  test("guesses follow the drawing: top 5 with percentages, cleared with the canvas, skip moves on", async ({ page }) => {
    // the first word is Spanish with a different English, so the reveal can be told apart from the word
    await startGame(page, [{ ...testWord("cat", "cat"), t: { ...testWord("cat").t, es: "el gato" } }, testWord("line", "line"), testWord("zebra", "zebra")]);
    await page.keyboard.press("d");
    const guesses = page.getByTestId("quickdraw-guesses").getByRole("listitem");
    await expect(guesses).toHaveText(["Draw something…"]);

    await play(page, "pinchDraw");
    await expect(guesses).toHaveCount(5);
    await expect(guesses.first()).toHaveText(/^1\. line\d+\.\d%$/);

    await page.keyboard.press("c"); // clear: no inference, guesses go away
    await expect(guesses).toHaveText(["Draw something…"]);
    await page.keyboard.press("z"); // undo the clear: judged again straight away
    await expect(guesses).toHaveCount(5);

    // skip: the card first says what the word means in English, then the next word comes up
    const card = page.getByTestId("word-card"), english = page.getByTestId("word-english");
    await expect(page.getByTestId("word")).toHaveText("el gato");
    await expect(english).toHaveCount(0); // not while the word is still to be drawn
    await page.getByRole("button", { name: /Skip/ }).click();
    await expect(card).toHaveAttribute("data-revealed", "true");
    await expect(page.getByTestId("word-card-heading")).toHaveText("Español · Skipped");
    await expect(page.getByTestId("word")).toHaveText("el gato");
    await expect(english).toHaveText("in English: cat");
    // …and a Quick Draw doodle of it is shown in the middle of the screen, clear of the card
    const doodle = page.getByTestId("skip-doodle");
    await expect(doodle).toBeVisible();
    await expect(doodle).toHaveAttribute("data-label", "cat");
    await expect(doodle.getByRole("img", { name: "A doodle of: cat" })).toBeVisible();
    expect(await doodle.locator("path").count()).toBeGreaterThan(0);
    const [box, cardBox, view] = [await doodle.boundingBox(), await card.boundingBox(), page.viewportSize()!];
    expect(Math.abs(box!.x + box!.width / 2 - view.width / 2)).toBeLessThan(20);
    expect(Math.abs(box!.y + box!.height / 2 - view.height / 2)).toBeLessThan(20);
    expect(box!.y).toBeGreaterThan(cardBox!.y + cardBox!.height);
    await expect(page.getByTestId("word")).toHaveText("line", { timeout: 5_000 }); // moves on by itself
    await expect(card).toHaveAttribute("data-revealed", "false");
    await expect(english).toHaveCount(0);
    await expect(doodle).toHaveCount(0);
    await expect(guesses).toHaveText(["Draw something…"]);
    expect(await page.evaluate(() => window.__airDraw.strokes.length)).toBe(0);

    // a skipped word can't be won any more, and skipping again (here: N) moves on straight away
    await page.keyboard.press("n");
    await expect(english).toHaveText("in English: line");
    await expect(page.getByTestId("skip-doodle")).toHaveAttribute("data-label", "line");
    await play(page, "pinchDraw"); // a line, drawn too late
    await expect(guesses.first()).toHaveText(/^1\. line/);
    await expect(card).toHaveAttribute("data-solved", "false");
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page.getByTestId("word")).toHaveText("zebra");
    await expect(english).toHaveCount(0);
    await expect(page.getByTestId("skip-doodle")).toHaveCount(0);
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

    await play(page, "pinchDraw");
    await page.waitForFunction(() => window.__quickDraw.prediction.guesses.length === 5);
    await page.getByRole("button", { name: "Back to languages" }).click();
    await expect(page.getByTestId("start-screen")).toBeVisible();
    expect(await page.evaluate(() => window.__quickDraw.prediction.guesses)).toEqual([]);

    // picking again deals the next word on a clean canvas, in the new language
    await langButton(page, /Polski/).click();
    await expect(card).toHaveAttribute("data-lang", "pl");
    await expect(page.getByTestId("word-card-heading")).toHaveText("Polski · Draw this");
    await expect(page.getByTestId("word")).toHaveText("cat");
    await expect(card).toHaveAttribute("data-solved", "false");
    expect(await page.evaluate(() => window.__airDraw.strokes.length)).toBe(0);
    expect(await page.evaluate(() => window.__quickDraw.rounds)).toEqual(["line", "zebra", "cat"]);
  });

  test("the live translated guess feed tracks the drawing and the chosen language", async ({ page }) => {
    await startGame(page); // picks Español
    const feed = page.getByTestId("guess-feed");
    const items = page.getByTestId("guess-feed-item");

    // bound to the selected language, with the empty placeholder before anything is drawn
    await expect(feed).toHaveAttribute("data-lang", "es");
    await expect(page.getByTestId("guess-feed-empty")).toBeVisible();
    await expect(items).toHaveCount(0);

    // draw a straight line: the feed fills from the model's live top guesses
    await play(page, "pinchDraw");
    await expect(items).toHaveCount(5);
    const shown = await items.evaluateAll(els => els.map(el => el.getAttribute("data-label")!));
    // only flashcard words are listed: the best five of them, re-normalised among the 214
    for (const label of shown) expect(isWord(label), label).toBe(true);
    const probs = await page.evaluate(() => window.__quickDraw.probabilities(Array.from(window.__quickDraw.prediction.input!)));
    const expected = createRanker(BUILTIN_LABELS)(probs);
    const guesses = await page.evaluate(() => window.__quickDraw.prediction.guesses.map(g => ({ label: g.label, prob: g.prob, word: g.word.id })));
    expect(shown).toEqual(expected.map(g => g.label));
    expect(guesses.map(g => g.label)).toEqual(shown); // the feed, the win check and the debug panel read one list
    guesses.forEach((g, i) => expect(g.prob).toBeCloseTo(expected[i].prob, 5));
    guesses.forEach(g => expect(g.word).toBe(wordForLabel(g.label)!.id));
    const kept = BUILTIN_LABELS.reduce((sum, l, i) => sum + (isWord(l) ? probs[i] : 0), 0);
    expect(kept).toBeLessThan(1); // some of the model's mass was on pruned classes…
    expect(guesses[0].prob).toBeCloseTo(probs[BUILTIN_LABELS.indexOf(guesses[0].label)] / kept, 5); // …and is divided out
    expect(total(guesses)).toBeLessThanOrEqual(1 + 1e-6);
    // every guess is rendered in the chosen language
    for (const [i, g] of expected.entries()) await expect(items.nth(i)).toContainText(g.word.t.es);
    const topLabel = guesses[0].label;
    const top = items.first();
    await expect(top).toHaveAttribute("data-rank", "1");
    await expect(top).toHaveAttribute("data-label", topLabel); // wired to real inference
    // the guess is shown in the chosen language, not as the raw (English) label
    expect(topLabel).toBe("line");
    await expect(top).toContainText(wordForLabel(topLabel)!.t.es);
    await expect(top).toContainText("la línea");

    // clear the canvas → back to the empty placeholder (no inference on an empty board)
    await page.keyboard.press("c");
    await expect(page.getByTestId("guess-feed-empty")).toBeVisible();
    await expect(items).toHaveCount(0);

    // a rectangle: two of the model's own top five ("keyboard", "postcard") are not flashcard words.
    // They are pruned before ranking, so nothing downstream ever sees them: not the feed, not the
    // debug panel. Five words are still listed.
    await play(page, "rect");
    await expect(items).toHaveCount(5);
    const rectProbs = await page.evaluate(() => window.__quickDraw.probabilities(Array.from(window.__quickDraw.prediction.input!)));
    expect(rawTop(rectProbs).map(g => g.label).filter(l => !isWord(l))).toEqual(["keyboard", "postcard"]);
    const listed = await items.evaluateAll(els => els.map(el => el.getAttribute("data-label")!));
    expect(listed).toEqual(createRanker(BUILTIN_LABELS)(rectProbs).map(g => g.label));
    expect(listed).toEqual(await page.evaluate(() => window.__quickDraw.prediction.guesses.map(g => g.label)));
    for (const label of listed) expect(isWord(label), label).toBe(true);
    for (const [i, label] of listed.entries()) await expect(items.nth(i)).toContainText(wordForLabel(label)!.t.es);
    await page.keyboard.press("d");
    const debug = page.getByTestId("quickdraw-guesses").getByRole("listitem");
    await expect(debug).toHaveCount(5);
    for (const [i, label] of listed.entries()) await expect(debug.nth(i)).toContainText(`${i + 1}. ${label}`);
    await expect(page.getByTestId("quickdraw-guesses")).not.toContainText("postcard");
    await expect(page.getByTestId("quickdraw-guesses")).not.toContainText("keyboard");
  });

  test("the guess feed never shows English: every guess is in the chosen language", async ({ page }) => {
    const warnings: string[] = [];
    page.on("console", m => { if (m.type() === "warning") warnings.push(m.text()); });
    await page.addInitScript(installMock);
    await page.addInitScript(d => { window.__gameDeck = d; }, [testWord("zebra", "zebra")]);
    // languages in another script: any Latin letter in the feed would be an English label leaking through
    for (const [button, code] of [[/日本語/, "ja"], [/తెలుగు/, "te"], [/Українська/, "uk"]] as const) {
      await page.goto("/");
      await langButton(page, button).click();
      await expect(page.getByTestId("start-screen")).toBeHidden();
      await page.waitForFunction(() => window.__quickDraw.status.state === "ready", null, { timeout: 30_000 });
      await page.waitForTimeout(DRAW_ARM_MS);
      const items = page.getByTestId("guess-feed-item");
      await expect(page.getByTestId("guess-feed")).toHaveAttribute("data-lang", code);
      for (const scene of ["pinchDraw", "rect", "circle"]) {
        await play(page, scene);
        await expect(items).toHaveCount(5);
        const labels = await items.evaluateAll(els => els.map(el => el.getAttribute("data-label")!));
        const texts = await items.evaluateAll(els => els.map(el => el.textContent ?? ""));
        for (const [i, label] of labels.entries()) {
          const word = wordForLabel(label);
          expect(word, label).toBeDefined(); // a flashcard word…
          expect(texts[i], `${code} ${scene} ${label}`).toContain(word!.t[code]); // …shown as its translation…
          expect(texts[i], `${code} ${scene} ${label}`).not.toMatch(/[A-Za-z]/); // …with no English in it
        }
      }
    }
    expect(warnings.filter(w => /translation for the word|no model class/.test(w))).toEqual([]); // no dev fallback warning fired
  });

  test("the hint box under the card gives a few letters of the word's English", async ({ page }) => {
    await startGame(page, [testWord("zebra", "zebra"), testWord("cat", "cat")]);
    const card = page.getByTestId("word-card"), hint = page.getByTestId("hint");

    // same width as the card, right below it, and shorter
    await expect(hint).toHaveText("Hint?");
    const c = (await card.boundingBox())!, h = (await hint.boundingBox())!;
    expect(Math.abs(h.width - c.width)).toBeLessThan(2);
    expect(h.height).toBeLessThan(c.height * 0.6);
    expect(h.y).toBeGreaterThan(c.y + c.height - 4);
    expect(h.y - (c.y + c.height)).toBeLessThan(20);

    // pressing it: 2 of the 5 letters, in place, the rest starred; it stays for the round
    await hint.click();
    await expect(hint).toHaveAttribute("data-shown", "true");
    const text = await page.getByTestId("hint-word").innerText();
    expect(text).toMatch(/^[zebra*]{5}$/);
    expect([...text].filter(ch => ch !== "*")).toHaveLength(2);
    [...text].forEach((ch, i) => expect(ch === "*" || ch === "zebra"[i]).toBe(true));
    expect(Math.abs((await hint.boundingBox())!.width - c.width)).toBeLessThan(2);

    // skipping shows the English itself, so the hint goes; the next word starts with a fresh "Hint?"
    await page.getByRole("button", { name: /Skip/ }).click();
    await expect(page.getByTestId("word-english")).toBeVisible();
    await expect(hint).toHaveCount(0);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect(page.getByTestId("word")).toHaveText("cat");
    await expect(hint).toHaveText("Hint?");
  });
});
