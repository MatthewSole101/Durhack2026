// 🫰 Finger-snap sound detection, entirely in the browser: the microphone feeds an AudioWorklet
// running createSnapDetector below. No audio is recorded, stored or sent anywhere.
//
// A snap is a sharp click: a burst of high-frequency energy that appears within a few
// milliseconds, well above the room's background, and is gone again within ~0.1 s. So the
// detector high-passes the signal (snaps are loud at 2–5 kHz; voices, thumps and hum mostly are
// not), then looks for exactly that shape. Sustained hiss ("sss"), speech and music are too slow
// to start or too long; low thumps are filtered out. Claps, knocks and clicks can still pass,
// which is why the engine only acts on a snap sound when it also sees a hand set up for a snap.

/** Onset times (seconds, on the caller's clock) of snap-like transients in a mono signal, fed block by block. */
export type SnapDetector = { process: (block: Float32Array, startTime: number) => number[] };

// Self-contained on purpose (no outer references): its source is also run inside the worklet.
export function createSnapDetector(sampleRate: number): SnapDetector {
  const HIGHPASS_HZ = 1500;
  const FRAME_S = 0.0025; // analyse 2.5 ms of audio at a time
  const MIN_ENERGY = 3e-5; // mean square after the high-pass (≈ −45 dBFS): quieter is ignored
  const ABOVE_FLOOR = 15; // ≈ 12 dB above the background…
  const ABOVE_RECENT = 6; // …and ≈ 8 dB above the last 10 ms: it has to *start* suddenly
  const DECAY = 8; // must fall 9 dB below its peak…
  const MAX_S = 0.12; // …within this long, or it's a sustained sound, not a snap
  const REFRACTORY_S = 0.15;

  // 2nd-order high-pass biquad (RBJ audio EQ cookbook)
  const w = (2 * Math.PI * HIGHPASS_HZ) / sampleRate, cw = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cw) / 2 / a0, b1 = -(1 + cw) / a0, b2 = b0, a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  const hop = Math.max(1, Math.round(sampleRate * FRAME_S));
  let acc = 0, n = 0;
  let floor = 1e-7; // background energy, tracked slowly
  const recent: number[] = [];
  let event: { start: number; peak: number } | null = null;
  let quietUntil = 0;

  function frame(e: number, time: number, out: number[]) {
    if (event) {
      event.peak = Math.max(event.peak, e);
      if (e < event.peak / DECAY) { out.push(event.start); event = null; quietUntil = time + REFRACTORY_S; }
      else if (time - event.start > MAX_S) { event = null; quietUntil = time + REFRACTORY_S; } // too long
    } else {
      const prev = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : e;
      if (time >= quietUntil && e > MIN_ENERGY && e > floor * ABOVE_FLOOR && e > prev * ABOVE_RECENT) {
        event = { start: time - FRAME_S, peak: e };
      } else {
        floor += (e - floor) * (e > floor ? 0.002 : 0.05); // rises over ~1 s, falls over ~50 ms
      }
    }
    recent.push(e);
    if (recent.length > 4) recent.shift();
  }

  return {
    process(block, startTime) {
      const out: number[] = [];
      for (let i = 0; i < block.length; i++) {
        const x = block[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        acc += y * y;
        if (++n === hop) { frame(acc / hop, startTime + (i + 1) / sampleRate, out); acc = 0; n = 0; }
      }
      return out;
    },
  };
}

const WORKLET_SOURCE = `
const createSnapDetector = ${createSnapDetector.toString()};
registerProcessor("snap-detector", class extends AudioWorkletProcessor {
  constructor() { super(); this.detector = createSnapDetector(sampleRate); }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) for (const t of this.detector.process(channel, currentTime)) this.port.postMessage(t);
    return true;
  }
});`;

/**
 * "on": listening · "starting": asking for the microphone · "click": the browser wants a click or
 * key press before audio can run · "off": no microphone (denied, missing or unsupported).
 */
export type MicState = "on" | "starting" | "click" | "off";

export type SnapListener = { stop: () => void };

/** Listen for snaps on the microphone. onSnap gets each snap's time on the performance.now() clock. */
export function listenForSnaps(onSnap: (t: number) => void, onState: (s: MicState) => void): SnapListener {
  let stopped = false, ctx: AudioContext | null = null, stream: MediaStream | null = null;
  const unlock = () => { void ctx?.resume(); };

  (async () => {
    onState("starting");
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") { onState("off"); return; }
    // the browser's voice processing would treat a snap as noise and remove it
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
    ctx = new AudioContext({ latencyHint: "interactive" });
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    if (stopped) return;
    const node = new AudioWorkletNode(ctx, "snap-detector", { numberOfOutputs: 1 });
    const mute = ctx.createGain();
    mute.gain.value = 0; // the worklet only runs when connected to the output; send it nowhere audible
    ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
    node.port.onmessage = ({ data: t }: MessageEvent<number>) => {
      onSnap(performance.now() - Math.max(0, ctx!.currentTime - t) * 1000); // audio clock → page clock
    };
    const report = () => { if (!stopped) onState(ctx!.state === "running" ? "on" : "click"); };
    ctx.onstatechange = report;
    // Without a real click or key press on the page (hand-pressed buttons don't count), the browser
    // may keep audio suspended; resume on the next one.
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    await ctx.resume().catch(() => {});
    report();
  })().catch(e => {
    console.warn("Snap detection: microphone unavailable", e);
    if (!stopped) onState("off");
  });

  return {
    stop() {
      stopped = true;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      stream?.getTracks().forEach(t => t.stop());
      void ctx?.close();
    },
  };
}
