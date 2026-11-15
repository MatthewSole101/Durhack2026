"use client";

// In-game overlay: the flashcard with the word to draw (top) and an optional debug panel
// showing what the classifier sees and guesses.

import { useEffect, useRef } from "react";
import { INPUT_SIZE } from "@/features/quickdraw/constants";
import type { LabelSource } from "@/features/quickdraw/labels";
import type { Prediction } from "@/features/quickdraw/predictor";
import type { LangCode } from "@/features/languages/languages";
import { labelIn } from "@/features/languages/label-words";
import { wordForLabel, type Word } from "@/features/languages/words";

export type ClassifierStatus =
  | { state: "runtime" | "compiling" }
  | { state: "ready"; name: string; inputShape: number[]; dtype: string; labelSource: LabelSource }
  | { state: "error"; message: string };

/** The flashcard prompt: what to draw, in the language being learnt (and only in that language). */
export function WordCard({ word, lang, solved }: { word: Word; lang: LangCode; solved: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-5 flex flex-col items-center gap-1.5">
      <div
        data-testid="word-card"
        data-lang={lang}
        data-word={word.id}
        data-solved={solved}
        role="status"
        className={`rotate-[-1deg] rounded-2xl border-[3px] border-[#1d1b16] px-7 py-2.5 text-center text-[#1d1b16] transition-colors duration-200 ${
          solved ? "bg-[#b9efb0]" : "bg-[#fffdf5]"
        }`}
      >
        <div className="font-toon text-[clamp(2rem,5vw,3rem)] font-bold leading-tight">
          {solved && <span aria-hidden>✓ </span>}
          <span lang={lang} data-testid="word">{word.text[lang]}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Live feed of the classifier's top guesses, in the language being learnt (every Quick Draw
 * class has an entry in label-words.ts). Translation happens here, at render time, from the raw
 * predicted labels, so switching language re-renders the feed without re-running inference.
 */
export function GuessFeed({ guesses, lang }: { guesses: Prediction["guesses"]; lang: LangCode }) {
  return (
    <aside
      data-testid="guess-feed"
      data-lang={lang}
      className="fixed bottom-5 left-4 w-60 rounded-xl border border-white/15 bg-[#0f1115]/75 p-3 backdrop-blur-md"
    >
      <h2 className="font-toon mb-2 text-center text-xl font-semibold text-white/90">You drew…</h2>
      {guesses.length === 0 ? (
        <p data-testid="guess-feed-empty" className="font-hand text-base text-white/45">
          Draw something…
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {guesses.map((g, i) => {
            const translated = labelIn(g.label, lang) ?? wordForLabel(g.label)?.text[lang] ?? g.label;
            return (
              <li
                key={g.label}
                data-testid="guess-feed-item"
                data-rank={i + 1}
                data-label={g.label}
                className={
                  i === 0
                    ? "-mx-1 rounded-lg bg-[#4fd1c5]/15 px-2 py-1"
                    : "px-2 py-0.5"
                }
              >
                <span
                  lang={lang}
                  className={
                    i === 0
                      ? "font-toon block text-lg leading-tight font-semibold text-[#4fd1c5]"
                      : "font-hand block truncate text-base leading-tight text-white/75"
                  }
                >
                  {i === 0 ? "★ " : `${i + 1}. `}
                  {translated}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

function statusLine(s: ClassifierStatus) {
  switch (s.state) {
    case "runtime": return "Loading runtime…";
    case "compiling": return "Compiling model…";
    case "ready": return `Ready — ${s.name} · [${s.inputShape.join(", ")}] ${s.dtype} · labels: ${s.labelSource}`;
    case "error": return s.message;
  }
}

const PREVIEW_SCALE = 4;

export function DebugPanel({ status, prediction }: { status: ClassifierStatus; prediction: Prediction }) {
  const previewRef = useRef<HTMLCanvasElement>(null);
  const { guesses, input } = prediction;

  // the real 28×28 model input, upscaled by CSS with image-rendering: pixelated
  useEffect(() => {
    const ctx = previewRef.current?.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(INPUT_SIZE, INPUT_SIZE);
    for (let i = 0; i < INPUT_SIZE * INPUT_SIZE; i++) {
      const v = Math.round((input?.[i] ?? 0) * 255);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [input]);

  return (
    <aside
      data-testid="quickdraw-debug"
      className="fixed left-4 top-20 w-72 rounded-xl border border-white/15 bg-[#0f1115]/75 p-3 text-xs text-[#f2f4f8] backdrop-blur-md"
    >
      <p data-testid="quickdraw-status" data-state={status.state} className={status.state === "error" ? "text-[#ff9b8f]" : "text-white/70"}>
        {statusLine(status)}
      </p>
      <div className="mt-2 flex gap-3">
        <figure className="shrink-0">
          <canvas
            ref={previewRef}
            width={INPUT_SIZE}
            height={INPUT_SIZE}
            data-testid="quickdraw-preview"
            className="rounded border border-white/20 [image-rendering:pixelated]"
            style={{ width: INPUT_SIZE * PREVIEW_SCALE, height: INPUT_SIZE * PREVIEW_SCALE }}
          />
          <figcaption className="mt-1 text-[10px] text-white/55">What the model sees</figcaption>
        </figure>
        <ol data-testid="quickdraw-guesses" className="min-w-0 flex-1 space-y-1">
          {guesses.length === 0 && <li className="text-white/45">Draw something…</li>}
          {guesses.map((g, i) => (
            <li key={g.label} className={i === 0 ? "font-semibold text-white" : "text-white/75"}>
              <div className="flex justify-between gap-2">
                <span className="truncate">{i + 1}. {g.label}</span>
                <span className="tabular-nums">{(g.prob * 100).toFixed(1)}%</span>
              </div>
              <div className="mt-0.5 h-1 rounded-full bg-white/10">
                <div className={`h-full rounded-full ${i === 0 ? "bg-[#4fd1c5]" : "bg-white/40"}`} style={{ width: `${g.prob * 100}%` }} />
              </div>
            </li>
          ))}
        </ol>
      </div>
      <p className="mt-2 text-[10px] text-white/45">D hides this panel · N skips the word</p>
    </aside>
  );
}
