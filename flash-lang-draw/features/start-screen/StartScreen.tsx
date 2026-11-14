"use client";

import { useEffect, useRef, useState } from "react";
import { DOODLES, DoodleCard } from "./doodles";

const TITLE = "Langotoon";
const LETTER_COLORS = ["#ffd166", "#ff6b6b", "#4fd1c5", "#f78fb3", "#7bdff2", "#95e06c"];

type Props = {
  modelReady: boolean;
  starting: boolean;
  status: string;
  onStart: () => void;
};

/**
 * Landing screen. Shows a live, mirrored camera preview as the backdrop
 * (its own stream, independent of the drawing engine) with floating doodle
 * flashcards over it. Falls back to a gradient if the camera is unavailable.
 */
export default function StartScreen({ modelReady, starting, status, onStart }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [camLive, setCamLive] = useState(false);

  useEffect(() => {
    let alive = true;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then(async s => {
        if (!alive) { s.getTracks().forEach(t => t.stop()); return; }
        stream = s;
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = s;
        await v.play().catch(() => {});
        if (alive) setCamLive(true);
      })
      .catch(() => { /* no preview: gradient fallback stays */ });
    return () => {
      alive = false;
      stream?.getTracks().forEach(t => t.stop());
    };
  }, []);

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

      {DOODLES.map(d => <DoodleCard key={d.id} d={d} />)}

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

        <p className="font-hand text-[clamp(1.25rem,3.4vw,1.9rem)] leading-snug text-[#fffdf5] drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
          See the word. Draw it in the air. Remember it.
        </p>

        <ul className="font-hand mt-1 flex flex-wrap justify-center gap-3 text-[#1d1b16]">
          <Hint emoji="☝️" title="Draw" tilt={-3}>point your index finger, other fingers curled</Hint>
          <Hint emoji="🤏" title="Undo" tilt={2}>pinch twice quickly</Hint>
          <Hint emoji="👋" title="Clear" tilt={-1.5}>flick an open hand across</Hint>
        </ul>

        <button
          type="button"
          onClick={onStart}
          disabled={!modelReady || starting}
          className="font-toon mt-3 cursor-pointer rounded-2xl border-[3px] border-[#1d1b16] bg-[#4fd1c5] px-8 py-3.5 text-xl font-bold text-[#06201d] shadow-[5px_6px_0_#1d1b16] transition-transform hover:-translate-y-0.5 hover:rotate-[-1deg] active:translate-x-[3px] active:translate-y-[4px] active:shadow-[2px_2px_0_#1d1b16] disabled:cursor-default disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:rotate-0"
        >
          <span className="inline-flex items-center gap-2">
            {modelReady && (
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 20l1-5L16 4l4 4L9 19z M14 6l4 4" />
              </svg>
            )}
            {modelReady ? "Start camera" : "Loading model…"}
          </span>
        </button>

        <div role="status" className="min-h-5 max-w-[560px] rounded-md text-sm text-[#ffb86b] drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
          {status}
        </div>
      </main>
    </div>
  );
}

function Hint({ emoji, title, tilt, children }: { emoji: string; title: string; tilt: number; children: React.ReactNode }) {
  return (
    <li
      className="flex max-w-[210px] items-start gap-2 rounded-lg bg-[#fffdf5] px-3 py-2 text-left text-[1.05rem] leading-tight shadow-[3px_4px_0_rgba(0,0,0,0.35)]"
      style={{ transform: `rotate(${tilt}deg)` }}
    >
      <span className="text-2xl leading-none" aria-hidden>{emoji}</span>
      <span><b className="font-toon text-sm">{title}</b><br />{children}</span>
    </li>
  );
}
