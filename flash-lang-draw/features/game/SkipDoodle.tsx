"use client";

// The picture shown in the middle of the screen when a word is skipped: a real doodle of it from
// Google's Quick, Draw! dataset (CC BY 4.0), so the learner sees what the word means and what
// they could have drawn. One doodle per flashcard word, keyed by its Quick Draw class.
//
// public/doodles/quickdraw.json is self-hosted like the model: { label: [SVG path per stroke] },
// in the dataset's 0..255 coordinate space, each drawing centred in that box.

import { useEffect, useState } from "react";
import type { Word } from "@/features/languages/words";

export const DOODLES_URL = "/doodles/quickdraw.json";
const DRAW_IN_S = 1.1; // the whole doodle draws itself in over this long, stroke by stroke
const MAX_STROKE_S = 0.3;

type Doodles = Record<string, readonly string[]>;
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

/** A Quick Draw doodle of the word, drawn in on a paper card. Renders nothing if there is none. */
export function SkipDoodle({ word }: { word: Word }) {
  const [all, setAll] = useState<Doodles | null>(null);
  useEffect(() => {
    let alive = true;
    loadDoodles().then(d => { if (alive) setAll(d); }, e => console.error(e)); // no picture, the English still shows
    return () => { alive = false; };
  }, []);

  const label = word.labels.find(l => all?.[l]);
  const strokes = label ? all![label] : null;
  if (!strokes) return null;
  const step = Math.min(MAX_STROKE_S, DRAW_IN_S / strokes.length);

  return (
    <div className="pointer-events-none fixed inset-0 z-10 flex items-center justify-center">
      <div
        data-testid="skip-doodle"
        data-label={label}
        className="lt-skip-doodle rotate-[1.5deg] rounded-3xl border-[3px] border-[#1d1b16] bg-[#fffdf5] p-4 shadow-[5px_6px_0_rgba(0,0,0,0.45)]"
      >
        <svg
          viewBox="-10 -10 275 275"
          role="img"
          aria-label={`A doodle of: ${word.en}`}
          fill="none"
          stroke="#1d1b16"
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="block h-[min(42vh,62vw,340px)] w-[min(42vh,62vw,340px)]"
        >
          {strokes.map((d, i) => (
            <path key={i} d={d} pathLength={1} style={{ animationDuration: `${step}s`, animationDelay: `${0.15 + i * step}s` }} />
          ))}
        </svg>
      </div>
    </div>
  );
}
