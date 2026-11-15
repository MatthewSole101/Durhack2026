// MediaPipe Hand Landmarker in a Web Worker (see hand-tracker.ts).
// On the GPU delegate every detectForVideo ends in a synchronous gl.readPixels that waits for
// the GPU; on the main thread that wait ate ~65% of the page's time (and the first inference's
// shader compile froze the page for 0.5–9 s). Here it only blocks this worker.

import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import type { ToTracker, FromTracker } from "./hand-tracker";

declare function importScripts(...urls: string[]): void; // tsconfig has the DOM lib, not WebWorker

let landmarker: HandLandmarker | null = null;
const post = (m: FromTracker) => (self as unknown as Worker).postMessage(m);

async function init(wasmBase: string, modelUrl: string, numHands: number) {
  // The bundler may start this as a classic worker (chunks loaded with importScripts) or as a
  // module worker, where importScripts throws. Pick the wasm loader build that can be loaded.
  let classic = true;
  try { importScripts(); } catch { classic = false; }
  const fileset = await FilesetResolver.forVisionTasks(wasmBase, !classic);
  const opts = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: modelUrl, delegate },
    canvas: new OffscreenCanvas(1, 1),
    runningMode: "VIDEO" as const, numHands,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let delegate: "GPU" | "CPU" = "GPU";
  try { landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU")); }
  catch { delegate = "CPU"; landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU")); }
  // first inference compiles the GPU shaders (seconds on a cold shader cache): do it before "ready"
  const blank = new OffscreenCanvas(64, 64);
  blank.getContext("2d")!.fillRect(0, 0, 64, 64);
  try { landmarker.detectForVideo(blank, 0); } catch { /* best-effort */ }
  post({ type: "ready", delegate });
}

// one message at a time: a frame must not run while setOptions rebuilds the graph
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<ToTracker>) => { queue = queue.then(() => handle(data)); };

async function handle(m: ToTracker) {
  try {
    if (m.type === "init") await init(m.wasmBase, m.modelUrl, m.numHands);
    else if (m.type === "numHands") await landmarker?.setOptions({ numHands: m.numHands });
    else if (m.type === "frame") {
      try {
        const r = landmarker!.detectForVideo(m.frame, m.t);
        post({ type: "result", t: m.t, landmarks: r.landmarks });
      } finally {
        m.frame.close();
      }
    }
  } catch (e) {
    post({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
}
