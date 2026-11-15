"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Flag } from "@/features/languages/Flag";
import { LANGUAGES, type LangCode, languageByCode } from "@/features/languages/languages";
import FloatingDoodles from "./FloatingDoodles";
import PaperTear from "./PaperTear";
import TitleLogo from "./TitleLogo";

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
  const mainRef = useRef<HTMLElement>(null);
  const [camLive, setCamLive] = useState(false);
  const [camGaveUp, setCamGaveUp] = useState(false);
  /** the opening paper has been torn away (or was already, on a later visit) */
  const [revealed, setRevealed] = useState(false);
  const reveal = useCallback(() => setRevealed(true), []);
  /** the intro text has finished writing itself in */
  const [introDone, setIntroDone] = useState(false);
  const langTag = lang && languageByCode(lang).tag;

  // rip the paper off once the camera is showing, or after a while if it never comes
  useEffect(() => {
    const t = setTimeout(() => setCamGaveUp(true), 3500);
    return () => clearTimeout(t);
  }, []);

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
      {/* backdrop: fallback gradient, then the mirrored camera feed on top */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,#3b2a6b_0%,transparent_55%),radial-gradient(ellipse_at_75%_80%,#0f4c55_0%,transparent_55%)]" />
      <video
        ref={videoRef}
        playsInline
        muted
        aria-hidden
        className={`absolute inset-0 h-full w-full -scale-x-100 object-cover ${camLive ? "opacity-100" : "opacity-0"}`}
      />
      {/* tint + vignette so the doodles and title read over any room */}
      <div className="absolute inset-0 bg-[#140f2a]/45 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgba(10,6,24,0.75)_100%)]" />

      {/* first visit: the backdrop starts under a sheet of paper that gets torn away */}
      <PaperTear go={camLive || camGaveUp} onDone={reveal} />

      {/* drift around the empty parts of the screen, never behind the content in <main> */}
      <FloatingDoodles avoid={mainRef} dimExcept={langTag} />

      <main ref={mainRef} className="relative z-10 flex h-full flex-col items-center justify-center gap-5 px-4 text-center">
        <TitleLogo revealed={revealed} />

        <div className="flex flex-col items-center gap-2">
          {/* picking a language starts straight away. On wide screens it's a tidy 3-column block
              (a lone last button is centred) */}
          <div role="group" aria-label="I want to learn" className="flex max-w-[1120px] flex-wrap justify-center gap-2.5 lg:grid lg:grid-cols-3 lg:[&>:last-child:nth-child(3n+1)]:col-start-2">
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
                  className={`font-toon inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border-[3px] border-[#1d1b16] px-3.5 py-2 text-base font-semibold text-[#1d1b16] transition-[translate,background-color,box-shadow,opacity] duration-150 hover:-translate-y-0.5 hover:bg-[#fff3c4] disabled:cursor-default disabled:opacity-55 disabled:hover:translate-y-0 data-[hand-hover]:-translate-y-1 data-[hand-hover]:bg-[#fff3c4] ${
                    last
                      ? "bg-[#ffd166]"
                      : "bg-[#fffdf5]/90"
                  }`}
                >
                  <Flag code={l.code} width={24} height={16} />
                  {l.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* the white handwriting writes itself in once the paper is gone */}
        <p className="font-hand mt-1 text-lg text-[#fffdf5]/90 drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
          <span className={`lt-write inline-block ${revealed ? "lt-write-go" : ""}`} style={{ animationDelay: "0.5s" }}>
            {modelReady
              ? "Pick a language to start. No mouse needed: hold your fingertip over one."
              : "Loading hand tracking…"}
          </span>
        </p>

        <figure className="mt-3 text-[#fffdf5] drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]">
          <blockquote
            className={`lt-write font-hand text-balance text-[clamp(1.15rem,2.6vw,1.7rem)] leading-snug md:whitespace-nowrap ${revealed ? "lt-write-go" : ""}`}
            style={{ animationDelay: "1s", animationDuration: "1.6s" }}
          >
            “Drawing is the first language of the human being before writing.”
          </blockquote>
          <figcaption
            className={`lt-write font-hand mt-0.5 text-lg text-[#fffdf5]/75 ${revealed ? "lt-write-go" : ""}`}
            style={{ animationDelay: "2.5s", animationDuration: "0.7s" }}
            onAnimationEnd={() => setIntroDone(true)}
          >
            — Marjane Satrapi
          </figcaption>
        </figure>

        {/* writes itself in after the quote; a later message (e.g. a failed retry) writes in straight away */}
        <div role="status" className="font-hand min-h-5 max-w-[560px] rounded-md text-base text-[#ffb86b] drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
          {status && (
            <span
              key={status}
              className={`lt-write inline-block ${revealed ? "lt-write-go" : ""}`}
              style={{ animationDelay: introDone ? "0s" : "3.2s", animationDuration: "1.2s" }}
            >
              {status}
            </span>
          )}
        </div>
      </main>
    </div>
  );
}
