"use client";

import { useEffect, useRef, useState } from "react";
import { Flag } from "@/features/languages/Flag";
import { LANGUAGES, type LangCode, languageByCode } from "@/features/languages/languages";
import { DOODLES, DoodleCard } from "./doodles";

const TITLE = "Langotoon";
const LETTER_COLORS = ["#ffd166", "#ff6b6b", "#4fd1c5", "#f78fb3", "#7bdff2", "#95e06c"];

type Props = {
  /** the drawing engine's camera stream; null until the camera is on */
  stream: MediaStream | null;
  modelReady: boolean;
  /** a language was picked and the drawing page is opening */
  busy: boolean;
  status: string;
  /** language of the previous round (highlighted), or null on first visit */
  lang: LangCode | null;
  onPick: (lang: LangCode) => void;
};

/**
 * Landing screen. Shows the live, mirrored camera feed as the backdrop (the same stream the
 * engine tracks, so the hand cursor lines up with it) with floating doodle flashcards over it.
 * Falls back to a gradient if the camera is unavailable.
 *
 * Elements marked `data-hand-target` can be pressed by holding a fingertip over them (see HandCursor).
 */
export default function StartScreen({ stream, modelReady, busy, status, lang, onPick }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camLive, setCamLive] = useState(false);
  const langTag = lang && languageByCode(lang).tag;

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    let alive = true;
    v.srcObject = stream;
    v.play().then(() => { if (alive) setCamLive(true); }, () => { /* gradient fallback stays */ });
    return () => { alive = false; v.srcObject = null; }; // the engine owns (and stops) the stream
  }, [stream]);

  return (
    <div data-testid="start-screen" className="fixed inset-0 overflow-hidden bg-[#141022]">
      {/* backdrop: fallback gradient, then the mirrored camera feed fading in on top */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,#3b2a6b_0%,transparent_55%),radial-gradient(ellipse_at_75%_80%,#0f4c55_0%,transparent_55%)]" />
      <video
        ref={videoRef}
        playsInline
        muted
        aria-hidden
        className={`absolute inset-0 h-full w-full -scale-x-100 object-cover transition-opacity duration-1000 ${camLive ? "opacity-100" : "opacity-0"}`}
      />
      {/* tint + vignette so the doodles and title read over any room */}
      <div className="absolute inset-0 bg-[#140f2a]/45 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(10,6,24,0.75)_100%)]" />

      {DOODLES.map(d => <DoodleCard key={d.id} d={d} dim={!!langTag && d.lang !== langTag} />)}

      <main className="relative z-10 flex h-full flex-col items-center justify-center gap-5 px-4 text-center">
        <h1 aria-label={TITLE} className="font-toon lt-title flex select-none text-[clamp(3.2rem,13vw,8.5rem)] font-bold leading-none">
          {TITLE.split("").map((ch, i) => (
            <span
              key={i}
              aria-hidden
              className="lt-letter inline-block"
              style={{
                color: LETTER_COLORS[i % LETTER_COLORS.length],
                ["--i" as string]: i,
                ["--tilt" as string]: `${i % 2 ? 4 : -4}deg`,
              }}
            >
              {ch}
            </span>
          ))}
        </h1>

        {/* scribbled underline */}
        <svg viewBox="0 0 400 24" className="-mt-4 w-[min(420px,70vw)]" fill="none" aria-hidden>
          <path
            className="lt-scribble"
            pathLength={1}
            d="M6 14 Q60 4 120 13 T240 12 T394 10"
            stroke="#fffdf5"
            strokeWidth={5}
            strokeLinecap="round"
          />
        </svg>

        <figure className="text-[#fffdf5] drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
          <blockquote className="font-hand text-balance text-[clamp(1.15rem,2.6vw,1.7rem)] leading-snug md:whitespace-nowrap">
            “Drawing is the first language of the human being before writing.”
          </blockquote>
          <figcaption className="font-hand mt-0.5 text-lg text-[#fffdf5]/75">— Marjane Satrapi</figcaption>
        </figure>

        <div className="mt-3 flex flex-col items-center gap-2">
          <span id="lang-label" className="font-hand text-xl text-[#fffdf5] drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
            I want to learn…
          </span>
          {/* picking a language starts straight away */}
          <div role="group" aria-labelledby="lang-label" className="flex max-w-[1120px] flex-wrap justify-center gap-2.5">
            {LANGUAGES.map((l, i) => {
              const last = l.code === lang; // the language from the previous round, if any
              return (
                <button
                  key={l.code}
                  type="button"
                  aria-label={`${l.name} (${l.english})`}
                  data-hand-target
                  data-hand-flag={l.code}
                  disabled={!modelReady || busy}
                  onClick={() => onPick(l.code)}
                  style={{ rotate: `${i % 2 ? 1.5 : -1.5}deg` }}
                  className={`font-toon inline-flex cursor-pointer items-center gap-2 rounded-xl border-[3px] border-[#1d1b16] px-3.5 py-2 text-lg font-semibold text-[#1d1b16] transition-[translate,background-color,box-shadow,opacity] duration-150 hover:-translate-y-0.5 hover:bg-[#fff3c4] disabled:cursor-default disabled:opacity-55 disabled:hover:translate-y-0 data-[hand-hover]:-translate-y-1 data-[hand-hover]:bg-[#fff3c4] ${
                    last
                      ? "bg-[#ffd166] shadow-[4px_5px_0_#1d1b16]"
                      : "bg-[#fffdf5]/90 shadow-[2px_3px_0_rgba(0,0,0,0.45)]"
                  }`}
                >
                  <Flag code={l.code} width={24} height={16} />
                  {l.name}
                </button>
              );
            })}
          </div>
        </div>

        <p className="font-hand mt-1 text-lg text-[#fffdf5]/90 drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
          {modelReady
            ? "Pick a language to start. No mouse needed: hold your fingertip over one"
            : "Loading hand tracking…"}
        </p>

        <div role="status" className="min-h-5 max-w-[560px] rounded-md text-sm text-[#ffb86b] drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
          {status}
        </div>
      </main>
    </div>
  );
}
