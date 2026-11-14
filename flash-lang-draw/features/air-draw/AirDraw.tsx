"use client";

import { useEffect, useRef, useState } from "react";
import { TOAST_MS } from "./constants";
import { createAirDraw, type AirDrawEngine } from "./engine";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function AirDraw() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AirDrawEngine | null>(null);

  const [modelReady, setModelReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState(""); // start-screen error line
  const [error, setError] = useState(""); // red banner while drawing
  const [toast, setToast] = useState({ msg: "", show: false });

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
    });
    engineRef.current = engine;
    engine.load().then(
      () => { if (alive) setModelReady(true); },
      e => { if (alive) setStatus("Failed to load model: " + message(e)); },
    );
    return () => {
      alive = false;
      clearTimeout(toastTimer);
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  async function start() {
    setStarting(true);
    try {
      await engineRef.current?.start();
      setStarted(true); // only once the video is actually playing
    } catch (e) {
      setStatus(`Camera unavailable: ${message(e)} — open this page via http://localhost or https.`);
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
        className={`pointer-events-none fixed left-1/2 top-7 -translate-x-1/2 rounded-full border border-[#4fd1c5]/50 bg-[#0f1115]/60 px-4 py-2 font-semibold tracking-wide backdrop-blur-md transition duration-200 ${
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

      {!started && (
        <div
          data-testid="start-screen"
          className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(ellipse_at_center,#1a1f2b_0%,#000_70%)] p-6 text-center"
        >
          <h1 className="text-[26px] font-bold">Air Draw</h1>
          <ul className="grid max-w-[440px] gap-2 text-left text-[#a9b1c4] [&_b]:text-[#f2f4f8]">
            <li>☝️ <b>Draw:</b> point your index finger with your thumb and other fingers curled in. Open or relax the hand to lift the pen.</li>
            <li>🤏🤏 <b>Undo:</b> pinch thumb and index together twice quickly.</li>
            <li>👋 <b>Clear:</b> flick an open hand quickly across the screen.</li>
          </ul>
          <button
            type="button"
            onClick={start}
            disabled={!modelReady || starting}
            className="cursor-pointer rounded-[10px] bg-[#4fd1c5] px-[22px] py-3 text-base font-semibold text-[#06201d] disabled:cursor-default disabled:opacity-50"
          >
            {modelReady ? "Start camera" : "Loading model…"}
          </button>
          <div role="status" className="min-h-5 text-[#f6ad55]">{status}</div>
        </div>
      )}
    </div>
  );
}
