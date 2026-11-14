"use client";

// Gesture cheat-sheet for the drawing page. Open when the page opens, tucks itself away into a
// small "How to draw" pill after HINTS_OPEN_MS; click the pill (or press H) to bring it back.

import { useEffect, useState, type ReactNode } from "react";
import { HINTS_OPEN_MS } from "./constants";

// tiny line-art icons for the two-hand shapes
const ShapeIcon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

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
        <div className="w-[290px] rotate-[-1deg] rounded-xl border-[3px] border-[#1d1b16] bg-[#fffdf5] p-3 shadow-[4px_5px_0_rgba(0,0,0,0.45)]">
          <div className="mb-1 flex items-center justify-between">
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
          <ul className="flex flex-col gap-1">
            <Hint icon="☝️" title="Draw">point your index finger, other fingers curled</Hint>
            <Hint icon="🤏" title="Undo">pinch twice quickly</Hint>
            <Hint icon="👋" title="Clear">flick an open hand across</Hint>
            <Hint icon="✋" title="Colour">hold an open palm still, tilt to choose, fist to pick</Hint>
          </ul>
          <div className="font-toon mb-0.5 mt-2 text-[11px] font-semibold uppercase tracking-wider text-[#1d1b16]/50">
            Two hands · pull apart to stretch, let go to place
          </div>
          <ul className="flex flex-col gap-1">
            <Hint icon={<ShapeIcon d="M4 19L20 5" />} title="Line">pinch with both hands</Hint>
            <Hint icon={<ShapeIcon d="M4 5h16v14H4z" />} title="Rectangle">an L with each hand; fingertips are the corners</Hint>
            <Hint icon={<ShapeIcon d="M12 4l9 16H3z" />} title="Triangle">touch index tips and thumb tips together</Hint>
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

function Hint({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-[1rem] leading-tight">
      <span className="flex w-6 shrink-0 justify-center text-xl leading-none" aria-hidden>{icon}</span>
      <span><b className="font-toon text-[13px]">{title}</b> · {children}</span>
    </li>
  );
}
