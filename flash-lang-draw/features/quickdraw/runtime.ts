// LiteRT.js runtime: one WebAssembly (CPU) instance per page.
// loadLiteRt() throws if called twice, so the promise is shared by every caller and mount.
//
// Emscripten runtimes on the main thread must not bootstrap at the same time (shared
// self.Module / self.ModuleFactory globals), so this runs under withWasmLoadLock. MediaPipe's hand
// tracker normally loads in its own worker, so in practice the two load side by side.

import { withWasmLoadLock } from "@/features/wasm-load-lock";
import { WASM_DIR } from "./constants";

export type LiteRtCore = typeof import("@litertjs/core");

let runtime: Promise<LiteRtCore> | null = null;

// The runtime's C++ side writes its log to stderr, which Emscripten sends to console.error —
// routine "INFO: …" lines included, and Next's dev overlay reports every one of them as an
// error. Keep real errors where they are and move the chatter to console.debug.
const ROUTINE = /^(VERBOSE|INFO|WARNING): /;
function log(...args: unknown[]) {
  (typeof args[0] === "string" && ROUTINE.test(args[0]) ? console.debug : console.error)(...args);
}

export function loadRuntime(): Promise<LiteRtCore> {
  runtime ??= (async () => {
    const core = await import("@litertjs/core"); // browser-only: keep it out of the server render
    await withWasmLoadLock(async () => {
      // Emscripten reads `self.Module` when the runtime is instantiated (the loader clears it again).
      (self as { Module?: unknown }).Module = { printErr: log };
      // Absolute URL of the self-hosted wasm directory. The loader picks the relaxed-SIMD or the
      // compat build by itself; the threads / JSPI builds are deliberately not shipped or requested.
      await core.loadLiteRt(new URL(WASM_DIR, window.location.origin).href);
    });
    return core;
  })();
  runtime.catch(() => { runtime = null; }); // allow a retry after a failed load
  return runtime;
}
