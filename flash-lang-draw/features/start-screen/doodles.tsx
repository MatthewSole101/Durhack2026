// Hand-drawn doodles for the start screen. Each one is a flashcard prompt: a drawing + the word
// for it in a language you might be learning.
// The images are public/start-screen-doodles/web/*.webp, cropped and shrunk from the full-page
// originals beside them by scripts/build-start-doodles.mjs (which also prints their sizes and
// line colours, used for `w`/`h` and `color` below).

import type { CSSProperties } from "react";

export type Doodle = {
  id: string; // the image's file name
  w: number; // the image's size in px (for its aspect ratio)
  h: number;
  word: string;
  lang: string; // short language tag shown on the card
  color: string; // the drawing's line colour, for the tag
  // where each one goes is worked out on screen: see FloatingDoodles.tsx
  size: number; // px, the longer side
  rotate: number; // deg, resting tilt
  delay: number; // s, draw-in delay
  float: number; // s, sway loop duration
  /** only used on wide (lg+) screens; smaller ones have room for a few at most */
  wideOnly?: boolean;
};

export const DOODLES: Doodle[] = [
  {
    id: "sun", w: 320, h: 254, word: "el sol", lang: "ES", color: "#ec8700",
    size: 104, rotate: -8, delay: 0.1, float: 7,
  },
  {
    id: "fire", w: 261, h: 320, word: "iná", lang: "YO", color: "#ec5230",
    size: 88, rotate: 6, delay: 1.1, float: 9.5, wideOnly: true,
  },
  {
    id: "rabbit", w: 254, h: 320, word: "kelinci", lang: "ID", color: "#ecac00",
    size: 100, rotate: 5, delay: 0.6, float: 9,
  },
  {
    id: "chicken", w: 320, h: 298, word: "にわとり", lang: "JA", color: "#ec8700",
    size: 96, rotate: 4, delay: 1.5, float: 8.5, wideOnly: true,
  },
  {
    id: "bingus", w: 320, h: 288, word: "кіт", lang: "UA", color: "#f98ea3",
    size: 100, rotate: 7, delay: 0.35, float: 8,
  },
  {
    id: "frog", w: 320, h: 274, word: "жаба", lang: "UA", color: "#39a238",
    size: 92, rotate: -4, delay: 1.3, float: 7, wideOnly: true,
  },
  {
    id: "kitten", w: 229, h: 320, word: "kotek", lang: "PL", color: "#9852c8",
    size: 92, rotate: -6, delay: 1.7, float: 7.5, wideOnly: true,
  },
  {
    id: "whale", w: 320, h: 242, word: "くじら", lang: "JA", color: "#00caec",
    size: 104, rotate: -6, delay: 0.85, float: 7.5,
  },
  {
    id: "tupperware", w: 320, h: 271, word: "el táper", lang: "ES", color: "#3068ec",
    size: 88, rotate: -10, delay: 1.9, float: 6.5, wideOnly: true,
  },
];

export function DoodleCard({ d, dim = false }: { d: Doodle; dim?: boolean }) {
  const scale = d.size / Math.max(d.w, d.h);
  return (
    <div
      aria-hidden
      className="lt-doodle pointer-events-none flex flex-col items-center transition-opacity duration-500"
      style={{
        opacity: dim ? 0.3 : 1,
        "--rot": `${d.rotate}deg`,
        "--delay": `${d.delay}s`,
        "--float": `${d.float}s`,
      } as CSSProperties}
    >
      {/* already cropped and sized by the build script, so a plain <img> rather than next/image */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/start-screen-doodles/web/${d.id}.webp`}
        alt=""
        width={Math.round(d.w * scale)}
        height={Math.round(d.h * scale)}
        draggable={false}
        className="lt-doodle-img"
      />
      <span className="lt-doodle-label font-hand mt-1.5 flex whitespace-nowrap items-center gap-1.5 rounded-md bg-[#fffdf5] px-2.5 py-0.5 text-lg leading-tight text-[#1d1b16]">
        {d.word}
        <span className="rounded px-1 text-[10px] font-bold tracking-wider text-white" style={{ background: d.color }}>
          {d.lang}
        </span>
      </span>
    </div>
  );
}
