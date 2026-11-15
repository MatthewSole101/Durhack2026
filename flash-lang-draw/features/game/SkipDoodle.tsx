"use client";

// The pictures shown under the word card when a word is skipped: a few real doodles of it from
// Google's Quick, Draw! dataset (CC BY 4.0), so the learner sees what the word means and a few
// ways they could have drawn it. Keyed by the word's Quick Draw class.
//
// public/doodles/quickdraw.json is self-hosted like the model (built by scripts/build-doodles.mjs):
// { label: [drawing, …] }, each drawing a list of SVG paths (one per stroke) in the dataset's
// 0..255 coordinate space, centred in that box.

import { useEffect, useState } from "react";
import type { Word } from "@/features/languages/words";

export const DOODLES_URL = "/doodles/quickdraw.json";
const DRAW_IN_S = 1.1; // each doodle draws itself in over this long, stroke by stroke
const MAX_STROKE_S = 0.3;
const STAGGER_S = 0.35; // the doodles start one after another, left to right

type Doodles = Record<string, readonly (readonly string[])[]>;
let doodles: Promise<Doodles> | null = null;

/** Fetch the doodles once per page (call early so they are ready by the first skip). */
export function loadDoodles(): Promise<Doodles> {
  doodles ??= fetch(DOODLES_URL).then(res => {
    if (!res.ok) throw new Error(`Could not load ${DOODLES_URL} (HTTP ${res.status})`);
    return res.json() as Promise<Doodles>;
  });
  doodles.catch(() => { doodles = null; }); // allow a retry after a failed load
  return doodles;
}

/**
 * Quick Draw doodles of the word, drawn in on paper cards in a row. Meant to sit under the word
 * card (see WordCard's children). Renders nothing if there are none.
 */
export function SkipDoodle({ word }: { word: Word }) {
  const [all, setAll] = useState<Doodles | null>(null);
  useEffect(() => {
    let alive = true;
    loadDoodles().then(d => { if (alive) setAll(d); }, e => console.error(e)); // no pictures, the English still shows
    return () => { alive = false; };
  }, []);

  const label = word.labels.find(l => all?.[l]?.length);
  const drawings = label ? all![label] : null;
  if (!drawings) return null;

  return (
    <div
      data-testid="skip-doodle"
      data-label={label}
      role="group"
      aria-label={`Doodles of: ${word.en}`}
      className="mt-16 flex max-w-full flex-wrap justify-center gap-x-[clamp(1rem,5vw,4rem)] gap-y-4 px-4"
    >
      {drawings.map((strokes, n) => (
        <Doodle
          key={n}
          strokes={strokes}
          delay={n * STAGGER_S}
          tilt={n % 2 ? -1.5 : 1.5}
          name={`Doodle ${n + 1} of ${drawings.length}`}
        />
      ))}
    </div>
  );
}

function Doodle({ strokes, delay, tilt, name }: { strokes: readonly string[]; delay: number; tilt: number; name: string }) {
  const step = Math.min(MAX_STROKE_S, DRAW_IN_S / strokes.length);
  return (
    <div
      className="lt-skip-doodle rounded-3xl border-[3px] border-[#1d1b16] bg-[#fffdf5] p-3"
      style={{ rotate: `${tilt}deg`, animationDelay: `${delay}s` }}
    >
      <svg
        viewBox="-10 -10 275 275"
        role="img"
        aria-label={name}
        fill="none"
        stroke="#1d1b16"
        strokeWidth={7}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="block h-[min(24vh,24vw,200px)] w-[min(24vh,24vw,200px)]"
      >
        {strokes.map((d, i) => (
          <path key={i} d={d} pathLength={1} style={{ animationDuration: `${step}s`, animationDelay: `${0.15 + delay + i * step}s` }} />
        ))}
      </svg>
    </div>
  );
}
