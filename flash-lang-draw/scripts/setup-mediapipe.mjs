// Serves the MediaPipe runtime and hand model from our own origin (public/mediapipe/) instead of
// two CDNs: the browser can fetch them in parallel, start early via <link rel="preload">, and
// they come straight off localhost in dev. Runs on `npm install`, `npm run dev` and `npm run build`.
// If anything here fails the app still works — engine.ts falls back to the CDNs.

import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "mediapipe");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const size = p => stat(p).then(s => s.size, () => -1);

async function copyRuntime() {
  const src = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
  await mkdir(join(out, "wasm"), { recursive: true });
  for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm"]) {
    const from = join(src, f), to = join(out, "wasm", f);
    if ((await size(from)) !== (await size(to))) await copyFile(from, to); // re-copy after a package update
  }
}

async function downloadModel() {
  const to = join(out, "hand_landmarker.task");
  if ((await size(to)) > 0) return;
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await mkdir(out, { recursive: true });
  await writeFile(to, Buffer.from(await res.arrayBuffer()));
  console.log("mediapipe: downloaded hand model");
}

for (const [what, job] of [["runtime", copyRuntime], ["model", downloadModel]]) {
  try { await job(); }
  catch (e) { console.warn(`mediapipe: couldn't set up the local ${what} (${e.message}); the app will use the CDN`); }
}
