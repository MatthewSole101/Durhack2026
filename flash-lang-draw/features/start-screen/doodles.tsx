// Hand-drawn style doodles for the start screen. Each one is a flashcard prompt:
// a sketch + the word for it in a language you might be learning.
// All paths use pathLength={1} so CSS can "draw them in" with stroke-dashoffset.

import type { CSSProperties, ReactNode } from "react";

export type Doodle = {
  id: string;
  word: string;
  lang: string; // short language tag shown on the card
  color: string;
  /**
   * position + motion; left/top are % of the viewport. On wide screens (lg+) the doodles live in
   * the side margins beside the centred content; below that, mLeft/mTop (default: left/top) put
   * them in the empty bands above and below it.
   */
  left: number;
  top: number;
  mLeft?: number;
  mTop?: number;
  size: number; // px
  rotate: number; // deg, resting tilt
  delay: number; // s, draw-in delay
  float: number; // s, float loop duration
  /** only shown on wide (lg+) screens, where the side margins have room */
  wideOnly?: boolean;
  paths: ReactNode;
};

const P = (d: string) => <path d={d} pathLength={1} />;
const C = (cx: number, cy: number, r: number) => <circle cx={cx} cy={cy} r={r} pathLength={1} />;

export const DOODLES: Doodle[] = [
  {
    id: "sun", word: "el sol", lang: "ES", color: "#ffd166",
    left: 7, top: 13, mLeft: 15, mTop: 7, size: 104, rotate: -8, delay: 0.1, float: 7,
    paths: <>
      {C(50, 50, 18)}
      {P("M50 18 L50 8 M50 82 L50 92 M18 50 L8 50 M82 50 L92 50 M27 27 L20 20 M73 73 L80 80 M73 27 L80 20 M27 73 L20 80")}
      {P("M43 47 Q44 45 45 47 M55 47 Q56 45 57 47 M42 56 Q50 63 58 56")}
    </>,
  },
  {
    id: "cat", word: "кошка", lang: "RU", color: "#f78fb3",
    left: 94, top: 12, mLeft: 57, mTop: 7, size: 100, rotate: 7, delay: 0.35, float: 8,
    paths: <>
      {P("M22 40 L26 14 L42 30 Q50 27 58 30 L74 14 L78 40 Q84 72 50 80 Q16 72 22 40 Z")}
      {P("M38 48 Q40 44 42 48 M58 48 Q60 44 62 48")}
      {P("M47 58 L53 58 L50 62 Z M50 62 Q46 68 42 65 M50 62 Q54 68 58 65")}
      {P("M36 60 L14 56 M36 64 L14 66 M64 60 L86 56 M64 64 L86 66")}
    </>,
  },
  {
    id: "house", word: "dom", lang: "PL", color: "#7bdff2",
    left: 8, top: 65, mLeft: 20, mTop: 89, size: 110, rotate: 5, delay: 0.6, float: 9,
    paths: <>
      {P("M18 48 L50 18 L82 48")}
      {P("M26 42 L26 84 L74 84 L74 42")}
      {P("M43 84 L43 64 L57 64 L57 84")}
      {P("M32 52 L40 52 L40 60 L32 60 Z M60 52 L68 52 L68 60 L60 60 Z")}
      {P("M64 30 L64 20 L70 20 L70 36")}
    </>,
  },
  {
    id: "apple", word: "apel", lang: "ID", color: "#ff6b6b",
    left: 91, top: 62, mLeft: 80, mTop: 89, size: 96, rotate: -6, delay: 0.85, float: 7.5,
    paths: <>
      {P("M50 32 Q34 20 22 36 Q12 58 30 78 Q40 88 50 80 Q60 88 70 78 Q88 58 78 36 Q66 20 50 32 Z")}
      {P("M50 32 Q50 20 54 12")}
      {P("M53 22 Q64 12 72 18 Q62 26 53 22 Z")}
      {P("M30 46 Q32 40 37 38")}
    </>,
  },
  {
    id: "fish", word: "さかな", lang: "JA", color: "#4fd1c5",
    left: 7, top: 87, size: 92, rotate: 4, delay: 1.1, float: 8.5, wideOnly: true,
    paths: <>
      {P("M14 50 Q36 22 64 40 L84 26 L80 50 L84 74 L64 60 Q36 78 14 50 Z")}
      {C(30, 46, 2.5)}
      {P("M44 40 Q50 50 44 60")}
    </>,
  },
  {
    id: "star", word: "la estrella", lang: "ES", color: "#ffe66d",
    left: 91, top: 87, size: 84, rotate: -10, delay: 1.3, float: 6.5, wideOnly: true,
    paths: <>
      {P("M50 12 L60 38 L88 40 L66 58 L74 86 L50 70 L26 86 L34 58 L12 40 L40 38 Z")}
    </>,
  },
  {
    id: "tree", word: "చెట్టు", lang: "TE", color: "#95e06c",
    left: 8, top: 36, size: 86, rotate: 6, delay: 1.5, float: 9.5, wideOnly: true,
    paths: <>
      {P("M50 90 L50 58 M44 90 L56 90")}
      {P("M50 60 Q24 64 26 44 Q16 30 32 24 Q36 8 52 14 Q68 6 72 24 Q88 30 78 46 Q78 64 50 60 Z")}
    </>,
  },
  {
    id: "heart", word: "ìfẹ́", lang: "YO", color: "#ff8fab",
    left: 90, top: 37, size: 76, rotate: -4, delay: 1.7, float: 7, wideOnly: true,
    paths: <>
      {P("M50 82 Q14 58 18 36 Q22 18 40 22 Q48 24 50 34 Q52 24 60 22 Q78 18 82 36 Q86 58 50 82 Z")}
    </>,
  },
];

export function DoodleCard({ d, dim = false }: { d: Doodle; dim?: boolean }) {
  return (
    <div
      aria-hidden
      className={`lt-doodle pointer-events-none absolute top-(--my) left-(--mx) flex-col items-center transition-opacity duration-500 lg:top-(--y) lg:left-(--x) ${d.wideOnly ? "hidden lg:flex" : "flex"}`}
      style={{
        opacity: dim ? 0.3 : 1,
        "--x": `clamp(56px, ${d.left}%, calc(100% - 56px))`,
        "--y": `${d.top}%`,
        "--mx": `clamp(56px, ${d.mLeft ?? d.left}%, calc(100% - 56px))`,
        "--my": `${d.mTop ?? d.top}%`,
        "--rot": `${d.rotate}deg`,
        "--delay": `${d.delay}s`,
        "--float": `${d.float}s`,
      } as CSSProperties}
    >
      <svg
        viewBox="0 0 100 100"
        width={d.size}
        height={d.size}
        fill="none"
        stroke={d.color}
        strokeWidth={4}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="lt-doodle-svg"
      >
        {d.paths}
      </svg>
      <span className="lt-doodle-label font-hand -mt-1 flex whitespace-nowrap items-center gap-1.5 rounded-md bg-[#fffdf5] px-2.5 py-0.5 text-lg leading-tight text-[#1d1b16] shadow-[2px_3px_0_rgba(0,0,0,0.35)]">
        {d.word}
        <span className="rounded px-1 text-[10px] font-bold tracking-wider text-white" style={{ background: d.color }}>
          {d.lang}
        </span>
      </span>
    </div>
  );
}
