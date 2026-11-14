// Strokes → model input. The drawing is re-rendered from its vector strokes (never read back
// from the visible canvas): white on black, centred, 256 → 64 → 28, R channel / 255.

import {
  CENTER, INPUT_SIZE, INVERT, LINE_WIDTH, MID_SIZE, MIN_SPAN, PADDING, RENDER_SIZE,
} from "./constants";

/** Points in any uniformly scaled unit (the pad's 0..1 space); only their relative layout matters. */
export type Point = readonly [number, number];
export type Strokes = readonly (readonly Point[])[];

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function context(size: number, readback = false): Ctx {
  const opts = readback ? { willReadFrequently: true } : undefined;
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(size, size).getContext("2d", opts) as OffscreenCanvasRenderingContext2D;
  }
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c.getContext("2d", opts) as CanvasRenderingContext2D;
}

export type Preprocessor = {
  /** Row-major 28×28 input (stroke = 1, background = 0), or null when there is nothing drawn. */
  toInput: (strokes: Strokes) => Float32Array | null;
};

export function createPreprocessor(): Preprocessor {
  const big = context(RENDER_SIZE), mid = context(MID_SIZE), small = context(INPUT_SIZE, true);

  function toInput(strokes: Strokes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) for (const [x, y] of s) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    if (minX === Infinity) return null;

    const span = Math.max(maxX - minX, maxY - minY, MIN_SPAN);
    const box = RENDER_SIZE - 2 * PADDING, k = box / span;
    let ox = PADDING - minX * k, oy = PADDING - minY * k;
    if (CENTER) { ox += (box - (maxX - minX) * k) / 2; oy += (box - (maxY - minY) * k) / 2; }

    big.fillStyle = "#000"; big.fillRect(0, 0, RENDER_SIZE, RENDER_SIZE);
    big.strokeStyle = "#fff"; big.lineWidth = LINE_WIDTH; big.lineCap = "round"; big.lineJoin = "round";
    for (const s of strokes) {
      if (!s.length) continue;
      big.beginPath();
      s.forEach(([x, y], i) => (i ? big.lineTo(x * k + ox, y * k + oy) : big.moveTo(x * k + ox, y * k + oy)));
      if (s.length === 1) big.lineTo(s[0][0] * k + ox + 0.1, s[0][1] * k + oy); // a lone point shows up as a dot
      big.stroke();
    }

    mid.imageSmoothingEnabled = true; mid.imageSmoothingQuality = "high";
    mid.drawImage(big.canvas, 0, 0, MID_SIZE, MID_SIZE);
    small.imageSmoothingEnabled = true; small.imageSmoothingQuality = "high";
    small.drawImage(mid.canvas, 0, 0, INPUT_SIZE, INPUT_SIZE);

    const data = small.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    const out = new Float32Array(INPUT_SIZE * INPUT_SIZE);
    for (let i = 0; i < out.length; i++) { const v = data[i * 4] / 255; out[i] = INVERT ? 1 - v : v; }
    return out;
  }

  return { toInput };
}
