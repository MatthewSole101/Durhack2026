"use client";

import { useEffect, useRef, useState } from "react";
import { REVEAL_MS, SOLVED_MS, TOAST_MS, PREDICT_CONFIDENCE_THRESH } from "./constants";
import { CORNER_BUTTON } from "./corner-button";
import { createAirDraw, type AirDrawEngine } from "./engine";
import GestureHints from "./GestureHints";
import type { MicState } from "./snap-audio";
import { createDeck, isCorrect } from "@/features/game/deck";
import { DebugPanel, GuessFeed, WordCard, type ClassifierStatus } from "@/features/game/GameHud";
import { loadDoodles, SkipDoodle } from "@/features/game/SkipDoodle";
import HandCursor, { type HandCursorHandle } from "@/features/hand-cursor/HandCursor";
import type { LangCode } from "@/features/languages/languages";
import type { Word } from "@/features/languages/words";
import { INPUT_SIZE } from "@/features/quickdraw/constants";
import { loadQuickDrawModel, type QuickDrawModel } from "@/features/quickdraw/model";
import { createPredictor, type Prediction, type Predictor } from "@/features/quickdraw/predictor";
import { createPreprocessor, type Strokes } from "@/features/quickdraw/preprocess";
import { loadRuntime } from "@/features/quickdraw/runtime";
import StartScreen from "@/features/start-screen/StartScreen";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cameraError = (e: unknown) =>
  `Camera unavailable: ${message(e)} — open this page via http://localhost or https.`;
const NO_PREDICTION: Prediction = { guesses: [], input: null };

type Card = { lang: LangCode; word: Word };

// the buttons in the top corners of the drawing page; data-hand-target makes them pressable by
// holding a fingertip over them (see HandCursor)
const TOP_BUTTON = `${CORNER_BUTTON} fixed top-4 z-10`;

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
  /** Give up on the word: show what it means in English for a moment, then deal the next one. */
  skip: () => void;
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
  const [revealed, setRevealed] = useState(false); // skipped: the card shows the English
  const [classifier, setClassifier] = useState<ClassifierStatus>({ state: "runtime" });
  const [prediction, setPrediction] = useState(NO_PREDICTION);
  const [debug, setDebug] = useState(false);
  const [mic, setMic] = useState<MicState>("off"); // microphone for hearing finger snaps

  useEffect(() => {
    let alive = true;
    let toastTimer: ReturnType<typeof setTimeout>;
    let solvedTimer: ReturnType<typeof setTimeout>;
    const correctSound = new Audio("/sounds/correct.mp3");  
    correctSound.preload = "auto";
    let model: QuickDrawModel | null = null;
    let predictor: Predictor | null = null;
    let current: Word | null = null, won = false; // the word on screen, while on the drawing page
    let skipped = false; // the word was given up on: its English is showing, it can't be won any more

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

    loadDoodles().catch(e => console.error(e)); // ready before the first skip; a skip still works without them

    // ---------------- rounds ----------------
    function nextRound() {
      clearTimeout(solvedTimer);
      engine.reset();
      predictor?.reset(); // a guess for the old drawing must not count for the new word
      const word = current = deal();
      won = false; skipped = false;
      setCard(c => c && { ...c, word });
      setSolved(false); setRevealed(false); setPrediction(NO_PREDICTION);
      if (hook) { hook.prediction = NO_PREDICTION; hook.rounds.push(word.id); }
      return word;
    }

    function leave() {
      clearTimeout(solvedTimer);
      engine.setMode("menu");
      predictor?.reset();
      current = null; won = false; skipped = false;
      setCard(null); setError("");
      setSolved(false); setRevealed(false); setPrediction(NO_PREDICTION);
      if (hook) hook.prediction = NO_PREDICTION;
    }

    // Skipping shows the answer first (its English, and a doodle of it): the learner skipped
    // because they don't know the word.
    // A second skip (or one on a solved word) moves on straight away.
    // The player's own drawing is wiped, so the sample doodles aren't shown over it.
    function skip() {
      if (!current) return;
      if (won || skipped) { nextRound(); return; }
      skipped = true;
      engine.reset();
      predictor?.reset(); // a guess for the wiped drawing must not come in late
      setPrediction(NO_PREDICTION);
      if (hook) hook.prediction = NO_PREDICTION;
      setRevealed(true);
      solvedTimer = setTimeout(nextRound, REVEAL_MS);
    }
    gameRef.current = { nextRound, skip, leave };

    function onPrediction(p: Prediction) {
      if (!current) return; // back on the language list
      setPrediction(p);
      if (hook) hook.prediction = p;
      // won when the word is the top guess (see PREDICT_CONFIDENCE_THRESH for demanding more than that)
      if (!won && !skipped && isCorrect(current, p.guesses[0]?.label) && p.guesses[0].prob >= PREDICT_CONFIDENCE_THRESH) {
        won = true;
        setSolved(true);
        correctSound.currentTime = 0;
        correctSound.play().catch(() => { /* autoplay blocked until the first click or key press */ });
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
          predict: m.predict, // flashcard words only, re-normalised: the one list everything below uses
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
      if (k === "n") skip();
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

      {/* brief gesture feedback ("↩ Undo", "✨ Cleared", "🎨 Red") */}
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
            // keyed: "Next →" is a new button, so a fingertip still resting where it pressed
            // "Skip →" starts a fresh dwell (with its ring) instead of counting as already pressed
            <button
              key={revealed ? "next" : "skip"}
              type="button"
              onClick={() => gameRef.current?.skip()}
              data-hand-target
              className={`${TOP_BUTTON} right-4`}
            >
              {revealed ? "Next →" : "Skip →"}
            </button>
          )}

          {/* the flashcard prompt: what to draw. Skipped: a few Quick Draw doodles of the word under it */}
          <WordCard word={card.word} lang={card.lang} solved={solved} revealed={revealed}>
            {revealed && <SkipDoodle key={card.word.id} word={card.word} />}
          </WordCard>

          <GestureHints mic={mic} />
          {/* live top guesses, in the language being learnt.
              Hidden while a skipped word's doodles are up: the answer is showing, the guesses no longer matter */}
          {!revealed && <GuessFeed guesses={prediction.guesses} lang={card.lang} />}
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
