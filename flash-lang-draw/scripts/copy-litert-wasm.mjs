// Self-host the LiteRT.js WebAssembly runtime: copy it from node_modules into public/wasm so it
// is served with the app (no CDN, works offline). Runs before `dev` and `build`, and on install.
//
// Only the default and the compat (no relaxed SIMD) builds are copied; the loader picks between
// them. The threads / JSPI builds are not used and are left out on purpose.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "node_modules", "@litertjs", "core", "wasm");
const to = join(root, "public", "wasm");

const FILES = [
  "litert_wasm_internal.js",
  "litert_wasm_internal.wasm",
  "litert_wasm_compat_internal.js",
  "litert_wasm_compat_internal.wasm",
];

if (!existsSync(from)) {
  console.error(`copy-litert-wasm: ${from} not found — run \`npm install\` first.`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });
let copied = 0;
for (const name of FILES) {
  const src = join(from, name), dst = join(to, name);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size && statSync(dst).mtimeMs >= statSync(src).mtimeMs) continue;
  copyFileSync(src, dst);
  copied++;
}
if (copied) console.log(`copy-litert-wasm: copied ${copied} file(s) to public/wasm`);
