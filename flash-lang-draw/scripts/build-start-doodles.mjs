// Builds the start screen's doodle images from the hand-drawn originals in
// public/start-screen-doodles/*.png (full A4 pages with a lot of empty paper around each drawing):
// each is cropped to the drawing, shrunk, and saved as a small WebP in public/start-screen-doodles/web/.
// It also prints each drawing's line colour, for the language tag on its label (see doodles.tsx).
//
//   node scripts/build-start-doodles.mjs

import { mkdirSync, readdirSync } from "node:fs";
import { join, parse } from "node:path";
import sharp from "sharp";

const SRC = join(import.meta.dirname, "../public/start-screen-doodles");
const OUT = join(SRC, "web");
const MAX_PX = 320; // longest side; shown at up to ~120 CSS px, so this covers high-DPI screens
const PAD = 0.04; // breathing room around the drawing, as a fraction of its longest side

mkdirSync(OUT, { recursive: true });

for (const file of readdirSync(SRC).filter(f => f.endsWith(".png"))) {
  const name = parse(file).name;
  // white paper → transparent, so the doodle sits straight on the start screen
  const { data, info } = await sharp(join(SRC, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lightness = Math.min(data[i], data[i + 1], data[i + 2]);
    if (lightness > 235) { data[i + 3] = 0; continue; } // paper
    if (data[i + 3] > 200 && lightness < 200) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; } // solid line
  }
  const trimmed = await sharp(data, { raw: info }).trim().png().toBuffer();
  // sharp resizes before it extends, so shrink to leave room for the padding, then add it
  const pad = Math.round(MAX_PX * PAD), inner = MAX_PX - 2 * pad;
  await sharp(trimmed)
    .resize(inner, inner, { fit: "inside" })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90, alphaQuality: 90 })
    .toFile(join(OUT, `${name}.webp`));
  const hex = "#" + [r, g, b].map(v => Math.round(v / Math.max(n, 1)).toString(16).padStart(2, "0")).join("");
  const meta = await sharp(join(OUT, `${name}.webp`)).metadata();
  console.log(`${name}: ${meta.width}x${meta.height} ${hex}`);
}
