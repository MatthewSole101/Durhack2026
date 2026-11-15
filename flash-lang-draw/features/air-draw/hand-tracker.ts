// Hand tracking off the main thread.
//
// MediaPipe's GPU delegate finishes every detectForVideo with a synchronous gl.readPixels that
// waits for the GPU. Measured on an Intel Iris Xe laptop, start screen, no hand in view: that wait
// was ~65% of all main-thread time (the main thread was ~98% busy, ~35 fps), and the first
// inference's shader compile froze the page for 0.5 s (warm shader cache) to 9 s (cold). So the
// landmarker runs in a worker: each new camera frame is sent there as a VideoFrame and the result
// comes back a few ms later; the page itself only renders. Same machine, hand in view: 60 fps and
// ~25% main-thread busy, vs 15–25 fps and ~99% busy on the main thread.
//
// Falls back to running on the main thread (the old behaviour) when workers can't do it, and
// for the e2e mock landmarker, which is synchronous and lives on window.

import type { HandLandmarker, HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { withWasmLoadLock } from "@/features/wasm-load-lock";
import { MODEL_URL, WASM_BASE } from "./constants";

type Vision = Pick<typeof import("@mediapipe/tasks-vision"), "FilesetResolver" | "HandLandmarker">;

export type HandFrame = { result: HandLandmarkerResult; /** capture time of the frame (performance.now()) */ t: number };

export type HandTracker = {
  /**
   * Call every animation frame. Never blocks: sends the current video frame off for detection
   * when the tracker is idle and the video has a new frame, and returns the newest result that
   * hasn't been returned yet (null if there is none). Throws if detection failed.
   */
  poll: (video: HTMLVideoElement, now: number) => HandFrame | null;
  /** 1 on the start screen, 2 while drawing: with fewer hands in view than this, the palm detector
   * runs on every frame (with one hand up, numHands 2 costs ~41 ms a frame vs ~18 ms). */
  setNumHands: (n: number) => void;
  /** "GPU" / "CPU", and whether it runs in a worker (for the debug panel / logs) */
  backend: string;
};

/** Pairs of landmark indices to join when drawing the hand skeleton (same as HandLandmarker.HAND_CONNECTIONS). */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
].map(([start, end]) => ({ start, end }));

// worker protocol
export type ToTracker =
  | { type: "init"; wasmBase: string; modelUrl: string; numHands: number }
  | { type: "numHands"; numHands: number }
  | { type: "frame"; frame: VideoFrame | ImageBitmap; t: number };
export type FromTracker =
  | { type: "ready"; delegate: "GPU" | "CPU" }
  | { type: "result"; t: number; landmarks: HandLandmarkerResult["landmarks"] }
  | { type: "error"; message: string };

const INITIAL_HANDS = 1; // the page opens on the start screen

const toResult = (landmarks: HandLandmarkerResult["landmarks"]): HandLandmarkerResult =>
  ({ landmarks, worldLandmarks: [], handedness: [], handednesses: [] }) as unknown as HandLandmarkerResult;

function workerTracker(): Promise<HandTracker> {
  const worker = new Worker(new URL("./hand-tracker.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    let busy = false, lastVideoTime = -1;
    let video: HTMLVideoElement | null = null; // the source poll() was last given
    let latest: HandFrame | null = null;
    let failure: Error | null = null;
    let ready = false;

    const fail = (msg: string) => {
      if (!ready) { worker.terminate(); reject(new Error(msg)); }
      else { failure = new Error(msg); busy = false; }
    };
    worker.onerror = e => { e.preventDefault(); fail(e.message || "hand tracking worker crashed"); };
    worker.onmessage = ({ data: m }: MessageEvent<FromTracker>) => {
      if (m.type === "ready") {
        ready = true;
        resolve({ poll, setNumHands, backend: `${m.delegate} (worker)` });
      } else if (m.type === "result") {
        busy = false;
        latest = { result: toResult(m.landmarks), t: m.t };
        trySend(); // keep the worker fed: don't leave it idle until the next animation frame
      } else fail(m.message);
    };

    function trySend() {
      if (busy || !video || video.readyState < 2 || video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      busy = true;
      void send(video, performance.now()); // timestamps must increase on every frame sent
    }

    async function send(video: HTMLVideoElement, t: number) {
      try {
        const frame = typeof VideoFrame === "function" ? new VideoFrame(video, { timestamp: Math.round(t * 1000) }) : await createImageBitmap(video);
        worker.postMessage({ type: "frame", frame, t } satisfies ToTracker, [frame]);
      } catch (e) {
        busy = false; // e.g. the video had no frame yet: try again next time
        if (!(e instanceof DOMException)) failure = e instanceof Error ? e : new Error(String(e));
      }
    }

    function poll(v: HTMLVideoElement): HandFrame | null {
      if (failure) { const e = failure; failure = null; throw e; }
      video = v;
      trySend();
      const r = latest;
      latest = null;
      return r;
    }

    function setNumHands(numHands: number) {
      worker.postMessage({ type: "numHands", numHands } satisfies ToTracker);
    }

    worker.postMessage({ type: "init", wasmBase: WASM_BASE, modelUrl: MODEL_URL, numHands: INITIAL_HANDS } satisfies ToTracker);
  });
}

async function mainThreadTracker(mock?: Vision): Promise<HandTracker> {
  const vision: Vision = mock ?? (await import("@mediapipe/tasks-vision"));
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
  const opts = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO" as const, numHands: INITIAL_HANDS,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let landmarker: HandLandmarker, delegate = "GPU";
  // creating it bootstraps the wasm runtime through Emscripten globals: not while LiteRT is loading
  const create = (d: "GPU" | "CPU") =>
    mock ? vision.HandLandmarker.createFromOptions(fileset, opts(d)) : withWasmLoadLock(() => vision.HandLandmarker.createFromOptions(fileset, opts(d)));
  try { landmarker = await create("GPU"); }
  catch { delegate = "CPU"; landmarker = await create("CPU"); }
  // The first inference compiles shaders and blocks the page; pay it here, under "Loading…".
  try {
    const blank = document.createElement("canvas");
    blank.width = blank.height = 64;
    blank.getContext("2d")!.fillRect(0, 0, 64, 64);
    landmarker.detectForVideo(blank, performance.now());
  } catch { /* warm-up is best-effort */ }

  let lastVideoTime = -1;
  return {
    backend: mock ? "mock" : `${delegate} (main thread)`,
    poll(video, now) {
      if (video.readyState < 2 || video.currentTime === lastVideoTime) return null;
      lastVideoTime = video.currentTime;
      return { result: landmarker.detectForVideo(video, now), t: now };
    },
    setNumHands(numHands) { void landmarker.setOptions?.({ numHands }); },
  };
}

// One tracker per page, shared across mounts: the model is heavy, and React StrictMode mounts
// effects twice in dev — building (and tearing down) a second GL graph stalls the first.
let shared: Promise<HandTracker> | null = null;

/** Load the hand tracker (worker if possible). `mock` (e2e builds only) forces the main-thread path. */
export function loadHandTracker(mock?: Vision): Promise<HandTracker> {
  shared ??= (async () => {
    if (!mock && typeof Worker === "function" && typeof OffscreenCanvas === "function") {
      try { return await workerTracker(); }
      catch (e) { console.warn("Hand tracking worker unavailable, using the main thread:", e); }
    }
    return mainThreadTracker(mock);
  })();
  shared.catch(() => { shared = null; }); // allow a retry after a failed load
  return shared;
}
