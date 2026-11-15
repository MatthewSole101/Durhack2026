import { expect, test } from "@playwright/test";
import { createSnapDetector } from "../features/air-draw/snap-audio";

// The snap-sound detector on synthetic audio (runs in Node, no browser needed).

const SR = 48000;
let seed = 1;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; }; // repeatable noise

/** `seconds` of audio: background noise plus whatever `add(t)` contributes at time t. */
function signal(seconds: number, add: (t: number) => number, noise = 0.002) {
  seed = 1;
  return Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => noise * rand() + add(i / SR));
}
// a snap: a broadband click that dies away within a few tens of milliseconds
const snapAt = (t0: number, amp = 0.5) => (t: number) => (t >= t0 && t < t0 + 0.06 ? amp * rand() * Math.exp(-(t - t0) / 0.006) : 0);

/** Run the detector the way the AudioWorklet does: 128-sample blocks. */
function onsets(audio: Float32Array, make = createSnapDetector) {
  const d = make(SR), out: number[] = [];
  for (let i = 0; i < audio.length; i += 128) out.push(...d.process(audio.subarray(i, i + 128), i / SR));
  return out;
}

test.describe("snap sound detector", () => {
  test("finds each snap, at the right time, loud or quiet", () => {
    const a = snapAt(0.5), b = snapAt(1.2, 0.05); // the second one ≈ 20 dB quieter (further from the mic)
    const found = onsets(signal(1.6, t => a(t) + b(t)));
    expect(found).toHaveLength(2);
    expect(Math.abs(found[0] - 0.5)).toBeLessThan(0.01);
    expect(Math.abs(found[1] - 1.2)).toBeLessThan(0.01);
  });

  test("still hears a snap over steady background noise", () => {
    expect(onsets(signal(1.2, snapAt(0.8), 0.02))).toHaveLength(1);
  });

  test("ignores sustained hiss, low thumps and speech-like sound", () => {
    // "sssss": loud high-frequency noise fading in over 30 ms and lasting 0.4 s
    const hiss = (t: number) => (t > 0.3 && t < 0.7 ? 0.15 * Math.min((t - 0.3) / 0.03, 1) * rand() : 0);
    expect(onsets(signal(1, hiss))).toEqual([]);
    // a door closing / a footstep: a loud, low (100 Hz) boom, removed by the high-pass. (A hard
    // knock also has a sharp click in it and can pass; the engine still needs to see a snap.)
    const boom = (t: number) => (t > 0.4 ? 0.8 * Math.min((t - 0.4) / 0.005, 1) * Math.sin(2 * Math.PI * 100 * t) * Math.exp(-(t - 0.4) / 0.03) : 0);
    expect(onsets(signal(1, boom))).toEqual([]);
    // syllables: noise swelling and fading five times a second
    const speech = (t: number) => 0.1 * Math.sin(Math.PI * 5 * t) ** 2 * rand();
    expect(onsets(signal(1.5, speech))).toEqual([]);
  });

  test("is self-contained, so its source can run inside the AudioWorklet", () => {
    const make = new Function(`return (${createSnapDetector.toString()})`)() as typeof createSnapDetector;
    expect(onsets(signal(1, snapAt(0.5)), make)).toHaveLength(1);
  });
});
