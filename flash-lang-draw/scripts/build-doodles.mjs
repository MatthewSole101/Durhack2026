// Builds public/doodles/quickdraw.json: a few sample doodles per flashcard word, shown when a word
// is skipped. Source: Google's Quick, Draw! dataset (CC BY 4.0), "simplified" drawings, which are
// already scaled into a 0..255 box. Only the start of each class file is downloaded (HTTP Range).
//
//   node scripts/build-doodles.mjs
//
// Output: { label: [drawing, …] }, each drawing a list of SVG path strings (one per stroke),
// centred in the 0..255 box. The labels are the file's existing keys (one per flashcard word); the
// drawing already listed first for a label is kept, and the rest are filled in from the dataset.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "../public/doodles/quickdraw.json");
const PER_LABEL = 3;
const RANGE_BYTES = 256 * 1024;
const MAX_STROKES = 12;
const MAX_POINTS = 140;
const url = label => `https://storage.googleapis.com/quickdraw_dataset/full/simplified/${encodeURIComponent(label)}.ndjson`;

/** strokes as [[xs], [ys]] → path strings, with the drawing centred in the 0..255 box */
function toPaths(drawing) {
  const xs = drawing.flatMap(s => s[0]), ys = drawing.flatMap(s => s[1]);
  const dx = Math.round((255 - Math.max(...xs) - Math.min(...xs)) / 2);
  const dy = Math.round((255 - Math.max(...ys) - Math.min(...ys)) / 2);
  return drawing.map(([sx, sy]) => {
    const pts = sx.map((x, i) => `${x + dx} ${sy[i] + dy}`);
    return pts.length === 1 ? `M${pts[0]}h0.01` : `M${pts[0]}L${pts.slice(1).join("L")}`;
  });
}

async function samples(label, want, skip) {
  const res = await fetch(url(label), { headers: { Range: `bytes=0-${RANGE_BYTES - 1}` } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const lines = (await res.text()).split("\n").slice(0, -1); // the last line is cut off by the range
  const picked = [];
  for (const line of lines) {
    const { recognized, drawing } = JSON.parse(line);
    const points = drawing.reduce((n, s) => n + s[0].length, 0);
    if (!recognized || drawing.length > MAX_STROKES || points > MAX_POINTS) continue;
    const paths = toPaths(drawing);
    if (skip.has(paths.join())) continue;
    picked.push(paths);
    if (picked.length === want) break;
  }
  if (picked.length < want) throw new Error(`${label}: only ${picked.length} of ${want} usable drawings in the first ${RANGE_BYTES} bytes`);
  return picked;
}

const current = JSON.parse(readFileSync(OUT, "utf8"));
const out = {};
for (const [label, value] of Object.entries(current)) {
  // older files held a single drawing per label (a list of path strings)
  const drawings = typeof value[0] === "string" ? [value] : value;
  const keep = drawings.slice(0, 1);
  out[label] = [...keep, ...(await samples(label, PER_LABEL - keep.length, new Set(keep.map(d => d.join())))) ];
  process.stdout.write(".");
}
writeFileSync(OUT, JSON.stringify(out));
console.log(`\nwrote ${Object.keys(out).length} labels × ${PER_LABEL} doodles to ${OUT}`);
