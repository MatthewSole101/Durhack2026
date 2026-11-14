"use client";

import { useEffect, useRef, useState } from "react";
import { TOAST_MS } from "./constants";
import { createAirDraw, type AirDrawEngine } from "./engine";
import HandCursor, { type HandCursorHandle } from "@/features/hand-cursor/HandCursor";
import { Flag } from "@/features/languages/Flag";
import { DEFAULT_LANG, type LangCode, languageByCode } from "@/features/languages/languages";
import { randomWord, type Word } from "@/features/languages/words";
import GestureHints from "./GestureHints";
import StartScreen from "@/features/start-screen/StartScreen";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cameraError = (e: unknown) =>
  `Camera unavailable: ${message(e)} — open this page via http://localhost or https.`;

export default function AirDraw() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AirDrawEngine | null>(null);
  const cursorRef = useRef<HandCursorHandle>(null);

  const [modelReady, setModelReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState(""); // start-screen error line
  const [error, setError] = useState(""); // red banner while drawing
  const [toast, setToast] = useState({ msg: "", show: false });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [lang, setLang] = useState<LangCode>(DEFAULT_LANG);
  const [word, setWord] = useState<Word | null>(null); // picked when drawing starts

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
      onPointer: p => cursorRef.current?.update(p), // start screen only (engine is in "menu" mode)
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

  async function start() {
    const engine = engineRef.current;
    if (!engine || started) return;
    setStarting(true);
    try {
      setStream(await engine.start()); // no-op if the camera is already on; retries if it failed
      setStatus("");
      setWord(randomWord());
      engine.setMode("draw");
      setStarted(true); // only once the video is actually playing
    } catch (e) {
      setStatus(cameraError(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-black font-sans text-sm text-[#f2f4f8]">
      {/* Frame source. Not display:none — some browsers stop decoding hidden video. */}
      <video ref={videoRef} playsInline muted className="pointer-events-none fixed left-0 top-0 h-[2px] w-[2px] opacity-0" />
      <canvas ref={canvasRef} className="fixed inset-0 block h-screen w-screen" />

      {/* brief gesture feedback ("↩ Undo", "✨ Cleared") */}
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

      {started && word && (
        <>
          {/* the flashcard prompt: what to draw */}
          <div
            data-testid="word-card"
            data-lang={lang}
            data-word={word.id}
            className="pointer-events-none fixed left-1/2 top-5 -translate-x-1/2 rotate-[-1deg] rounded-2xl border-[3px] border-[#1d1b16] bg-[#fffdf5] px-7 pb-2 pt-2.5 text-center text-[#1d1b16] shadow-[4px_5px_0_rgba(0,0,0,0.45)]"
          >
            <div className="font-hand flex items-center justify-center gap-1.5 text-base text-[#1d1b16]/70">
              <Flag code={lang} width={21} height={14} />
              Draw this · {languageByCode(lang).name}
            </div>
            <div className="font-toon text-[clamp(2rem,5vw,3rem)] font-bold leading-tight">{word[lang]}</div>
            <div className="font-hand text-lg leading-tight text-[#1d1b16]/55">{word.en}</div>
          </div>
          <GestureHints />
        </>
      )}

      {!started && (
        <>
          <StartScreen
            stream={stream}
            modelReady={modelReady}
            starting={starting}
            status={status}
            lang={lang}
            onLangChange={setLang}
            onStart={start}
          />
          <HandCursor ref={cursorRef} />
        </>
      )}
    </div>
  );
}
