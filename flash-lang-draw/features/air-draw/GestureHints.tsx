"use client";

// Gesture cheat-sheet for the drawing page. Open when the page opens, tucks itself away into a
// small "How to draw" pill after HINTS_OPEN_MS; click the pill (or press H) to bring it back.

import { useEffect, useState, type ReactNode } from "react";
import { HINTS_OPEN_MS } from "./constants";
import type { MicState } from "./snap-audio";

// how snaps are being detected right now (shown under the cheat-sheet, and next to the pill)
const MIC_NOTE: Record<MicState, string | null> = {
  on: null,
  starting: null,
  click: "🎤 Click anywhere once so snaps can be heard",
  off: "🎤 Microphone off: snaps are judged by sight only",
};

// tiny line-art icons for the two-hand shapes
const ShapeIcon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

export default function GestureHints({ mic = "off" }: { mic?: MicState }) {
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
    <div data-testid="gesture-hints" data-open={open} className="font-hand fixed bottom-5 right-5 z-10 flex flex-col items-end gap-2 text-[#1d1b16]">
      {MIC_NOTE[mic] && (
        <div data-testid="mic-note" className="font-toon max-w-[290px] rounded-lg border-2 border-[#1d1b16] bg-[#fff3c4] px-2.5 py-1 text-xs font-semibold shadow-[2px_3px_0_rgba(0,0,0,0.45)]">
          {MIC_NOTE[mic]}
        </div>
      )}
      {open ? (
        <div className="w-[290px] rotate-[-1deg] rounded-xl border-[3px] border-[#1d1b16] bg-[#fffdf5] p-3 shadow-[4px_5px_0_rgba(0,0,0,0.45)]">
          <div className="mb-1 flex items-center justify-between">
            <b className="font-toon text-sm">How to draw</b>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Hide hints"
              data-hand-target
              className="font-toon -mr-1 cursor-pointer rounded-md px-2 py-1 text-base leading-none text-[#1d1b16]/60 hover:bg-[#1d1b16]/10 data-[hand-hover]:bg-[#1d1b16]/10"
            >
              ×
            </button>
          </div>
          <ul className="flex flex-col gap-1">
            <Hint icon="🤏" title="Draw">pinch thumb and index together, then move</Hint>
            <Hint icon="👈" title="Undo">fist, thumb pointing left</Hint>
            <Hint icon="👉" title="Redo">fist, thumb pointing right</Hint>
            <Hint icon="🫰" title="Clear">snap your fingers</Hint>
            <Hint icon="✋" title="Colour">hold an open palm still, tilt to choose, fist to pick</Hint>
          </ul>
          <div className="font-toon mb-0.5 mt-2 text-[11px] font-semibold uppercase tracking-wider text-[#1d1b16]/50">
            Two hands · move to place, pull apart to grow, let go to drop
          </div>
          <ul className="flex flex-col gap-1">
            <Hint icon={<ShapeIcon d="M4 19L20 5" />} title="Line">pinch with both hands at once</Hint>
            <Hint icon={<ShapeIcon d="M4 5h16v14H4z" />} title="Rectangle">an L with each hand; the L corners are opposite corners</Hint>
            <Hint icon={<ShapeIcon d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z" />} title="Circle">make an O with both hands (index tips and thumb tips touching), pull apart, close hands to drop</Hint>
          </ul>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-hand-target
          className="font-toon cursor-pointer rounded-full border-2 border-[#1d1b16] bg-[#fffdf5] px-3 py-1 text-base font-semibold transition-[translate,background-color] duration-150 hover:-translate-y-0.5 hover:bg-[#fff3c4] data-[hand-hover]:-translate-y-0.5 data-[hand-hover]:bg-[#fff3c4]"
        >
          How to draw ?
        </button>
      )}
    </div>
  );
}

function Hint({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[1rem] leading-tight">
      <span className="flex w-6 shrink-0 justify-center text-xl leading-none" aria-hidden>{icon}</span>
      <span><b className="font-toon text-[13px]">{title}</b> · {children}</span>
    </li>
  );
}
