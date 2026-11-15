"use client";

import { useEffect, useState } from "react";

// Opening reveal: the start screen's backdrop begins covered by a sheet of lined paper, which is
// ripped in two (along a jagged tear) and flung off to show the camera feed behind it.
// It plays once per page load; coming back to the start screen after a round skips it.

let tornThisLoad = false;

// the ragged tear, as x,y % pairs from the top edge to the bottom edge: a lazy wander plus
// small seeded jitter (deterministic, so server and client render the same edge)
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const TEAR: [number, number][] = Array.from({ length: 61 }, (_, i) => {
  const x = 50 + 4 * Math.sin(i * 0.31) + 1.6 * Math.sin(i * 1.3) + (rand() - 0.5) * 2.2;
  return [Math.round(x * 100) / 100, Math.round((i * 100 / 60) * 100) / 100];
});

/** polygon for one half; `dx` nudges the tear sideways (for the white torn fibres under the edge) */
function half(side: "left" | "right", dx = 0) {
  const edge = TEAR.map(([x, y]) => `${x + dx}% ${y}%`).join(", ");
  const x = side === "left" ? 0 : 100;
  return `polygon(${x}% 0%, ${edge}, ${x}% 100%)`;
}

const PAPER = {
  backgroundColor: "#f6efdf",
  backgroundImage: [
    // red margin line
    "linear-gradient(to right, transparent 72px, rgba(225,85,85,0.5) 72px, rgba(225,85,85,0.5) 74px, transparent 74px)",
    // blue ruled lines
    "repeating-linear-gradient(to bottom, transparent 0 33px, rgba(70,120,200,0.28) 33px 35px)",
    // a little uneven lighting
    "radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.6), transparent 60%)",
  ].join(", "),
};

/**
 * `go` starts the rip; the paper unmounts itself once the halves have flown off and calls
 * `onDone` (straight away if it was already torn earlier in this page load).
 */
export default function PaperTear({ go, onDone }: { go: boolean; onDone: () => void }) {
  const [gone, setGone] = useState(tornThisLoad);

  useEffect(() => {
    if (gone) onDone();
  }, [gone, onDone]);

  useEffect(() => {
    if (!go || gone) return;
    tornThisLoad = true;
    const t = setTimeout(() => setGone(true), 1400);
    return () => clearTimeout(t);
  }, [go, gone]);

  if (gone) return null;
  return (
    <div aria-hidden data-testid="paper-tear" className={`lt-paper pointer-events-none absolute inset-0 ${go ? "lt-paper-go" : ""}`}>
      <div className="lt-paper-half lt-paper-left absolute inset-0">
        <div className="absolute inset-0 bg-[#fffdf8]" style={{ clipPath: half("left", 0.7) }} />
        <div className="absolute inset-0" style={{ ...PAPER, clipPath: half("left") }} />
      </div>
      <div className="lt-paper-half lt-paper-right absolute inset-0">
        <div className="absolute inset-0 bg-[#fffdf8]" style={{ clipPath: half("right", -0.7) }} />
        <div className="absolute inset-0" style={{ ...PAPER, clipPath: half("right") }} />
      </div>
    </div>
  );
}
