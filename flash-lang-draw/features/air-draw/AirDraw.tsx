"use client";

import { useEffect, useRef, useState } from "react";
import { preload } from "react-dom";
import { LOCAL_MODEL_URL, LOCAL_WASM_BASE, TOAST_MS } from "./constants";
import { createAirDraw, type AirDrawEngine } from "./engine";
import GestureHints from "./GestureHints";
import HandCursor, { type HandCursorHandle } from "@/features/hand-cursor/HandCursor";
import { Flag } from "@/features/languages/Flag";
import { type LangCode, languageByCode } from "@/features/languages/languages";
import { randomWord, type Word } from "@/features/languages/words";
import StartScreen from "@/features/start-screen/StartScreen";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cameraError = (e: unknown) =>
  `Camera unavailable: ${message(e)} — open this page via http://localhost or https.`;

type Card = { lang: LangCode; word: Word };

export default function AirDraw() {
  // Start downloading the hand-tracking runtime and model from the HTML <head>, before any JS runs.
  // The options match how they're fetched later (engine.ts / MediaPipe's loader) so the browser reuses them.
  preload(`${LOCAL_WASM_BASE}/vision_wasm_internal.js`, { as: "script", crossOrigin: "anonymous" });
  preload(`${LOCAL_WASM_BASE}/vision_wasm_internal.wasm`, { as: "fetch", crossOrigin: "anonymous" });
  preload(LOCAL_MODEL_URL, { as: "fetch", crossOrigin: "anonymous" });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AirDrawEngine | null>(null);
  const cursorRef = useRef<HandCursorHandle>(null);

  const [modelReady, setModelReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState(""); // start-screen error line
  const [error, setError] = useState(""); // red banner while drawing
  const [toast, setToast] = useState({ msg: "", show: false });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [lastLang, setLastLang] = useState<LangCode | null>(null);
  const [card, setCard] = useState<Card | null>(null); // set = on the drawing page

  useEffect(() => {
    let alive = true;
    let toastTimer: ReturnType<typeof setTimeout>;
    const engine = createAirDraw({
      video: videoRef.current!,
      canvas: canvasRef.current!,
      onToast: msg => {
        setToast({ msg, show: true });
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => setToast(t => ({ ...t, show: false })), TOAST_MS);
      },
      onError: msg => { console.error(msg); setError(msg); },
      onPointer: p => cursorRef.current?.update(p),
    });
    engineRef.current = engine;
    engine.load().then(
      () => { if (alive) setModelReady(true); },
      e => { if (alive) setStatus("Failed to load model: " + message(e)); },
    );
    // camera on straight away: it's the start screen's backdrop, and the hand cursor needs it
    engine.start().then(
      s => { if (alive) setStream(s); },
      e => { if (alive) setStatus(cameraError(e)); },
    );
    return () => {
      alive = false;
      clearTimeout(toastTimer);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  // Esc → back to the language list
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") back(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card]);

  async function pick(lang: LangCode) {
    const engine = engineRef.current;
    if (!engine || card || starting) return;
    setLastLang(lang);
    setStarting(true);
    try {
      setStream(await engine.start()); // no-op if the camera is already on; retries if it failed
      setStatus("");
      engine.setMode("draw");
      setCard({ lang, word: randomWord() }); // only once the video is actually playing
    } catch (e) {
      setStatus(cameraError(e));
    } finally {
      setStarting(false);
    }
  }

  function back() {
    engineRef.current?.setMode("menu");
    setCard(null);
    setError("");
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-black font-sans text-sm text-[#f2f4f8]">
      {/* Frame source. Not display:none — some browsers stop decoding hidden video. */}
      <video ref={videoRef} playsInline muted className="pointer-events-none fixed left-0 top-0 h-[2px] w-[2px] opacity-0" />
      <canvas ref={canvasRef} className="fixed inset-0 block h-screen w-screen" />

      {/* brief gesture feedback ("↩ Undo", "✨ Cleared", "🎨 Coral") */}
      <div
        role="status"
        data-testid="toast"
        className={`pointer-events-none fixed left-1/2 top-44 z-10 -translate-x-1/2 rounded-full border border-[#4fd1c5]/50 bg-[#0f1115]/60 px-4 py-2 font-semibold tracking-wide backdrop-blur-md transition duration-200 ${
          toast.show ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0"
        }`}
      >
        {toast.msg}
      </div>

      {error && (
        <div role="alert" data-testid="error-banner" className="fixed bottom-5 left-1/2 max-w-[min(560px,calc(100vw-40px))] -translate-x-1/2 rounded-[10px] bg-[#7b2d26] px-3.5 py-2.5 text-[13px] text-white">
          {error}
        </div>
      )}

      {card ? (
        <>
          <button
            type="button"
            onClick={back}
            data-hand-target
            aria-label="Back to languages"
            className="font-toon fixed left-4 top-4 z-10 cursor-pointer rounded-full border-[3px] border-[#1d1b16] bg-[#fffdf5] px-4 py-2 text-base font-semibold text-[#1d1b16] shadow-[2px_3px_0_rgba(0,0,0,0.45)] transition-[translate,background-color] duration-150 hover:-translate-y-0.5 hover:bg-[#fff3c4] data-[hand-hover]:-translate-y-0.5 data-[hand-hover]:bg-[#fff3c4]"
          >
            ← Languages
          </button>

          {/* the flashcard prompt: what to draw */}
          <div
            data-testid="word-card"
            data-lang={card.lang}
            data-word={card.word.id}
            className="pointer-events-none fixed left-1/2 top-5 -translate-x-1/2 rotate-[-1deg] rounded-2xl border-[3px] border-[#1d1b16] bg-[#fffdf5] px-7 pb-2 pt-2.5 text-center text-[#1d1b16] shadow-[4px_5px_0_rgba(0,0,0,0.45)]"
          >
            <div className="font-hand flex items-center justify-center gap-1.5 text-base text-[#1d1b16]/70">
              <Flag code={card.lang} width={21} height={14} />
              Draw this · {languageByCode(card.lang).name}
            </div>
            <div className="font-toon text-[clamp(2rem,5vw,3rem)] font-bold leading-tight">{card.word[card.lang]}</div>
            <div className="font-hand text-lg leading-tight text-[#1d1b16]/55">{card.word.en}</div>
          </div>

          <GestureHints />
        </>
      ) : (
        <StartScreen
          stream={stream}
          modelReady={modelReady}
          busy={starting}
          status={status}
          lang={lastLang}
          onPick={pick}
        />
      )}

      {/* fingertip cursor: everything on the start screen, just the back button while drawing */}
      <HandCursor ref={cursorRef} targetsOnly={!!card} />
    </div>
  );
}
