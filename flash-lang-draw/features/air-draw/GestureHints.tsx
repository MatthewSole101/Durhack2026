"use client";

// Gesture cheat-sheet for the drawing page. Open when the page opens, tucks itself away into a
// small "How to draw" pill after HINTS_OPEN_MS; click the pill (or press H) to bring it back.

import { useEffect, useState, type ReactNode } from "react";
import { HINTS_OPEN_MS } from "./constants";

export default function GestureHints() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setOpen(false), HINTS_OPEN_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "h") { clearTimeout(timer); setOpen(o => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(timer); window.removeEventListener("keydown", onKey); };
  }, []);

  return (
    <div data-testid="gesture-hints" data-open={open} className="font-hand fixed bottom-5 right-5 z-10 text-[#1d1b16]">
      {open ? (
        <div className="w-[250px] rotate-[-1deg] rounded-xl border-[3px] border-[#1d1b16] bg-[#fffdf5] p-3 shadow-[4px_5px_0_rgba(0,0,0,0.45)]">
          <div className="mb-1.5 flex items-center justify-between">
            <b className="font-toon text-sm">How to draw</b>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Hide hints"
              className="font-toon -mr-1 cursor-pointer rounded-md px-1.5 text-base leading-none text-[#1d1b16]/60 hover:bg-[#1d1b16]/10"
            >
              ×
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            <Hint emoji="☝️" title="Draw">point your index finger, other fingers curled</Hint>
            <Hint emoji="🤏" title="Undo">pinch twice quickly</Hint>
            <Hint emoji="👋" title="Clear">flick an open hand across</Hint>
          </ul>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-toon cursor-pointer rounded-full border-2 border-[#1d1b16] bg-[#fffdf5] px-3 py-1 text-sm font-semibold shadow-[2px_3px_0_rgba(0,0,0,0.45)] hover:-translate-y-0.5"
        >
          ? How to draw
        </button>
      )}
    </div>
  );
}

function Hint({ emoji, title, children }: { emoji: string; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[1.02rem] leading-tight">
      <span className="w-6 text-xl leading-none" aria-hidden>{emoji}</span>
      <span><b className="font-toon text-[13px]">{title}</b> · {children}</span>
    </li>
  );
}
