"use client";

import { useEffect, useRef, useState } from "react";
import { SOLVED_MS, TOAST_MS, PREDICT_CONFIDENCE_THRESH } from "./constants";
import { createAirDraw, type AirDrawEngine } from "./engine";
import GestureHints from "./GestureHints";
import type { MicState } from "./snap-audio";
import { createDeck, isCorrect } from "@/features/game/deck";
import { DebugPanel, GuessFeed, WordCard, type ClassifierStatus } from "@/features/game/GameHud";
import HandCursor, { type HandCursorHandle } from "@/features/hand-cursor/HandCursor";
import type { LangCode } from "@/features/languages/languages";
import { wordForLabel, type Word } from "@/features/languages/words";
import { INPUT_SIZE, TOP_K } from "@/features/quickdraw/constants";
import { loadQuickDrawModel, topK, type QuickDrawModel } from "@/features/quickdraw/model";
import { createPredictor, type Prediction, type Predictor } from "@/features/quickdraw/predictor";
import { createPreprocessor, type Strokes } from "@/features/quickdraw/preprocess";
import { loadRuntime } from "@/features/quickdraw/runtime";
import StartScreen from "@/features/start-screen/StartScreen";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cameraError = (e: unknown) =>
  `Camera unavailable: ${message(e)} — open this page via http://localhost or https.`;
const NO_PREDICTION: Prediction = { guesses: [], wordGuesses: [], input: null };
/** The model knows more classes than there are flashcard words; the player only sees the words. */
const isWord = (label: string) => wordForLabel(label) !== undefined;

type Card = { lang: LangCode; word: Word };

// the buttons in the top corners of the drawing page; data-hand-target makes them pressable by
// holding a fingertip over them (see HandCursor)
const TOP_BUTTON =
  "font-toon fixed top-4 z-10 cursor-pointer rounded-full border-[3px] border-[#1d1b16] bg-[#fffdf5] px-4 py-2 text-base font-semibold text-[#1d1b16] transition-[translate,background-color] duration-150 hover:-translate-y-0.5 hover:bg-[#fff3c4] data-[hand-hover]:-translate-y-0.5 data-[hand-hover]:bg-[#fff3c4]";

// Test builds only (NEXT_PUBLIC_AIR_DRAW_TEST=1): the round can be chosen and the classifier driven directly.
const TEST_BUILD = process.env.NEXT_PUBLIC_AIR_DRAW_TEST === "1";
export type QuickDrawTestHook = {
  status: ClassifierStatus;
  prediction: Prediction;
  /** ids of the words dealt so far */
  rounds: string[];
  toInput: (strokes: Strokes) => number[] | null;
  probabilities: (input: number[]) => Promise<number[]>;
  /** Load a second model, run it once and dispose it — what a mount / unmount does. */
  loadAndDispose: () => Promise<void>;
  /** Size of the wasm heap; it only ever grows, so a leak shows up here. */
  heapBytes: () => Promise<number>;
};
type TestWindow = Window & {
  /** Words to deal, in this order, instead of the shuffled deck. */
  __gameDeck?: Word[];
  __quickDraw?: QuickDrawTestHook;
};

type Game = {
  /** Clear the canvas and deal the next word. */
  nextRound: () => Word;
  /** Back to the language list. */
  leave: () => void;
};

export default function AirDraw() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AirDrawEngine | null>(null);
  const cursorRef = useRef<HandCursorHandle>(null);
  const gameRef = useRef<Game | null>(null);

  const [modelReady, setModelReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState(""); // start-screen error line
  const [error, setError] = useState(""); // red banner while drawing
  const [toast, setToast] = useState({ msg: "", show: false });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [lastLang, setLastLang] = useState<LangCode | null>(null);
  const [card, setCard] = useState<Card | null>(null); // set = on the drawing page

  const [solved, setSolved] = useState(false);
  const [classifier, setClassifier] = useState<ClassifierStatus>({ state: "runtime" });
  const [prediction, setPrediction] = useState(NO_PREDICTION);
  const [debug, setDebug] = useState(false);
  const [mic, setMic] = useState<MicState>("off"); // microphone for hearing finger snaps

  useEffect(() => {
    let alive = true;
    let toastTimer: ReturnType<typeof setTimeout>;
    let solvedTimer: ReturnType<typeof setTimeout>;
    let model: QuickDrawModel | null = null;
    let predictor: Predictor | null = null;
    let current: Word | null = null, won = false; // the word on screen, while on the drawing page

    const testWindow = TEST_BUILD ? (window as TestWindow) : null;
    const deck = testWindow?.__gameDeck;
    const deal = createDeck(deck, !deck);
    const preprocessor = createPreprocessor();

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
      onStrokes: state => (state === "drawing" ? predictor?.drawing() : predictor?.settled()),
      onMic: state => { if (alive) setMic(state); },
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

    // ---------------- rounds ----------------
    function nextRound() {
      clearTimeout(solvedTimer);
      engine.reset();
      predictor?.reset(); // a guess for the old drawing must not count for the new word
      const word = current = deal();
      won = false;
      setCard(c => c && { ...c, word });
      setSolved(false); setPrediction(NO_PREDICTION);
      if (hook) { hook.prediction = NO_PREDICTION; hook.rounds.push(word.id); }
      return word;
    }

    function leave() {
      clearTimeout(solvedTimer);
      engine.setMode("menu");
      predictor?.reset();
      current = null; won = false;
      setCard(null); setError("");
      setSolved(false); setPrediction(NO_PREDICTION);
      if (hook) hook.prediction = NO_PREDICTION;
    }
    gameRef.current = { nextRound, leave };

    function onPrediction(p: Prediction) {
      if (!current) return; // back on the language list
      setPrediction(p);
      if (hook) hook.prediction = p;
      if (!won && isCorrect(current, p.guesses[0]?.label) && p.guesses[0]?.prob > PREDICT_CONFIDENCE_THRESH) {
        won = true;
        setSolved(true);
        solvedTimer = setTimeout(nextRound, SOLVED_MS);
      }
    }

    function report(s: ClassifierStatus) {
      if (hook) hook.status = s;
      if (!alive) return;
      setClassifier(s);
      if (s.state === "error") setError("Doodle recognition unavailable: " + s.message);
    }

    const hook: QuickDrawTestHook | undefined = testWindow ? (testWindow.__quickDraw = {
      status: { state: "runtime" },
      prediction: NO_PREDICTION,
      rounds: [],
      toInput: strokes => { const input = preprocessor.toInput(strokes); return input && Array.from(input); },
      probabilities: async input => Array.from(await model!.probabilities(Float32Array.from(input))),
      loadAndDispose: async () => {
        const m = await loadQuickDrawModel();
        await m.probabilities(new Float32Array(INPUT_SIZE * INPUT_SIZE));
        m.dispose();
      },
      heapBytes: async () => {
        const liteRt = (await loadRuntime()).getGlobalLiteRt() as unknown as { liteRtWasm: { HEAPU8: Uint8Array } };
        return liteRt.liteRtWasm.HEAPU8.length;
      },
    }) : undefined;

    // Load the classifier now, alongside the hand tracker (which runs in its own worker), so its
    // main-thread compile happens under "Loading hand tracking…" rather than while the player is
    // already pointing at a language. Main-thread wasm loads are serialised by withWasmLoadLock.
    loadQuickDrawModel(stage => report({ state: stage })).then(
      m => {
        if (!alive) { m.dispose(); return; }
        model = m;
        predictor = createPredictor({
          getStrokes: engine.getStrokes,
          toInput: preprocessor.toInput,
          predict: async input => {
            const probs = await m.probabilities(input);
            return { guesses: topK(probs, m.labels), wordGuesses: topK(probs, m.labels, TOP_K, isWord) };
          },
          onPrediction,
          onError: e => { console.error(e); report({ state: "error", message: message(e) }); },
        });
        report({ state: "ready", name: m.name, inputShape: m.inputShape, dtype: m.dtype, labelSource: m.labelSource });
        predictor.settled(); // judge anything drawn while the model was loading
      },
      e => { console.error(e); report({ state: "error", message: message(e) }); },
    );

    function onKey(e: KeyboardEvent) {
      if (!current || e.metaKey || e.ctrlKey || e.altKey) return; // drawing page only
      const k = e.key.toLowerCase();
      if (k === "escape") leave(); // Esc → back to the language list
      if (k === "d") setDebug(d => !d);
      if (k === "n") nextRound();
    }
    window.addEventListener("keydown", onKey);

    return () => {
      alive = false;
      clearTimeout(toastTimer);
      clearTimeout(solvedTimer);
      window.removeEventListener("keydown", onKey);
      predictor?.stop();
      model?.dispose(); // frees the compiled model's wasm memory
      engine.destroy();
      engineRef.current = null;
      gameRef.current = null;
    };
  }, []);

  async function pick(lang: LangCode) {
    const engine = engineRef.current, game = gameRef.current;
    if (!engine || !game || card || starting) return;
    setLastLang(lang);
    setStarting(true);
    try {
      setStream(await engine.start()); // no-op if the camera is already on; retries if it failed
      setStatus("");
      engine.setMode("draw");
      setCard({ lang, word: game.nextRound() }); // only once the video is actually playing
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
            onClick={() => gameRef.current?.leave()}
            data-hand-target
            aria-label="Back to languages"
            className={`${TOP_BUTTON} left-4`}
          >
            ← Languages
          </button>
          {!solved && (
            <button
              type="button"
              onClick={() => gameRef.current?.nextRound()}
              data-hand-target
              className={`${TOP_BUTTON} right-4`}
            >
              Skip →
            </button>
          )}

          {/* the flashcard prompt: what to draw */}
          <WordCard word={card.word} lang={card.lang} solved={solved} />

          <GestureHints mic={mic} />
          {/* live top guesses among the flashcard words, translated into the language being learnt (render-time lookup) */}
          <GuessFeed guesses={prediction.wordGuesses} lang={card.lang} />
          {debug && <DebugPanel status={classifier} prediction={prediction} />}
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
